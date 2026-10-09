#!/usr/bin/env bash
# shellcheck disable=SC2016  # single-quoted commands are meant to expand on the remote (test) VPS
# TEST ONLY, on the Mac with Docker or OrbStack: rehearses the whole VPS kit in Ubuntu 24.04 containers and writes the
# outputs to vps/evidence/ (local paths replaced by <repo>, <scratch>, ~). Nothing live is sent; no real key, CRE
# session or launchd job is touched (the Mac side of cutover/rollback runs against a launchctl stub and a scratch HOME).
#
#   vps/test/run-container-tests.sh all
#   vps/test/run-container-tests.sh <step> [<step> ...]
#     image   build the test image (Dockerfile: Ubuntu 24.04 + systemd + sshd + a non-root user)
#     up      start it as a stand-in VPS (systemd PID 1, ssh on 127.0.0.1:22422, throwaway ssh key)
#     push    vps/push.sh to it (the first push uses the tar fallback: no rsync there yet)
#     setup   vps/setup.sh --with-anvil over ssh (arm64: native)
#     lint    shellcheck (new scripts clean; shared scripts: findings before vs after), systemd-analyze verify/calendar
#     live    live read-only checks (vps/test/live-readonly.sh); waits while the minute is :03-:08 UTC
#     login   `cre login` on the VPS behind ssh -L 53682:127.0.0.1:53682; the callback is reached from the Mac
#     memory  `cre workflow build` under 1 GB / 768 MB / 512 MB container memory caps
#     fork    vps/test/e2e-systemd-fork.sh (the installed systemd unit against an anvil fork)
#     tripwire vps/test/tripwire-unit.sh (the tripwire against official-path log lines, on a local anvil chain)
#     mac     vps/test/mac-cutover-rehearsal.sh (cutover.sh / rollback.sh from this Mac, stubbed launchd)
#     macpre  run-official.sh --preflight-only on macOS with a throwaway key and a scratch HOME (the macOS stat branch)
#     amd64   vps/setup.sh --no-units in a plain linux/amd64 Ubuntu 24.04 container (emulated on Apple silicon)
#     down    remove the containers
# Env: ISOTHERM_TEST_SCRATCH (default ~/.cache/isotherm-vps-test), ISOTHERM_FORK_URL (anvil fork source).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/../.." && pwd)"; REPO=$(cd "$PKG/../.." && pwd)
EV="$PKG/vps/evidence"; mkdir -p "$EV"
SC=${ISOTHERM_TEST_SCRATCH:-$HOME/.cache/isotherm-vps-test}; mkdir -p "$SC"; SC=$(cd "$SC" && pwd -P)
IMG=isotherm-vps-test:24.04; CT=iso-vps; CT64=iso-vps-amd64; SSHPORT=22422; CFG="$SC/ssh_config"
san() { sed -e "s#$REPO#<repo>#g" -e "s#$SC#<scratch>#g" -e "s#/private<scratch>#<scratch>#g" -e "s#$HOME#~#g"; }
save() { san >"$EV/$1"; echo "  -> vps/evidence/$1 ($(grep -cE '^\s*PASS' "$EV/$1") PASS, $(grep -cE '^\s*FAIL' "$EV/$1") FAIL lines)"; }
R() { ssh -F "$CFG" -o BatchMode=yes isotherm-test "$@"; }
hdr() { echo "# $(date -u +%FT%TZ) $*"; }
clear_of_05() { while m=$((10#$(date -u +%M))); [ "$m" -ge 3 ] && [ "$m" -le 8 ]; do echo "  (waiting: the live hourly job runs at :05)" >&2; sleep 30; done; }
EXCL=(--exclude './var' --exclude './.tools' --exclude 'node_modules' --exclude './evidence' --exclude './vps/evidence'
      --exclude '*.wasm' --exclude './settle/config.anvil-replay.json' --exclude './settle/.cre_build_tmp.js'
      --exclude '*.key' --exclude '.env' --exclude '.env.*' --exclude '.DS_Store')

step_image() { docker build -q -t "$IMG" "$PKG/vps/test" && docker image inspect "$IMG" --format 'image {{.Id}} {{.Architecture}}'; }
step_up() {
  docker rm -f "$CT" >/dev/null 2>&1
  rm -f "$SC/id_test" "$SC/id_test.pub" "$SC/known_hosts"; ssh-keygen -q -t ed25519 -N '' -C isotherm-vps-test -f "$SC/id_test"
  docker run -d --name "$CT" --hostname isotherm-vps --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -p "127.0.0.1:$SSHPORT:22" "$IMG" >/dev/null
  for _ in $(seq 1 30); do docker exec "$CT" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
  docker cp "$SC/id_test.pub" "$CT:/home/isotherm/.ssh/authorized_keys"
  docker exec "$CT" sh -c 'chown isotherm: /home/isotherm/.ssh/authorized_keys && chmod 600 /home/isotherm/.ssh/authorized_keys'
  cat >"$CFG" <<EOF
Host isotherm-test
  HostName 127.0.0.1
  Port $SSHPORT
  User isotherm
  IdentityFile $SC/id_test
  IdentitiesOnly yes
  UserKnownHostsFile $SC/known_hosts
  StrictHostKeyChecking accept-new
Host isotherm-unreachable
  HostName 127.0.0.1
  Port 1
  User isotherm
  IdentityFile $SC/id_test
  IdentitiesOnly yes
  UserKnownHostsFile $SC/known_hosts
  ConnectTimeout 3
EOF
  R 'echo "stand-in VPS up: $(. /etc/os-release; echo $PRETTY_NAME) $(uname -m), systemd $(systemctl is-system-running), user $(id -un), XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR, user manager $(systemctl --user is-system-running)"'
}
step_push() {
  { hdr "vps/push.sh to a fresh stand-in VPS (no rsync there yet: the tar fallback; later pushes use rsync, see setup-arm64.txt)"
    (cd "$REPO" && ISOTHERM_VPS_SSH_OPTS="-F $CFG" bash packages/cre-workflow/vps/push.sh isotherm-test --force 2>&1)
    echo "## what arrived (directories to depth 4, size) and a search for files that must never be shipped"
    R 'cd isotherm && cat SOURCE && find . -maxdepth 4 -type d | sort && du -sh . | cut -f1 && echo "forbidden files: $(find . \( -name "*.key" -o -name ".env*" -o -name "*.wasm" -o -name node_modules -o -name .tools -o -name var \) | wc -l)"'
  } 2>&1 | save push.txt
}
step_setup() {
  { hdr "vps/setup.sh --with-anvil on the stand-in VPS (Ubuntu 24.04 arm64, systemd)"; R 'time bash isotherm/packages/cre-workflow/vps/setup.sh --with-anvil' 2>&1; echo "exit $?"
    echo "## a second vps/push.sh now finds rsync on the VPS"; (cd "$REPO" && ISOTHERM_VPS_SSH_OPTS="-F $CFG" bash packages/cre-workflow/vps/push.sh isotherm-test --force 2>&1)
  } 2>&1 | grep -v 'debconf: delaying' | save setup-arm64.txt
}
step_lint() {
  local f
  for f in scripts/settle-job.sh scripts/run-official.sh scripts/lib-don.sh scripts/don-rollback.sh setup.sh; do
    git -C "$REPO" show "HEAD:packages/cre-workflow/$f" | R "mkdir -p /tmp/head/$(dirname "$f") && cat > /tmp/head/$f"
  done
  { hdr "shellcheck $(R 'shellcheck --version | sed -n 2p') and systemd unit checks on the stand-in VPS"
    R 'bash -s' <<'EOS'
cd isotherm/packages/cre-workflow
echo "## new scripts (vps/, vps/test/, setup.sh): shellcheck -x, all severities"
shellcheck -x -P SCRIPTDIR vps/*.sh vps/test/*.sh setup.sh && echo "clean (0 findings)"
echo; echo "## changed shared scripts: findings at HEAD vs now (code: count), all severities"
for f in scripts/settle-job.sh scripts/run-official.sh scripts/lib-don.sh scripts/don-rollback.sh; do
  a=$(cd /tmp/head && shellcheck -x -P SCRIPTDIR -f gcc "$f" 2>/dev/null | grep -oE 'SC[0-9]+' | sort | uniq -c | awk '{print $2":"$1}' | tr '\n' ' ')
  b=$(shellcheck -x -P SCRIPTDIR -f gcc "$f" 2>/dev/null | grep -oE 'SC[0-9]+' | sort | uniq -c | awk '{print $2":"$1}' | tr '\n' ' ')
  echo "$f  HEAD: ${a:-none}  now: ${b:-none}"
done
echo; echo "## systemd-analyze --user verify of the installed units"
systemd-analyze --user verify ~/.config/systemd/user/isotherm-settle.service ~/.config/systemd/user/isotherm-settle.timer && echo "verify OK"
echo; echo "## the timer's schedule"
systemd-analyze calendar --iterations=3 '*-*-* *:05:00 UTC' | sed -n '1,8p'
echo; echo "## rendered units"; cat ~/.config/systemd/user/isotherm-settle.service ~/.config/systemd/user/isotherm-settle.timer
EOS
  } 2>&1 | save lint.txt
}
step_live() { clear_of_05; R 'bash isotherm/packages/cre-workflow/vps/test/live-readonly.sh' 2>&1 | save live-readonly.txt; }
step_login() {
  { hdr "cre login through an ssh tunnel: the CLI on the stand-in VPS, the callback reached from this Mac (no real sign-in)"
    if lsof -nP -iTCP:53682 -sTCP:LISTEN >/dev/null 2>&1; then echo "port 53682 busy on this Mac; skipped"; return; fi
    ( ssh -F "$CFG" -o ExitOnForwardFailure=yes -L 53682:127.0.0.1:53682 isotherm-test \
        'export PATH=$HOME/isotherm/packages/cre-workflow/.tools/bin:$PATH; (sleep 6; echo "--- on the VPS while cre login waits:"; ss -ltnp | grep 53682) & timeout 25 script -qec "cre login" /dev/null; echo "--- cre login exited $? (timeout 25 s)"' >"$SC/login-raw.txt" 2>&1 & )
    sleep 9
    echo "from the Mac: GET http://localhost:53682/ -> HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:53682/) (the CLI's listener answers through the tunnel)"
    echo "from the Mac: GET http://localhost:53682/callback without code/state -> HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:53682/callback) (the CLI's callback handler rejects it; a real browser redirect lands here)"
    sleep 18
    echo "--- the CLI's output on the VPS (terminal control codes stripped; one-time OAuth parameters redacted):"
    sed -E -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' -e 's/\x1b\][^\\]*\\//g' -e 's/([?&](state|code_challenge|client_id)=)[^& ]+/\1<redacted>/g' "$SC/login-raw.txt" | grep -v '^\s*$'
  } 2>&1 | save login-tunnel.txt
}
step_memory() {
  { hdr "cre workflow build (the compile step that cre workflow simulate also runs first) under container memory caps, no swap"
    for M in 1g 768m 512m; do
      docker update --memory "$M" --memory-swap "$M" "$CT" >/dev/null
      R "P=\$HOME/isotherm/packages/cre-workflow; export PATH=\$P/.tools/bin:\$PATH; cd \$P/settle; command -v /usr/bin/time >/dev/null || sudo apt-get install -y -qq time >/dev/null 2>&1; /usr/bin/time -v cre workflow build . -T testnet -R .. >/tmp/b.log 2>/tmp/t.log; echo \"cap $M: exit \$?, \$(grep -o 'Binary hash: [0-9a-f]*' /tmp/b.log || echo 'no binary'), \$(grep 'Maximum resident' /tmp/t.log | sed 's/^[[:space:]]*//')\""
    done
    docker update --memory 8g --memory-swap 8g "$CT" >/dev/null
  } 2>&1 | save memory.txt
}
step_fork() { R 'bash isotherm/packages/cre-workflow/vps/test/e2e-systemd-fork.sh' 2>&1 | save systemd-fork-e2e.txt; }
step_tripwire() { R 'bash isotherm/packages/cre-workflow/vps/test/tripwire-unit.sh' 2>&1 | save tripwire-unit.txt; }
step_mac() { bash "$PKG/vps/test/mac-cutover-rehearsal.sh" "$SC/mac" "$CFG" 2>&1 | save mac-cutover-rehearsal.txt; }
step_macpre() {
  clear_of_05
  local H="$SC/macpre" FB; rm -rf "$H"; mkdir -p "$H/home" "$H/state"
  FB=$(dirname "$(command -v cast || echo "$HOME/.foundry/bin/cast")")
  { hdr "macOS $(sw_vers -productVersion), /bin/bash $(/bin/bash -c 'echo $BASH_VERSION'): run-official.sh --harness --preflight-only with a THROWAWAY key, scratch HOME (no CRE session), live reads only"
    read -r _ K < <("$FB/cast" wallet new 2>/dev/null | tail -n1); printf '%s' "$K" >"$H/throwaway.key"; unset K; chmod 600 "$H/throwaway.key"
    echo "## mode 600: passes the mode check, refused at the attester check"
    env HOME="$H/home" PATH="$FB:$PATH" ISOTHERM_STATE_DIR="$H/state" ISOTHERM_ATTESTER_KEY_FILE="$H/throwaway.key" /bin/bash "$PKG/scripts/run-official.sh" --harness --preflight-only 2>&1; echo "exit $?"
    chmod 644 "$H/throwaway.key"; echo "## mode 644: refused at the mode check"
    env HOME="$H/home" PATH="$FB:$PATH" ISOTHERM_STATE_DIR="$H/state" ISOTHERM_ATTESTER_KEY_FILE="$H/throwaway.key" /bin/bash "$PKG/scripts/run-official.sh" --harness --preflight-only 2>&1 | tail -n1
    rm -f "$H/throwaway.key"
  } 2>&1 | save mac-preflight.txt
}
step_amd64() {
  docker rm -f "$CT64" >/dev/null 2>&1
  docker run -d --name "$CT64" --platform linux/amd64 ubuntu:24.04 sleep infinity >/dev/null
  docker exec "$CT64" bash -c 'apt-get update -qq && apt-get install -y -qq sudo >/dev/null 2>&1 && useradd -m -s /bin/bash isotherm && echo "isotherm ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/isotherm-test' >/dev/null
  docker exec -u isotherm "$CT64" mkdir -p /home/isotherm/isotherm/packages/cre-workflow /home/isotherm/isotherm/packages/abi /home/isotherm/isotherm/deployments
  COPYFILE_DISABLE=1 tar -C "$PKG" --no-xattrs "${EXCL[@]}" -cf - . | docker exec -i -u isotherm "$CT64" tar -C /home/isotherm/isotherm/packages/cre-workflow -xf - --no-same-owner
  COPYFILE_DISABLE=1 tar -C "$REPO/packages/abi" --no-xattrs -cf - . | docker exec -i -u isotherm "$CT64" tar -C /home/isotherm/isotherm/packages/abi -xf - --no-same-owner
  docker exec -i -u isotherm "$CT64" sh -c 'cat > /home/isotherm/isotherm/deployments/testnet.json' <"$REPO/deployments/testnet.json"
  docker exec -u isotherm -w /home/isotherm "$CT64" bash -c '
    echo "# $(date -u +%FT%TZ) vps/setup.sh --no-units on $(. /etc/os-release; echo $PRETTY_NAME) $(uname -m) (plain container, emulated on Apple silicon; /proc/cpuinfo avx2: $(grep -m1 -o -w avx2 /proc/cpuinfo || echo none))"
    time bash isotherm/packages/cre-workflow/vps/setup.sh --no-units; echo "exit $?"
    P=isotherm/packages/cre-workflow/.tools; echo "installed: $(ls $P/bin | tr "\n" " "); downloads kept: $(ls $P/dl | tr "\n" " ")"' 2>&1 | grep -v 'debconf: delaying' | save setup-amd64.txt
}
step_down() { docker rm -f "$CT" "$CT64" >/dev/null 2>&1; echo "containers removed"; }

STEPS=("$@"); [ "${1:-all}" = all ] && STEPS=(image up push setup lint live login memory fork tripwire mac macpre amd64)
for s in "${STEPS[@]}"; do echo "== $s"; "step_$s"; done
