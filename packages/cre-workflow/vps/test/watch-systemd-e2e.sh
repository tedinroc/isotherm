#!/usr/bin/env bash
# shellcheck disable=SC2016  # single-quoted commands are meant to expand inside the container
# TEST ONLY, on the Mac with Docker or OrbStack: the stack watchdog's systemd USER units and vps/install-watch.sh under a
# real systemd (PID 1, a lingering user manager), in a throwaway container of the test image (vps/test/Dockerfile,
# Ubuntu 24.04) started with NO network: every GET fails, so the service's run records "API unreadable 1/3" and pushes
# nothing (there is no alert URL file either). node is copied in from the local node:22-bookworm image. Checks:
#   W1 install-watch.sh refuses root
#   W2 install: both units rendered (@PKG@ filled in), systemd-analyze verify clean, the timer enabled + active, the next
#      run at a :x0 minute; a second install changes nothing
#   W3 the schedule: OnCalendar *:00/10 UTC never lands on :03-:09 (systemd-analyze calendar, the next 12)
#   W4 the service through systemd: Result=success; Nice 15, idle I/O, CPUWeight 20, MemoryMax 300M applied; the first
#      digest handed to push_alert, which sends nothing without an alert URL file; its state
#      in var/watch/state.json; nothing else under var/; the journal shows the run (or the :03-:09 skip)
#   W5 --status (the run's journal lines, never the machine's hostname; a snooze set and ended); --uninstall: timer
#      gone, both units removed, var/watch kept; --uninstall --purge: var/watch gone; isotherm-settle.* never touched
#      (a stand-in settle unit stays enabled throughout)
# Output: stdout and vps/evidence/watch-systemd-e2e.txt. Exit 0 = all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/../.." && pwd)"; REPO=$(cd "$PKG/../.." && pwd)
EVOUT=$PKG/vps/evidence/watch-systemd-e2e.txt
IMG=isotherm-vps-test:24.04; NODEIMG=node:22-bookworm; CT=iso-watch-e2e
SC=$(mktemp -d "${TMPDIR:-/tmp}/isotherm-watch-e2e.XXXXXX")
# shellcheck disable=SC2317  # called by the EXIT trap
cleanup() { docker rm -f "$CT" >/dev/null 2>&1; docker rm -f "$CT-node" >/dev/null 2>&1; rm -rf "$SC"; }
trap cleanup EXIT

main() {
PASS=0; FAIL=0
ok() { if [ "$1" = 1 ]; then PASS=$((PASS + 1)); echo "  PASS  $2"; else FAIL=$((FAIL + 1)); echo "  FAIL  $2"; fi; }
# as the job's user with its user manager; umask 022 as in a login shell (docker exec's own default is 000)
U() { docker exec -u isotherm -e XDG_RUNTIME_DIR="/run/user/$UIDN" -e DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UIDN/bus" -w /home/isotherm "$CT" bash -c "umask 022; $1"; }
VP=/home/isotherm/isotherm/packages/cre-workflow
for i in "$IMG" "$NODEIMG"; do docker image inspect "$i" >/dev/null 2>&1 || { echo "missing local image $i (build: docker build -t $IMG vps/test; pull: docker pull $NODEIMG)"; return 2; }; done
docker rm -f "$CT" >/dev/null 2>&1
HOSTN=watch-e2e-hostname   # must never show up in --status (it would be the provider's hostname on the real VPS)
docker run -d --name "$CT" --hostname "$HOSTN" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --network none "$IMG" >/dev/null
for _ in $(seq 1 30); do docker exec "$CT" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
docker create --name "$CT-node" "$NODEIMG" >/dev/null && docker cp "$CT-node:/usr/local/bin/node" "$SC/node" && docker rm -f "$CT-node" >/dev/null
docker cp "$SC/node" "$CT:/usr/local/bin/node"
UIDN=$(docker exec "$CT" id -u isotherm)
# the layout vps/push.sh creates: ~/isotherm/packages/cre-workflow (only vps/ is needed here)
docker exec "$CT" install -d -o isotherm -g isotherm "$VP"
COPYFILE_DISABLE=1 tar -C "$PKG" --no-xattrs --exclude './vps/evidence' --exclude '.DS_Store' -cf - ./vps | docker exec -i "$CT" tar -C "$VP" -xf - --no-same-owner
docker exec "$CT" sh -c "chown -R isotherm: /home/isotherm/isotherm && loginctl enable-linger isotherm"
for _ in $(seq 1 30); do U 'systemctl --user is-system-running' 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
echo "# $(date -u +%FT%TZ) watch-systemd-e2e: $(docker exec "$CT" sh -c '. /etc/os-release; echo "$PRETTY_NAME $(uname -m), systemd $(systemctl --version | head -1 | cut -d" " -f2), $(bash --version | head -1 | cut -d" " -f1-4), node $(node --version)"'); network: $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CT")"
# a stand-in settlement unit, enabled, that must stay untouched
U 'mkdir -p ~/.config/systemd/user && printf "[Unit]\nDescription=stand-in\n[Timer]\nOnCalendar=*-*-* *:05:00 UTC\nUnit=isotherm-settle.service\n[Install]\nWantedBy=timers.target\n" >~/.config/systemd/user/isotherm-settle.timer && printf "[Service]\nType=oneshot\nExecStart=/bin/true\n" >~/.config/systemd/user/isotherm-settle.service && systemctl --user daemon-reload && systemctl --user enable --now isotherm-settle.timer 2>/dev/null; sha256sum ~/.config/systemd/user/isotherm-settle.*' >"$SC/settle-before"

echo; echo "## W1. root is refused"
docker exec "$CT" bash "$VP/vps/install-watch.sh" >"$SC/w1.txt" 2>&1; RC=$?
sed 's/^/    | /' "$SC/w1.txt"
ok "$([ "$RC" = 1 ] && grep -q 'non-root user' "$SC/w1.txt" && echo 1 || echo 0)" "install-watch.sh as root: exit 1"

echo; echo "## W2. install, twice"
U "bash $VP/vps/install-watch.sh" >"$SC/w2a.txt" 2>&1; RC=$?
sed 's/^/    | /' "$SC/w2a.txt"
ok "$([ "$RC" = 0 ] && grep -q 'units written to' "$SC/w2a.txt" && ! grep -q 'verify:' "$SC/w2a.txt" && echo 1 || echo 0)" "exit 0, units written, systemd-analyze verify silent (clean)"
U 'grep -h "@PKG@\|ExecStart\|OnCalendar\|Environment" ~/.config/systemd/user/isotherm-watch.*' | sed 's/^/    | /'
ok "$(U 'grep -q "@PKG@" ~/.config/systemd/user/isotherm-watch.* && echo 0 || echo 1')" "no @PKG@ left; ExecStart and ISOTHERM_WATCH_DIR point at ~/isotherm/packages/cre-workflow"
ok "$(t=$(U 'echo $(systemctl --user is-enabled isotherm-watch.timer)/$(systemctl --user is-active isotherm-watch.timer)'); [ "$t" = enabled/active ] && echo 1 || echo 0)" "timer enabled/active"
NEXT=$(U 'systemctl --user show isotherm-watch.timer -p NextElapseUSecRealtime --value')
echo "    next run: $NEXT"
ok "$(echo "$NEXT" | grep -qE ' [0-9]{2}:[0-5]0:00 ' && echo 1 || echo 0)" "the next run is at a :x0 minute"
U "bash $VP/vps/install-watch.sh" >"$SC/w2b.txt" 2>&1; RC=$?
ok "$([ "$RC" = 0 ] && grep -q 'units unchanged' "$SC/w2b.txt" && echo 1 || echo 0)" "a second install: exit 0, units unchanged (idempotent)"

echo; echo "## W3. the schedule"
docker exec "$CT" systemd-analyze calendar --iterations 12 '*-*-* *:00/10:00 UTC' >"$SC/w3.txt" 2>&1
grep -E 'Normalized|Next elapse|Iter' "$SC/w3.txt" | sed 's/^/    | /'
ok "$(grep -E '(Next elapse|Iter(ation|\.) #[0-9]+):' "$SC/w3.txt" | grep -oE ' [0-9]{2}:[0-9]{2}:[0-9]{2} UTC' | awk -F: '{ m = $2 + 0; if (m >= 3 && m <= 9) bad++; n++ } END { print (n == 12 && !bad) ? 1 : 0 }')" "12 elapses, none at minutes :03-:09"

echo; echo "## W4. one run through systemd (no network: the API is unreadable, nothing is pushed)"
M=$(docker exec "$CT" date -u +%M); M=$((10#$M))
U 'systemctl --user start isotherm-watch.service; systemctl --user show isotherm-watch.service -p Result -p ExecMainStatus -p Nice -p IOSchedulingClass -p CPUWeight -p MemoryMax -p ActiveState' >"$SC/w4.txt" 2>&1
sed 's/^/    | /' "$SC/w4.txt"
ok "$(grep -q '^Result=success' "$SC/w4.txt" && grep -q '^ExecMainStatus=0' "$SC/w4.txt" && echo 1 || echo 0)" "Result=success, exit 0"
ok "$(grep -q '^Nice=15' "$SC/w4.txt" && grep -q '^IOSchedulingClass=3' "$SC/w4.txt" && grep -q '^CPUWeight=20' "$SC/w4.txt" && grep -q '^MemoryMax=314572800' "$SC/w4.txt" && echo 1 || echo 0)" "Nice 15, I/O class idle (3), CPUWeight 20, MemoryMax 300M"
U 'journalctl --user -u isotherm-watch -n 20 --no-pager -o cat' >"$SC/w4j.txt" 2>&1
sed -E 's/(.{220}).*/\1 .../; s/^/    | /' "$SC/w4j.txt"
if [ "$M" -ge 3 ] && [ "$M" -le 9 ]; then
  ok "$(grep -q 'skipped: minute' "$SC/w4j.txt" && echo 1 || echo 0)" "started at minute :$M: skipped by the :03-:09 guard (as designed)"
else
  ok "$(grep -q 'pending: API unreadable, 1/3 runs in a row (/api/health: no answer' "$SC/w4j.txt" && ! grep -q 'WATCH CANNOT REACH' "$SC/w4j.txt" && echo 1 || echo 0)" "the run: API unreadable 1/3 (no CANNOT REACH push before the 3rd)"
  ok "$(grep -q 'ALERT: ISOTHERM WATCH: daily digest' "$SC/w4j.txt" && ! grep -q 'push: ' "$SC/w4j.txt" && echo 1 || echo 0)" "the first digest went to push_alert, which sent nothing: no alert URL file here (it only logs)"
  ok "$(U "node -e 'const s = require(\"$VP/var/watch/state.json\"); process.exit(s.api.fails === 1 ? 0 : 1)' && echo 1 || echo 0")" "var/watch/state.json written (api.fails 1)"
fi
ok "$(U "[ \"\$(ls $VP/var)\" = watch ] && echo 1 || echo 0")" "var/ holds only watch/"

echo; echo "## W5. status, uninstall, purge; the settlement units untouched"
U "bash $VP/vps/install-watch.sh --status" >"$SC/w5s.txt" 2>&1
sed -E 's/(.{200}).*/\1 .../; s/^/    | /' "$SC/w5s.txt"
ok "$([ "$(docker exec "$CT" hostname)" = "$HOSTN" ] && ! grep -qF "$HOSTN" "$SC/w5s.txt" && grep -q '\[watch\] ' "$SC/w5s.txt" && grep -q '^snooze   none' "$SC/w5s.txt" && echo 1 || echo 0)" "--status shows the run's journal lines and the snooze, and never the machine's hostname (journalctl -o cat)"
U "bash $VP/vps/stack-watch.sh --snooze 2 && bash $VP/vps/install-watch.sh --status | grep '^snooze' && bash $VP/vps/stack-watch.sh --snooze 0 && bash $VP/vps/install-watch.sh --status | grep '^snooze'" >"$SC/w5z.txt" 2>&1
sed 's/^/    | /' "$SC/w5z.txt"
ok "$(grep -qE '^snooze   maker checks held until 20[0-9-]+T[0-9:]+Z' "$SC/w5z.txt" && grep -q 'snooze ended' "$SC/w5z.txt" && [ "$(grep -c '^snooze   none' "$SC/w5z.txt")" = 1 ] && echo 1 || echo 0)" "stack-watch.sh --snooze 2 shows in --status (GNU date); --snooze 0 ends it"
U "bash $VP/vps/install-watch.sh --uninstall" >"$SC/w5a.txt" 2>&1; RC=$?
sed 's/^/    | /' "$SC/w5a.txt"
ok "$([ "$RC" = 0 ] && U '[ ! -e ~/.config/systemd/user/isotherm-watch.service ] && [ ! -e ~/.config/systemd/user/isotherm-watch.timer ] && ! systemctl --user list-timers --all --no-pager | grep -q isotherm-watch && echo 1 || echo 0' | grep -q 1 && echo 1 || echo 0)" "--uninstall: timer gone, both units removed"
ok "$(U "[ -f $VP/var/watch/state.json ] && echo 1 || echo 0")" "var/watch kept"
U "bash $VP/vps/install-watch.sh && bash $VP/vps/install-watch.sh --uninstall --purge" >"$SC/w5b.txt" 2>&1; RC=$?
ok "$([ "$RC" = 0 ] && grep -q 'var/watch/ deleted' "$SC/w5b.txt" && U "[ ! -e $VP/var/watch ] && echo 1 || echo 0" | grep -q 1 && echo 1 || echo 0)" "install again, then --uninstall --purge: var/watch deleted"
U 'sha256sum ~/.config/systemd/user/isotherm-settle.*' >"$SC/settle-after"
ok "$(cmp -s "$SC/settle-before" "$SC/settle-after" && [ "$(U 'systemctl --user is-enabled isotherm-settle.timer')" = enabled ] && echo 1 || echo 0)" "isotherm-settle.service/.timer byte-identical and still enabled"

echo; echo "# $(date -u +%FT%TZ) done: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
}

main 2>&1 | tee "$SC/report.txt"; RC=${PIPESTATUS[0]}
sed -e "s#$SC#<scratch>#g" -e "s#$REPO#<repo>#g" -e "s#$HOME#~#g" "$SC/report.txt" >"$EVOUT"
echo "-> ${EVOUT#"$REPO"/}"
exit "$RC"
