#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2030,SC2031  # single-quoted stub bodies are meant literally; PATH set inside $(…) for the node lookup stays local on purpose
# TEST ONLY, on the Mac (or a Linux host where a user-level sshd can start): vps/relogin.sh end to end through the REAL
# ssh client and a throwaway sshd on 127.0.0.1 (own host key, own authorized key, scratch config; no container, no
# VPS, no network, no CRE account). The "VPS" is this machine: the REAL vps/isotherm-vps.sh `login` runs in a scratch
# package whose `cre` is a fake: `cre login` refuses without a terminal (as the real CLI does), prints a sign-in URL
# and listens on 127.0.0.1:53682 for the callback; `cre whoami` succeeds once a callback with the right state arrived.
# A stub `open` plays the browser: it calls back through the tunnel's local end, as the real browser redirect does.
#   S1 the sign-in completes   -> exit 0, "cre whoami: yes"; the callback crossed the tunnel; the remote side had a
#                                 terminal (1000 columns); nothing secret shown; no ssh process, port or temp file left
#   S2 nobody signs in         -> exit 124 after --timeout; the waiting remote `cre login` ends with the ssh process
#                                 (SIGHUP); port 53682 free again; nothing left
#   S3 ssh cannot log in       -> exit 1, "could not connect or log in" (BatchMode: no password prompt)
#   S4 --dry-run               -> the real `ssh -G` reads the alias; nothing started
# Needs port 53682 free on this machine (the fake CLI listens there, standing for the VPS side of the tunnel).
# Usage: vps/test/relogin-local-sshd.sh   Env: KEEP=1 keeps the scratch.
# Output: stdout and a report (paths, user name and addresses replaced) in a new file kept under $TMPDIR, its path
#   printed. ISOTHERM_WRITE_EVIDENCE=1 also writes the tracked vps/evidence/relogin-local-sshd.txt (or the file named
#   by ISOTHERM_TEST_EVIDENCE=<file>, as in stack-watch-unit.sh), and only when every check passed. Exit 0 = all
#   pass, 3 = skipped (sshd could not start, or port 53682 is in use).
set -uo pipefail
REAL="$(cd "$(dirname "$0")/../.." && pwd)"; REPO=$(cd "$REAL/../.." && pwd)
EVOUT=${ISOTHERM_TEST_EVIDENCE:-$REAL/vps/evidence/relogin-local-sshd.txt}
SEARCH="$REAL/.tools/bin:$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
NODE=$(PATH=$SEARCH; command -v node) || { echo "node not found" >&2; exit 2; }
SSHD=$(command -v sshd 2>/dev/null || echo /usr/sbin/sshd)
TMPBASE=${TMPDIR:-/tmp}; SC=$(mktemp -d "${TMPBASE%/}/isotherm-relogin-sshd.XXXXXX"); SCP=$(cd "$SC" && pwd -P)
ME=$(id -un)
# shellcheck disable=SC2317  # called by the EXIT trap
cleanup() {
  [ -f "$SC/sshd.pid" ] && kill "$(cat "$SC/sshd.pid")" 2>/dev/null
  [ -n "${SSHD_PID:-}" ] && kill "$SSHD_PID" 2>/dev/null
  pkill -f "$SCP/fakevps" 2>/dev/null; pkill -f "$SC/fakevps" 2>/dev/null
  [ "${KEEP:-0}" = 1 ] || rm -rf "$SC"
}
trap cleanup EXIT
san() { # paths, the user name, addresses (except 127.0.0.1) and key fingerprints out of the evidence
  SC_=$SC SCP_=$SCP REPO_=$REPO HOME_=$HOME ME_=$ME perl -pe 's/\Q$ENV{SCP_}\E/<scratch>/g; s/\Q$ENV{SC_}\E/<scratch>/g;
    s/\Q$ENV{REPO_}\E/<repo>/g; s/\Q$ENV{HOME_}\E/~/g; s/\b\Q$ENV{ME_}\E\b/<user>/g;
    s/\b(?!127\.0\.0\.1\b)\d{1,3}(?:\.\d{1,3}){3}\b/<addr>/g; s/SHA256:[A-Za-z0-9+\/]+/SHA256:<key>/g'
}
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
freeport() { "$NODE" -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close() })'; }

main() {
echo "# $(date -u +%FT%TZ) relogin-local-sshd: $(/bin/bash -c 'echo "bash $BASH_VERSION"') on $(uname -s) $(uname -m); real ssh ($(ssh -V 2>&1 | cut -d, -f1)) to a throwaway sshd on 127.0.0.1; fake cre; no VPS, no network"
if listening 53682; then echo "SKIPPED: port 53682 is in use on this machine (a cre login running here?)"; return 3; fi
SPORT=$(freeport); LPORT=$(freeport)
ssh-keygen -q -t ed25519 -N '' -C test-host -f "$SC/hostkey"; ssh-keygen -q -t ed25519 -N '' -C test-client -f "$SC/id_test"
ssh-keygen -q -t ed25519 -N '' -C test-other -f "$SC/id_other"; cp "$SC/id_test.pub" "$SC/authorized_keys"
cat >"$SC/sshd_config" <<EOF
Port $SPORT
ListenAddress 127.0.0.1
HostKey $SC/hostkey
PidFile $SC/sshd.pid
AuthorizedKeysFile $SC/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowTcpForwarding yes
PermitTTY yes
LogLevel VERBOSE
EOF
for h in isotherm-e2e:id_test isotherm-e2e-badkey:id_other; do
  printf 'Host %s\n  HostName 127.0.0.1\n  Port %s\n  User %s\n  IdentityFile %s\n  IdentitiesOnly yes\n  UserKnownHostsFile %s\n  StrictHostKeyChecking accept-new\n' \
    "${h%%:*}" "$SPORT" "$ME" "$SC/${h#*:}" "$SC/known_hosts" >>"$SC/ssh_config"
done
"$SSHD" -D -e -f "$SC/sshd_config" >"$SC/sshd.log" 2>&1 & SSHD_PID=$!
for _ in $(seq 1 50); do listening "$SPORT" && break; sleep 0.1; done
listening "$SPORT" || { echo "SKIPPED: a user-level sshd could not start here:"; san <"$SC/sshd.log" | tail -n 3; return 3; }

# the "VPS" package: the REAL isotherm-vps.sh and lib.sh; a fake cre
P="$SC/fakevps/packages/cre-workflow"; mkdir -p "$P/vps" "$P/.tools/bin" "$P/var"
ln -s "$REAL/vps/isotherm-vps.sh" "$P/vps/isotherm-vps.sh"; ln -s "$REAL/vps/lib.sh" "$P/vps/lib.sh"; ln -s "$NODE" "$P/.tools/bin/node"
cat >"$P/.tools/bin/cre" <<'EOF'
#!/bin/bash
# FAKE cre (test only): `login` needs a terminal, prints a sign-in URL, waits for the callback on 127.0.0.1:53682
D="$(cd "$(dirname "$0")/../.." && pwd)"
case "$1" in
  version) echo "CRE CLI version v1.37.0" ;;
  whoami) [ -f "$D/var/fake-session" ] ;;
  login)
    [ -t 0 ] || { echo "login is not supported in non-interactive mode, use CRE_API_KEY instead"; exit 1; }
    stty size >"$D/var/login-pty" 2>/dev/null; echo $$ >"$D/var/login-pid"
    exec node -e '
      const st = "st" + Math.random().toString(36).slice(2, 12), D = process.argv[1], fs = require("fs");
      const url = `https://login.chain.link/authorize?audience=https%3A%2F%2Fapi.cre.chain.link%2F&client_id=FAKECLIENTID&code_challenge=FAKECHALLENGE&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A53682%2Fcallback&response_type=code&scope=openid+profile+email+offline_access&state=${st}`;
      process.stdout.write("\x1b[1mCRE Login\x1b[0m\n  Authenticate with your Chainlink account\n \x1b[36mOpening browser to:\x1b[0m\n" + url + "\n\x1b[33m! Could not open browser automatically\x1b[0m\n  Please open the URL above in your browser\n  Waiting for authentication... (Press Ctrl+C to cancel)\n");
      process.on("SIGHUP", () => { fs.writeFileSync(D + "/var/login-ended", "SIGHUP\n"); process.exit(129) });
      require("http").createServer((q, r) => {
        const u = new URL(q.url, "http://x");
        if (u.pathname !== "/callback" || u.searchParams.get("state") !== st) { r.writeHead(400); r.end("invalid state"); return }
        r.end("ok"); fs.writeFileSync(D + "/var/fake-session", "x");
        console.log("\x1b[32m✓ Login successful\x1b[0m as tester@example.com; access_token=eyJfakeheader.eyJfakepayload.fakesig0123456789");
        setTimeout(() => process.exit(0), 100);
      }).listen(53682, "127.0.0.1");
      setTimeout(() => process.exit(5), 120000);
    ' "$D" ;;
  *) exit 97 ;;
esac
EOF
chmod +x "$P/.tools/bin/cre"
SB="$SC/bin"; mkdir -p "$SB" "$SC/tmp"
cat >"$SB/open" <<'EOF'
#!/bin/bash
# stub `open` (test only): plays the browser, whose redirect goes to localhost:<the tunnel's local port>/callback
echo "$1" >"$E2E_DIR/opened"
[ -f "$E2E_DIR/browser-idle" ] && exit 0
st=$(printf '%s' "$1" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')
( sleep 2; curl -s --noproxy '*' -o "$E2E_DIR/callback-answer" -w '%{http_code}' "http://localhost:$ISOTHERM_RELOGIN_PORT/callback?code=fakecode&state=$st" >"$E2E_DIR/callback-code" ) &
EOF
chmod +x "$SB/open"
PASS=0; FAIL=0
ok() { if [ "$1" = 1 ]; then PASS=$((PASS + 1)); echo "  PASS  $2"; else FAIL=$((FAIL + 1)); echo "  FAIL  $2"; fi; }
run() { # run <case> <alias> [relogin args]: the real relogin.sh, the real ssh
  local c=$1 a=$2; shift 2
  env E2E_DIR="$SC" TMPDIR="$SC/tmp" ISOTHERM_RELOGIN_PORT="$LPORT" ISOTHERM_VPS_SSH_OPTS="-F $SC/ssh_config" \
    ISOTHERM_VPS_DIR="$SC/fakevps" PATH="$SB:$PATH" /bin/bash "$REAL/vps/relogin.sh" "$a" "$@" >"$SC/out-$c.txt" 2>&1 </dev/null
  RC=$?; sed -E 's/^\[[^]]+\] //; s/^/    | /' "$SC/out-$c.txt"; echo "    exit $RC"
}
left() { echo "ssh processes $(pgrep -f "ssh -tt .*isotherm-e2e" | wc -l | tr -d ' '), port 53682 $(listening 53682 && echo listening || echo free), port $LPORT $(listening "$LPORT" && echo listening || echo free), temp files $(find "$SC/tmp" -mindepth 1 | wc -l | tr -d ' ')"; }
clean() { [ "$(pgrep -f "ssh -tt .*isotherm-e2e" | wc -l | tr -d ' ')" = 0 ] && ! listening 53682 && ! listening "$LPORT" && [ -z "$(ls -A "$SC/tmp")" ]; }

echo; echo "## S1. the sign-in completes: the stub browser calls back through the tunnel"
run S1 isotherm-e2e --timeout 60; sleep 1
echo "    callback: HTTP $(cat "$SC/callback-code" 2>/dev/null) '$(cat "$SC/callback-answer" 2>/dev/null)'; remote terminal size: $(cat "$P/var/login-pty" 2>/dev/null); left: $(left)"
ok "$([ "$RC" = 0 ] && grep -q "SIGNED IN: the VPS answered 'cre whoami: yes'" "$SC/out-S1.txt" && [ "$(cat "$SC/callback-code" 2>/dev/null)" = 200 ] && echo 1 || echo 0)" "exit 0, 'cre whoami: yes', the callback crossed the tunnel (HTTP 200)"
ok "$([ "$(cut -d' ' -f2 "$P/var/login-pty" 2>/dev/null)" = 1000 ] && echo 1 || echo 0)" "the remote side had a terminal, 1000 columns wide (ssh -tt, stty cols)"
ok "$(! grep -qE 'eyJ|tester@example|FAKECLIENTID|FAKECHALLENGE|state=st' "$SC/out-S1.txt" && ! grep -qE '(^|: )(head|sed|grep|perl|wc):|line [0-9]+:' "$SC/out-S1.txt" && echo 1 || echo 0)" "nothing secret and no tool error in the output"
ok "$(clean && echo 1 || echo 0)" "no ssh process, listening port or temp file left"

echo; echo "## S2. nobody signs in: --timeout 8"
rm -f "$P/var/fake-session" "$P/var/login-ended" "$SC/callback-code"; touch "$SC/browser-idle"
run S2 isotherm-e2e --timeout 8; sleep 2
echo "    remote cre login ended by: $(cat "$P/var/login-ended" 2>/dev/null || echo '(not recorded)'), its process $(kill -0 "$(cat "$P/var/login-pid")" 2>/dev/null && echo 'STILL RUNNING' || echo gone); left: $(left)"
ok "$([ "$RC" = 124 ] && grep -q 'TIMED OUT after 8 s waiting for the browser sign-in' "$SC/out-S2.txt" && echo 1 || echo 0)" "exit 124, a clear message"
ok "$([ "$(cat "$P/var/login-ended" 2>/dev/null)" = SIGHUP ] && ! kill -0 "$(cat "$P/var/login-pid")" 2>/dev/null && echo 1 || echo 0)" "the waiting remote cre login ended with the ssh process (SIGHUP)"
ok "$(clean && echo 1 || echo 0)" "no ssh process, listening port or temp file left"

echo; echo "## S3. ssh cannot log in (a key the sshd does not know)"
run S3 isotherm-e2e-badkey --timeout 30
ok "$([ "$RC" = 1 ] && grep -q 'ssh could not connect or log in' "$SC/out-S3.txt" && clean && echo 1 || echo 0)" "exit 1 with the reason, nothing left"

echo; echo "## S4. --dry-run with the real ssh -G"
run S4 isotherm-e2e --dry-run
ok "$([ "$RC" = 0 ] && grep -q "OK       ssh config: 'isotherm-e2e' is an alias" "$SC/out-S4.txt" && grep -q 'DRY RUN: nothing started' "$SC/out-S4.txt" && echo 1 || echo 0)" "exit 0, the alias read, nothing started"

echo; echo "## sshd's view (sessions)"
grep -E 'Accepted publickey|Starting session|Received disconnect|Failed publickey|Connection closed by authenticating' "$SC/sshd.log" | sed -E 's/ port [0-9]+/ port <n>/g; s/^/    /'
echo; echo "# $(date -u +%FT%TZ) done: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
}

main 2>&1 | san | tee "$SC/report.txt"; RC=${PIPESTATUS[0]}
# the report: always to a new file kept under $TMPDIR; to the tracked evidence file only on request, and only after a pass
KEPT=$(mktemp -d "${TMPBASE%/}/isotherm-evidence.XXXXXX")/relogin-local-sshd.txt
cp "$SC/report.txt" "$KEPT"; echo "-> $KEPT"
if [ "${ISOTHERM_WRITE_EVIDENCE:-0}" = 1 ]; then
  if [ "$RC" = 0 ]; then mkdir -p "$(dirname "$EVOUT")"; cp "$KEPT" "$EVOUT"; echo "-> ${EVOUT#"$REPO"/}"
  else echo "-> ${EVOUT#"$REPO"/} left unchanged: the run failed or was skipped (exit $RC)"; fi
fi
exit "$RC"
