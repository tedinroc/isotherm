#!/usr/bin/env bash
# shellcheck disable=SC2001,SC2016  # `echo "$OUT" | sed` indents output on purpose; single-quoted commands expand on the VPS
# TEST ONLY, on the Mac: rehearses vps/cutover.sh and vps/rollback.sh end to end against a test VPS (a container reached
# over ssh, see run-container-tests.sh) whose job points at an anvil fork (fork-env.sh). The Mac side is simulated:
#   - HOME is a scratch directory (the plist and the "runtime copy" ~/isotherm-live live there),
#   - `launchctl` is a stub on PATH that records every call and keeps a loaded/disabled state,
# so the real launchd jobs and the real runtime copy are never touched. No real key is read anywhere.
#   vps/test/mac-cutover-rehearsal.sh <scratch dir> <ssh_config> [vps alias, default isotherm-test]
set -uo pipefail
PKG="$(cd "$(dirname "$0")/../.." && pwd)"
SC=${1:?scratch dir}; CFG=${2:?ssh_config}; V=${3:-isotherm-test}
H="$SC/home"; FB="$SC/fakebin"; FL="$SC/fake-launchd"; RTV="$H/isotherm-live/packages/cre-workflow/var"
rm -rf "$H" "$FB" "$FL"; mkdir -p "$H/Library/LaunchAgents" "$FB" "$FL" "$RTV/evidence"
cat >"$FB/launchctl" <<'EOF'
#!/bin/bash
# TEST stub of launchctl (records calls; state in $FAKE_LAUNCHD_DIR)
D=${FAKE_LAUNCHD_DIR:?}; echo "launchctl $*" >>"$D/calls.log"
case "$1" in
  print) [ -f "$D/loaded" ] && { echo "	state = not running"; exit 0; }; echo "Could not find service \"${2##*/}\" in domain" >&2; exit 113 ;;
  print-disabled) echo "disabled services = {"; [ -f "$D/disabled" ] && printf '\t"xyz.isotherm.cre-settle" => disabled\n'; echo "}" ;;
  bootout) [ -f "$D/loaded" ] || { echo "Boot-out failed: 3: No such process" >&2; exit 3; }; rm -f "$D/loaded" ;;
  bootstrap) [ -f "$D/disabled" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }; [ -f "$3" ] || { echo "no plist $3" >&2; exit 2; }; touch "$D/loaded" ;;
  disable) touch "$D/disabled" ;;
  enable) rm -f "$D/disabled" ;;
  *) echo "stub: unsupported $*" >&2; exit 64 ;;
esac
EOF
chmod +x "$FB/launchctl"
echo '<?xml version="1.0"?><!-- test placeholder for xyz.isotherm.cre-settle --><plist version="1.0"><dict/></plist>' >"$H/Library/LaunchAgents/xyz.isotherm.cre-settle.plist"
NOW=$(date +%s); echo $((NOW - 1200)) >"$RTV/last-run"
node -e 'console.log(JSON.stringify({job:"xyz.isotherm.cre-settle",finishedAt:new Date((Number(process.argv[1])-1170)*1000).toISOString(),path:"official",exitCode:0}))' "$NOW" >"$RTV/evidence/LATEST.json"
touch "$FL/loaded"   # the Mac job is loaded and enabled, as today
export HOME="$H" ISOTHERM_RUNTIME="$H/isotherm-live" FAKE_LAUNCHD_DIR="$FL" PATH="$FB:$PATH" ISOTHERM_VPS_SSH_OPTS="-F $CFG"
R() { ssh -F "$CFG" -o BatchMode=yes "$V" "$@"; }
st() { echo "    Mac (stub launchd): loaded=$([ -f "$FL/loaded" ] && echo yes || echo no) disabled=$([ -f "$FL/disabled" ] && echo yes || echo no); runtime var: writer.released=$([ -f "$RTV/writer.released" ] && echo present || echo absent), last-run=$(cat "$RTV/last-run")"; }
PASS=0; FAIL=0
ok() { if [ "$1" = 1 ]; then PASS=$((PASS + 1)); echo "  PASS  $2"; else FAIL=$((FAIL + 1)); echo "  FAIL  $2"; fi; }
CUT="bash $PKG/vps/cutover.sh $V"; ROLL="bash $PKG/vps/rollback.sh $V"

echo "# $(date -u +%FT%TZ) mac-cutover-rehearsal: Mac side simulated (scratch HOME, launchctl stub), VPS = the test container over ssh"
R 'bash isotherm/packages/cre-workflow/vps/test/fork-env.sh up' 2>&1 | sed 's/^/    /' || { echo "  FAIL  fork-env up (test environment); nothing rehearsed"; exit 1; }
st

echo; echo "## C1. dry run without --allow-harness: NOT READY (no CRE login on the test VPS; time gate skipped with --any-time)"
OUT=$($CUT --any-time 2>&1); echo "$OUT" | sed 's/^/    | /'
ok "$(echo "$OUT" | grep -q 'GATE FAIL  CRE login on the VPS' && echo "$OUT" | grep -q 'NOT READY' && [ -f "$FL/loaded" ] && echo 1 || echo 0)" "NOT READY on the login gate; nothing changed"

echo; echo "## C2. dry run with --allow-harness: READY"
OUT=$($CUT --any-time --allow-harness 2>&1); echo "$OUT" | grep -E 'GATE|READY|E[123]\.' | sed 's/^/    | /'
ok "$(echo "$OUT" | grep -q 'DRY RUN: nothing changed. READY' && echo 1 || echo 0)" "READY, nothing changed"

echo; echo "## C3. --execute while the VPS cannot enable its timer: E3 fails, the VPS confirms no claim, the Mac job is restored"
R 'bash isotherm/packages/cre-workflow/vps/test/fork-env.sh block-enable' | sed 's/^/    /'
OUT=$($CUT --execute --any-time --allow-harness --no-sync 2>&1); echo "$OUT" | grep -E 'E[123]|UNDO|FAILED|confirmed|STOPPED' | sed 's/^/    | /'
st
VC=$(R 'bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh check' | tail -n1)
ok "$([ -f "$FL/loaded" ] && [ ! -f "$FL/disabled" ] && [ ! -f "$RTV/writer.released" ] && [ -z "$(node -e 'console.log(JSON.parse(process.argv[1]).claim||"")' "$VC")" ] && echo 1 || echo 0)" "Mac job loaded + enabled again, no writer.released, no claim on the VPS"
R 'bash isotherm/packages/cre-workflow/vps/test/fork-env.sh unblock-enable' | sed 's/^/    /'

echo; echo "## C4. --execute: E1 Mac job off + disabled, E2 writer.released, E3 the VPS claims and enables its timer"
OUT=$($CUT --execute --any-time --allow-harness --no-sync 2>&1); echo "$OUT" | grep -E 'E[123]|DONE|writer|timer|peer|VPS preflight' | sed 's/^/    | /'
ok "$(echo "$OUT" | grep -q 'GATE OK    VPS preflight.*preflight OK' && echo 1 || echo 0)" "the preflight gate ran a real preflight (the VPS still held writer.released from C3)"
st
VC=$(R 'bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh check' | tail -n1)
echo "    VPS: claim=$(node -e 'console.log(JSON.parse(process.argv[1]).claim)' "$VC"), timer=$(node -e 'console.log(JSON.parse(process.argv[1]).timer)' "$VC")"
ok "$([ ! -f "$FL/loaded" ] && [ -f "$FL/disabled" ] && [ -f "$RTV/writer.released" ] && node -e 'const j=JSON.parse(process.argv[1]); process.exit(j.claim && j.timer==="enabled/active" ? 0 : 1)' "$VC" && echo 1 || echo 0)" "Mac off and disabled, writer.released written; VPS claimed, timer enabled/active"

echo; echo "## C5. a manual broadcasting run on the Mac (repo copy, live RPC default) refuses: the runtime state says released"
OUT=$(bash "$PKG/scripts/run-official.sh" 2>&1); RC=$?; echo "$OUT" | sed 's/^/    | /'
ok "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'SKIPPED: this host released' && echo 1 || echo 0)" "run-official.sh on the Mac stops before reading any key (exit $RC)"

echo; echo "## C5b. the role is with $V: a cutover to another VPS, and a rollback naming another VPS (even 'confirmed off'), are refused"
OUT=$(bash "$PKG/vps/cutover.sh" isotherm-unreachable --any-time 2>&1); echo "$OUT" | grep -E 'the Mac holds|REFUSED' | sed 's/^/    | /'
OUT2=$(bash "$PKG/vps/rollback.sh" isotherm-unreachable --execute --vps-unreachable --confirm-vps-off 2>&1 </dev/null); echo "$OUT2" | grep -E 'REFUSED|R[123]' | sed 's/^/    | /'
st
ok "$(echo "$OUT" | grep -q 'GATE FAIL  the Mac holds the writer role' && echo "$OUT2" | grep -q "REFUSED: the Mac handed the writer role to '$V'" && [ ! -f "$FL/loaded" ] && [ -f "$FL/disabled" ] && [ -f "$RTV/writer.released" ] && echo 1 || echo 0)" "both refused; the Mac job stays off and released"

echo; echo "## C6. the VPS's first run: the Mac ran 20 min ago -> refused by the 50-min handover guard"
R 'systemctl --user start isotherm-settle.service; journalctl --user -u isotherm-settle -n 3 --no-pager -o cat' | grep -E 'REFUSED' | sed 's/^/    | /'
ok "$(R 'tail -n1 cutover-test/state/evidence/writer-guard.jsonl' | grep -q peer-recent && echo 1 || echo 0)" "refused peer-recent"

echo; echo "## C7. an hour later (peer record aged on purpose): the VPS settles RCSS 2026-10-09 on the fork, harness path"
R 'bash -s' <<'EOS' | grep -E '\[sent\]|block .* status=|\[evidence\]|tripwire' | sed 's/^/    | /'
cd cutover-test/state
node -e 'const fs = require("fs"), p = JSON.parse(fs.readFileSync("peer-last-run.json", "utf8")); p.lastRunEpoch -= 3600; p.finishedAt = null; fs.writeFileSync("peer-last-run.json", JSON.stringify(p))'
systemctl --user start isotherm-settle.service
journalctl --user -u isotherm-settle -n 30 --no-pager -o cat
EOS
ok "$(R 'cat cutover-test/state/evidence/LATEST.json' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.exit(r.host==="vps"&&r.reportsSent.length===1&&r.reportsSent[0].confirmed==="resolved"?0:1)})' && echo 1 || echo 0)" "VPS settled through its systemd unit after the cutover"
VPS_LAST=$(R 'cat cutover-test/state/last-run')

echo; echo "## C8. rollback dry run, then --execute: R1 the VPS releases first, R2 last-run handed back, R3 the Mac job reloaded"
$ROLL 2>&1 | sed 's/^/    | /'
OUT=$($ROLL --execute 2>&1); echo "$OUT" | grep -E 'R[123]|DONE|FAILED|REFUSED' | sed 's/^/    | /'
st
VC=$(R 'bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh check' | tail -n1)
echo "    VPS: claim=$(node -e 'console.log(JSON.parse(process.argv[1]).claim)' "$VC"), released=$(node -e 'console.log(JSON.parse(process.argv[1]).released)' "$VC"), timer=$(node -e 'console.log(JSON.parse(process.argv[1]).timer)' "$VC")"
ok "$([ -f "$FL/loaded" ] && [ ! -f "$FL/disabled" ] && [ ! -f "$RTV/writer.released" ] && [ "$(cat "$RTV/last-run")" = "$VPS_LAST" ] && node -e 'const j=JSON.parse(process.argv[1]); process.exit(!j.claim && j.released && j.timer==="disabled/inactive" ? 0 : 1)' "$VC" && echo 1 || echo 0)" "Mac loaded + enabled, Mac last-run = the VPS's last run ($VPS_LAST); VPS released, timer disabled/inactive"
OUT=$(R 'systemctl --user start isotherm-settle.service; tail -n1 cutover-test/state/evidence/writer-guard.jsonl')
ok "$(echo "$OUT" | grep -q no-claim && echo 1 || echo 0)" "a VPS run after the rollback refuses (no claim)"

echo; echo "## C9. rollback when the VPS cannot be reached: refused without the typed confirmation; nothing changes"
launchctl bootout "gui/$(id -u)/xyz.isotherm.cre-settle"; launchctl disable "gui/$(id -u)/xyz.isotherm.cre-settle"   # (stub) as after a cutover
OUT=$(bash "$PKG/vps/rollback.sh" isotherm-unreachable --execute 2>&1 </dev/null); echo "$OUT" | grep -E 'NOT reachable|REFUSED' | sed 's/^/    | /'
OUT2=$(bash "$PKG/vps/rollback.sh" isotherm-unreachable --execute --vps-unreachable 2>&1 </dev/null); echo "$OUT2" | grep -E 'REFUSED' | sed 's/^/    | /'
ok "$([ ! -f "$FL/loaded" ] && [ -f "$FL/disabled" ] && echo "$OUT" | grep -q REFUSED && echo "$OUT2" | grep -q REFUSED && echo 1 || echo 0)" "both refused; the Mac job stays off"
OUT=$(bash "$PKG/vps/rollback.sh" isotherm-unreachable --execute --vps-unreachable --confirm-vps-off 2>&1 </dev/null); echo "$OUT" | grep -E 'R[123]|DONE' | sed 's/^/    | /'
ok "$([ -f "$FL/loaded" ] && [ ! -f "$FL/disabled" ] && [ $(( $(cat "$RTV/last-run") - $(date +%s) )) -ge -60 ] && echo 1 || echo 0)" "with 'THE VPS IS OFF' confirmed: Mac job back, spacing guard counts from now"

echo; echo "## C10. cutover again after the rollback: what the Mac sent while it was the writer is not a writer conflict"
R 'K=$(cat cutover-test/keys/tx.key); $HOME/isotherm/packages/cre-workflow/.tools/bin/cast send --private-key "$K" 0x000000000000000000000000000000000000dEaD --value 0 --rpc-url http://127.0.0.1:19370 >/dev/null && echo "    (test) a 0-value tx from the shared tx key, as the Mac settling while it held the role"'
# the Mac last ran an hour ago (both handover fields), so the VPS's first run passes the 50-min guard and reaches the tripwire
NOW=$(date +%s); echo $((NOW - 3600)) >"$RTV/last-run"
node -e 'console.log(JSON.stringify({job:"xyz.isotherm.cre-settle",finishedAt:new Date((Number(process.argv[1])-3570)*1000).toISOString(),path:"official",exitCode:0}))' "$NOW" >"$RTV/evidence/LATEST.json"
OUT=$($CUT --execute --any-time --allow-harness --no-sync 2>&1); echo "$OUT" | grep -E 'E[123] |DONE|FAILED' | sed 's/^/    | /'
OUT=$(R 'c=$(journalctl --user -u isotherm-settle -n 1 --show-cursor --no-pager -o cat | sed -n "s/^-- cursor: //p"); systemctl --user start isotherm-settle.service; journalctl --user -u isotherm-settle --after-cursor "$c" --no-pager -o cat | grep -E "\[vps\] (REFUSED|tripwire)|spacing"; [ -e cutover-test/state/writer-conflict ] || echo "no writer-conflict"' 2>&1)
echo "$OUT" | sed 's/^/    | /'
ok "$(echo "$OUT" | grep -q 'no writer-conflict' && echo "$OUT" | grep -q 'single writer' && ! echo "$OUT" | grep -q 'REFUSED' && echo 1 || echo 0)" "the VPS's first run after the second cutover passes the handover guard and finds no conflict (the claim re-baselined the tripwire)"

echo; echo "## stub launchd calls, in order"
sed 's/^/    /' "$FL/calls.log"
R 'bash isotherm/packages/cre-workflow/vps/test/fork-env.sh down' | sed 's/^/    /'
echo; echo "# $(date -u +%FT%TZ) done: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
