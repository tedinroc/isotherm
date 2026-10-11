#!/usr/bin/env bash
# shellcheck disable=SC2016  # single-quoted stub bodies and patterns are meant literally
# TEST ONLY, on the Mac or any Linux host: no container, no network, no real key, no CRE session, 0 MON.
# Part L, the CRE login watch (vps/settle-vps.sh step 5b, vps/lib.sh cre_login_watch, isotherm-vps.sh status): the REAL
#   settle-vps.sh, lib.sh, isotherm-vps.sh, scripts/settle-job.sh and settle/e2e/evidence-record.ts run from a scratch
#   package whose scripts/run-official.sh is a stub (official or harness log lines, no keys) and whose .tools/bin holds
#   shims: `cre` (version, whoami from a file), `curl` (records each push, never connects). No tx key exists, so the
#   tripwire skips its nonce reads.
#   L1 one miss (cre whoami fails)              -> NO push (one miss is often a CRE API timeout); state runs=1; the
#                                                  existing harness-fallback push as before
#   L2 a second miss in a row                   -> one CRE LOGIN NEEDED push, high priority, naming the one-line fix
#   L3 a third miss                             -> no second push (3 h dedupe); the alert still in ALERTS.log
#   L4 the push stamp aged 2 h 59 min / 3 h 1 min -> not pushed / pushed again
#   L5 isotherm-vps.sh status while lapsed      -> "cre session LAPSED since ..." with the fix
#   L6 an official run                          -> one CRE LOGIN RESTORED push; the lapse state cleared
#   L7 another official run                     -> no second RESTORED; status "valid for at least ..."
#   L8 the official run FAILS (exit 1; the real settle-job.sh writes official-failed), so the next run takes the
#      harness with cre whoami fine -> no CRE LOGIN NEEDED, no lapse state; the exit codes are the job's
#   L9 cre whoami fine, run-official.sh exits 3 (login gone before signing), twice -> nothing, then CRE LOGIN NEEDED at
#      once (the restore reset its dedupe)
#   L10 misses that do not repeat (miss, official, miss, official, miss, official) -> no push at all; status after a
#      single miss says so
#   L11 a miss, then a harness run whose cre whoami answered (after a failed official run) -> the miss is cleared
#   L12 the state lost mid-lapse (var/alerts and the lapse file gone) -> at most one extra push, never a burst;
#      L12b after CRE LOGIN NEEDED, the first run with the login is a harness run -> RESTORED says so, once
#   L13 path decisions and evidence: one evidence record per run, the run-official.sh calls as settle-job.sh decides
#   L14 no output, log or evidence file contains the alert URL
# Part R, vps/relogin.sh with stubs on PATH: `ssh` (never connects; prints what the VPS helper and the CLI print,
#   through a pseudo-terminal: CRLF and colour codes), `open` (records the URL), `uname` (Darwin).
#   R1 --dry-run                                -> prerequisites only, no connection, exit 0
#   R2 the callback port is in use              -> refused (exit 2), ssh never started
#   R3 success                                  -> the exact URL opened, progress streamed, "cre whoami: yes", exit 0;
#                                                  no token, e-mail or URL parameter in the output; the ssh argv; the
#                                                  temp file and the ssh process gone
#   R4 --print-url                              -> the URL printed, `open` not called
#   R5 no browser sign-in before --timeout      -> exit 124, clear message; ssh process and temp file gone
#   R6 no sign-in URL at all                    -> exit 124 after --timeout (URL stage)
#   R7 the VPS answers "cre whoami: no"         -> exit 1, nothing secret in the shown output
#   R8 ssh cannot connect (exit 255)            -> exit 1 with the reason
#   R9 a destination that is an option or has odd characters -> refused, ssh never started
#   R10 Ctrl-C (SIGINT to the whole process group, as a terminal sends it) while waiting for the sign-in -> exit 130;
#      the ssh process (which ignores SIGINT as a background job) stopped, the temp dir gone, nothing secret shown
#   R11 the terminal closes (SIGHUP to the process group) -> the same cleanup
#   R12 Ctrl-C twice, with an ssh that ignores SIGTERM -> the cleanup still completes (kill -9 after 3 s)
#   R13 the callback port held on the IPv6 loopback only -> refused (lsof); skipped where lsof or ::1 is missing
# Usage: vps/test/login-lapse-unit.sh     Env: ISOTHERM_TEST_BASH (default /bin/bash), KEEP=1 keeps the scratch.
# Output: stdout and vps/evidence/login-lapse-unit.txt (local paths replaced by <repo>, <scratch>, ~). Exit 0 = all pass.
set -uo pipefail
REAL="$(cd "$(dirname "$0")/../.." && pwd)"; REPO=$(cd "$REAL/../.." && pwd)
TBASH=${ISOTHERM_TEST_BASH:-/bin/bash}
EVOUT="$REAL/vps/evidence/login-lapse-unit.txt"
SEARCH="$REAL/.tools/bin:$REAL/.tools/node_modules/.bin:$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.local/bin"
BUN=$(PATH=$SEARCH; command -v bun) || { echo "bun not found" >&2; exit 2; }
NODE=$(PATH=$SEARCH; command -v node) || { echo "node not found" >&2; exit 2; }
TMPBASE=${TMPDIR:-/tmp}; SC=$(mktemp -d "${TMPBASE%/}/isotherm-login-lapse.XXXXXX"); SCP=$(cd "$SC" && pwd -P)
cleanup() { [ -n "${LISTENER:-}" ] && kill "$LISTENER" 2>/dev/null; [ "${KEEP:-0}" = 1 ] || rm -rf "$SC"; }
trap cleanup EXIT

main() {
P="$SC/root/packages/cre-workflow"; BIN="$P/.tools/bin"; ST="$SC/state"; SD="$SC/shim"
mkdir -p "$P/vps" "$P/scripts" "$BIN" "$SC/home" "$ST" "$SD"
for f in settle-vps.sh lib.sh isotherm-vps.sh; do ln -s "$REAL/vps/$f" "$P/vps/$f"; done   # the code under test
ln -s "$REAL/scripts/settle-job.sh" "$P/scripts/settle-job.sh"
ln -s "$REAL/settle" "$P/settle"                       # evidence-record.ts (node:fs only)
ln -s "$NODE" "$BIN/node"; ln -s "$BUN" "$BIN/bun"; ln -s "$TBASH" "$BIN/bash"   # nested `bash` = the bash under test
cat >"$BIN/cre" <<'EOF'
#!/bin/bash
# TEST shim of the CRE CLI: no network, never reads or writes ~/.cre
case "$1" in
  version) echo "CRE CLI version v1.37.0" ;;
  whoami) [ "$(cat "${SHIM_DIR:?}/whoami")" = ok ] ;;
  *) echo "shim cre: unexpected: $*" >&2; exit 97 ;;
esac
EOF
cat >"$BIN/curl" <<'EOF'
#!/bin/bash
# TEST shim of curl for push_alert: records title, priority and body; never connects; answers HTTP 200
title=""; prio=""; urlcfg=no
while [ $# -gt 0 ]; do
  case "$1" in
    -H) case "$2" in "Title: "*) title=${2#Title: } ;; "Priority: "*) prio=${2#Priority: } ;; esac; shift ;;
    -K) grep -q '^url = "https://' "$2" && urlcfg=yes; shift ;;
  esac
  shift
done
body=$(cat)
printf '%s\t%s\t%s\t%s\n' "$title" "$prio" "$urlcfg" "$body" >>"${SHIM_DIR:?}/pushes"
printf 200
EOF
cat >"$P/scripts/run-official.sh" <<'EOF'
#!/bin/bash
# TEST stub of scripts/run-official.sh: the log lines of an official or a harness run that had nothing to settle
M=official; for a in "$@"; do case "$a" in --official) M=official ;; --harness) M=harness ;; esac; done
echo "--$M" >>"${SHIM_DIR:?}/run-official-calls"
at() { date -u +%FT%TZ; }
if [ "$M" = official ]; then
  case "$(cat "$SHIM_DIR/official-rc" 2>/dev/null)" in
    3) echo "NOT LOGGED IN TO CRE. (stub)"; exit 3 ;;
    1) echo "[$(at)] OFFICIAL: cre workflow simulate (stub)"; echo "Error: workflow simulation failed (stub)"; echo "[$(at)] run exited 1"; exit 1 ;;
  esac
  echo "[$(at)] mode=official rpc=https://testnet-rpc.monad.xyz cre-login=yes broadcast=1"
  echo "$(at) [USER LOG] nothing to settle (ladders=1, due=0, skipped=0)"
  echo "✓ Workflow Simulation Result:"
  echo '"{\"triggerTime\":\"2026-10-10T09:06:01.000Z\",\"outcomes\":[],\"skipped\":[],\"ladders\":{\"count\":1,\"due\":0}}"'
else
  echo "[$(at)] mode=harness rpc=https://testnet-rpc.monad.xyz cre-login=no broadcast=1"
  echo '[result] {"triggerTime":"2026-10-10T09:06:01.000Z","outcomes":[],"skipped":[],"ladders":{"count":1,"due":0}}'
fi
echo "[$(at)] done; log: (stub)"
EOF
chmod +x "$BIN/cre" "$BIN/curl" "$P/scripts/run-official.sh"
TOPIC="isotherm-test-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 24)"
printf 'https://ntfy.invalid/%s\n' "$TOPIC" >"$SC/alert.url"; chmod 600 "$SC/alert.url"

PASS=0; FAIL=0
ok() { if [ "$1" = 1 ]; then PASS=$((PASS + 1)); echo "  PASS  $2"; else FAIL=$((FAIL + 1)); echo "  FAIL  $2"; fi; }
t() { if "$@"; then echo 1; else echo 0; fi; }   # t <test command>: 1/0 for ok()
NEEDED="ISOTHERM VPS: CRE LOGIN NEEDED"; RESTORED="ISOTHERM VPS: CRE LOGIN RESTORED"
STAMP="$ST/alerts/ISOTHERM_VPS__CRE_LOGIN_NEEDED.last"
pushes() { grep -c "^$1	" "$SD/pushes" 2>/dev/null || true; }    # number of pushes with this exact title
envrun() {
  env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$SC/home" TMPDIR="$SC" SHIM_DIR="$SD" \
    HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 \
    http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 \
    ISOTHERM_STATE_DIR="$ST" ISOTHERM_WRITER_CLAIM_REQUIRED=0 ISOTHERM_TX_KEY_FILE="$SC/no-such.key" \
    ISOTHERM_CRE_API_KEY_FILE="$SC/no-such-api-key" ISOTHERM_ALERT_URL_FILE="$SC/alert.url" "$@"
}
vrun() { # vrun <case>: one run of the real settle-vps.sh; its [vps] ALERT/push lines shown
  envrun "$TBASH" "$P/vps/settle-vps.sh" >"$SC/out-$1.log" 2>&1; local rc=$?
  grep -E '\[settle-job\] path=|\[vps\] (ALERT|push|CRE login)' "$SC/out-$1.log" | sed -E 's/^\[[^]]+\] //; s/^/    | /'
  echo "    exit $rc; lapse state: $(cat "$ST/cre-login-lapsed.json" 2>/dev/null || echo absent)"
  VRC=$rc; RUNS=$((RUNS + 1))
  return $rc
}
RUNS=0; VRC=0
stamp_age() { echo $(($(date +%s) - $1)) >"$STAMP"; }   # stamp_age <seconds>: the last NEEDED push that long ago
lapse_runs() { "$NODE" -e 'try { console.log(require(process.argv[1]).runs || "") } catch { console.log("absent") }' "$ST/cre-login-lapsed.json"; }

echo "# $(date -u +%FT%TZ) login-lapse-unit: $("$TBASH" -c 'echo "bash $BASH_VERSION"') on $(uname -s) $(uname -m); stubs, no network, no key, 0 MON"
echo "# scratch package <scratch>/root/packages/cre-workflow (vps/*.sh, settle-job.sh and settle/ symlinked to the code under test)"

echo; echo "## L1. one miss: cre whoami fails once"
echo fail >"$SD/whoami"; vrun L1
ok "$(t [ "$(pushes "$NEEDED")" = 0 ])" "no CRE LOGIN NEEDED push for a single miss"
ok "$(grep -q 'CRE login: none in this run (cre whoami failed' "$SC/out-L1.log" && echo 1 || echo 0)" "the miss is logged (journal), with the reason"
ok "$(t [ "$(pushes 'ISOTHERM VPS: harness fallback ran (official CRE path unavailable)')" = 1 ])" "the existing harness-fallback push, unchanged"
ok "$(t [ "$(lapse_runs)" = 1 ])" "lapse state recorded, runs=1: $(cat "$ST/cre-login-lapsed.json" 2>/dev/null)"

echo; echo "## L2. a second miss in a row: CRE LOGIN NEEDED"
vrun L2
ok "$(t [ "$(pushes "$NEEDED")" = 1 ])" "one CRE LOGIN NEEDED push"
L=$(grep "^$NEEDED	" "$SD/pushes" | head -n1)
ok "$(t [ "$(printf '%s' "$L" | cut -f2)" = high ])" "priority high"
ok "$(printf '%s' "$L" | cut -f4 | grep -qE '^The CRE login on the VPS has lapsed: 2 runs in a row without it, since 20[0-9-]{8}T[0-9:]{8}Z \(this run: cre whoami failed' && printf '%s' "$L" | cut -f4 | grep -q 'Settlement continues on the labelled harness fallback' && printf '%s' "$L" | cut -f4 | grep -qF 'Fix, one line on the Mac: packages/cre-workflow/vps/relogin.sh isotherm-vps' && echo 1 || echo 0)" "the body: how many runs, since when and why; settlement continues on the labelled harness; the one-line fix"
echo "    body: $(printf '%s' "$L" | cut -f4)"
ok "$(t [ "$("$NODE" -e 'console.log(require(process.argv[1]).at)' "$ST/cre-login-lapsed.json")" = "$(head -n1 "$ST/evidence/settle-runs.jsonl" | "$NODE" -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).startedAt)')" ])" "'since' is the first miss's start, kept across runs"

echo; echo "## L3. a third miss: not repeated within 3 h"
vrun L3
ok "$(t [ "$(pushes "$NEEDED")" = 1 ])" "still one push"
ok "$(t [ "$(grep -c "	$NEEDED	" "$ST/alerts/ALERTS.log")" = 2 ])" "both attempts (runs 2 and 3) are in ALERTS.log"

echo; echo "## L4. the push stamp aged 2 h 59 min, then 3 h 1 min"
stamp_age 10740; vrun L4a
ok "$(t [ "$(pushes "$NEEDED")" = 1 ])" "2 h 59 min: not pushed"
stamp_age 10860; vrun L4b
ok "$(t [ "$(pushes "$NEEDED")" = 2 ])" "3 h 1 min: pushed again"

echo; echo "## L5. isotherm-vps.sh status while lapsed"
envrun "$TBASH" "$P/vps/isotherm-vps.sh" status >"$SC/status-L5.txt" 2>&1
grep -E '^(cre login|cre session|phone push)' "$SC/status-L5.txt" | sed 's/^/    | /'
ok "$(grep -E '^cre session LAPSED since .*5 harness runs in a row.*Fix, on the Mac: packages/cre-workflow/vps/relogin.sh isotherm-vps' "$SC/status-L5.txt" >/dev/null && echo 1 || echo 0)" "cre session LAPSED, 5 harness runs in a row, the fix named"

echo; echo "## L6. the login is back: an official run"
echo ok >"$SD/whoami"; vrun L6
ok "$(t [ "$(pushes "$RESTORED")" = 1 ])" "one CRE LOGIN RESTORED push"
echo "    body: $(grep "^$RESTORED	" "$SD/pushes" | head -n1 | cut -f4)"
ok "$(grep "^$RESTORED	" "$SD/pushes" | head -n1 | cut -f2,4 | grep -qE '^default	The official CRE path ran again at 20[0-9-]{8}T[0-9:]{8}Z; the login had lapsed from 20[0-9-]{8}T[0-9:]{8}Z \([0-9]+ min on the harness\)' && echo 1 || echo 0)" "priority default; the body names when the lapse began and how long it lasted"
ok "$([ ! -f "$ST/cre-login-lapsed.json" ] && [ ! -f "$STAMP" ] && echo 1 || echo 0)" "lapse state and the CRE LOGIN NEEDED stamp cleared"
ok "$(t [ "$(pushes "$NEEDED")" = 2 ])" "no CRE LOGIN NEEDED on an official run"

echo; echo "## L7. another official run: RESTORED is not repeated"
vrun L7
ok "$(t [ "$(pushes "$RESTORED")" = 1 ])" "still one RESTORED push"
envrun "$TBASH" "$P/vps/isotherm-vps.sh" status >"$SC/status-L7.txt" 2>&1
grep -E '^(cre login|cre session)' "$SC/status-L7.txt" | sed 's/^/    | /'
ok "$(grep -qE '^cre session valid for at least [0-9]+ min: official runs from .* to .*, the last one [0-9]+ min ago; after the miss seen at ' "$SC/status-L7.txt" && echo 1 || echo 0)" "cre session: valid for at least ..., after the lapse"

echo; echo "## L8. the official run fails (exit 1), so the next run takes the harness with cre whoami fine: not a lapse"
echo 1 >"$SD/official-rc"; vrun L8a; R1=$VRC; rm -f "$SD/official-rc"
ok "$([ "$R1" = 1 ] && [ -f "$ST/official-failed" ] && [ "$(pushes 'ISOTHERM VPS: settle job exit 1')" = 1 ] && echo 1 || echo 0)" "official run exit 1: settle-vps.sh exits 1 (the job's code), settle-job.sh wrote official-failed, the existing 'settle job exit 1' push"
vrun L8b; R2=$VRC
ok "$(grep -q 'previous OFFICIAL run failed' "$SC/out-L8b.log" && [ ! -f "$ST/official-failed" ] && [ "$R2" = 0 ] && echo 1 || echo 0)" "the next run took the harness (settle-job.sh's rule, unchanged), exit 0"
ok "$([ "$(pushes "$NEEDED")" = 2 ] && [ ! -f "$ST/cre-login-lapsed.json" ] && echo 1 || echo 0)" "no CRE LOGIN NEEDED, no lapse state"
envrun "$TBASH" "$P/vps/isotherm-vps.sh" status >"$SC/status-L8.txt" 2>&1
grep -E '^cre session' "$SC/status-L8.txt" | sed 's/^/    | /'
ok "$(grep -qE '^cre session valid for at least' "$SC/status-L8.txt" && echo 1 || echo 0)" "status still: valid"

echo; echo "## L9. cre whoami fine, but run-official.sh exits 3 (the login vanished before signing), twice"
echo 3 >"$SD/official-rc"; vrun L9a
ok "$(grep -q 'reported no login (exit 3)' "$SC/out-L9a.log" && [ "$(pushes "$NEEDED")" = 2 ] && [ "$(lapse_runs)" = 1 ] && echo 1 || echo 0)" "the first exit 3 counts as a miss, no push"
vrun L9b; rm -f "$SD/official-rc"
ok "$([ "$(pushes "$NEEDED")" = 3 ] && echo 1 || echo 0)" "the second: CRE LOGIN NEEDED pushed at once (the restore reset the 3 h dedupe)"
vrun L9c
ok "$(t [ "$(pushes "$RESTORED")" = 2 ])" "official again: RESTORED"

echo; echo "## L10. misses that do not repeat (a CRE API timeout now and then): miss, official, miss, official, miss, official"
N0=$(pushes "$NEEDED"); R0=$(pushes "$RESTORED")
for i in 1 2 3; do echo fail >"$SD/whoami"; vrun "L10m$i"; echo ok >"$SD/whoami"
  [ "$i" = 3 ] && { envrun "$TBASH" "$P/vps/isotherm-vps.sh" status >"$SC/status-L10.txt" 2>&1; grep -E '^cre session' "$SC/status-L10.txt" | sed 's/^/    | /'; }
  vrun "L10o$i"; done
ok "$([ "$(pushes "$NEEDED")" = "$N0" ] && [ "$(pushes "$RESTORED")" = "$R0" ] && [ ! -f "$ST/cre-login-lapsed.json" ] && echo 1 || echo 0)" "no CRE LOGIN NEEDED and no RESTORED push at all; no lapse state left"
ok "$(grep -c 'there again at .* after a single miss' "$SC"/out-L10o*.log | awk -F: '{ s += $2 } END { print (s == 3) ? 1 : 0 }')" "each recovery logged as 'after a single miss; nothing was pushed'"
ok "$(grep -qE '^cre session no login in the last run \(.*harness\); a single miss is often a CRE API timeout, so CRE LOGIN NEEDED waits for the next run' "$SC/status-L10.txt" && echo 1 || echo 0)" "status after a single miss says so (not LAPSED)"

echo; echo "## L11. a miss, then a harness run whose cre whoami answered (after a failed official run): the miss is cleared"
echo 1 >"$SD/official-rc"; vrun L11a; rm -f "$SD/official-rc"          # official fails: official-failed written
echo fail >"$SD/whoami"; vrun L11b                                    # a miss (official-failed is kept)
echo ok >"$SD/whoami"; vrun L11c                                      # whoami answers; the harness runs (official-failed)
ok "$(grep -q 'previous OFFICIAL run failed' "$SC/out-L11c.log" && [ ! -f "$ST/cre-login-lapsed.json" ] && echo 1 || echo 0)" "the miss is cleared by the run whose cre whoami answered"
envrun "$TBASH" "$P/vps/isotherm-vps.sh" status >"$SC/status-L11.txt" 2>&1
grep -E '^cre session' "$SC/status-L11.txt" | sed 's/^/    | /'
ok "$(grep -qE '^cre session cre whoami answered at .*, after the miss seen at .*; no official run since that miss' "$SC/status-L11.txt" && echo 1 || echo 0)" "status: cre whoami answered after the miss, no official run since"
echo fail >"$SD/whoami"; vrun L11d; echo ok >"$SD/whoami"
ok "$([ "$(pushes "$NEEDED")" = "$N0" ] && [ "$(lapse_runs)" = 1 ] && echo 1 || echo 0)" "the next miss starts again at runs=1: no push"
vrun L11e
ok "$([ "$(pushes "$RESTORED")" = "$R0" ] && [ ! -f "$ST/cre-login-lapsed.json" ] && echo 1 || echo 0)" "an official run clears it silently (no RESTORED for a miss that was never pushed)"

echo; echo "## L12. the state is lost mid-lapse (var/alerts and the lapse file wiped): at most one extra push"
echo fail >"$SD/whoami"; vrun L12a; vrun L12b; N1=$(pushes "$NEEDED")
ok "$(t [ "$N1" = $((N0 + 1)) ])" "two misses: one push"
rm -rf "$ST/alerts" "$ST/cre-login-lapsed.json"
vrun L12c; N2=$(pushes "$NEEDED")
vrun L12d; N3=$(pushes "$NEEDED")
vrun L12e; N4=$(pushes "$NEEDED")
ok "$([ "$N2" = "$N1" ] && [ "$N3" = $((N1 + 1)) ] && [ "$N4" = "$N3" ] && [ -d "$ST/alerts" ] && echo 1 || echo 0)" "after the wipe: no push, then one, then deduplicated again ($N1 -> $N2 -> $N3 -> $N4)"
echo ok >"$SD/whoami"; vrun L12f
ok "$(t [ "$(pushes "$RESTORED")" = $((R0 + 1)) ])" "RESTORED once when the login is back"

echo; echo "## L12b. after CRE LOGIN NEEDED, the first run with the login is a harness run (after a failed official run)"
echo 1 >"$SD/official-rc"; vrun L12g; rm -f "$SD/official-rc"          # official fails: official-failed written
echo fail >"$SD/whoami"; vrun L12h; vrun L12i                          # two misses: NEEDED (the restore reset the dedupe)
echo ok >"$SD/whoami"; vrun L12j                                      # whoami answers; the harness runs (official-failed)
L=$(grep "^$RESTORED	" "$SD/pushes" | tail -n1 | cut -f4)
ok "$([ "$(pushes "$NEEDED")" = $((N3 + 1)) ] && [ "$(pushes "$RESTORED")" = $((R0 + 2)) ] && printf '%s' "$L" | grep -q '^cre whoami answered again at .*this run still took the harness, after a failed official run' && [ ! -f "$ST/cre-login-lapsed.json" ] && echo 1 || echo 0)" "NEEDED, then RESTORED saying the harness ran this time; state cleared"
echo "    body: $L"
vrun L12k
ok "$(t [ "$(pushes "$RESTORED")" = $((R0 + 2)) ])" "the official run after it: no second RESTORED"

echo; echo "## L13. path decisions and evidence unchanged by the watch"
EV=$(wc -l <"$ST/evidence/settle-runs.jsonl" | tr -d ' ')
ok "$(t [ "$EV" = "$RUNS" ])" "one evidence record per run ($EV records, $RUNS runs)"
CALLS=$(tr '\n' ' ' <"$SD/run-official-calls")
EXPECT=$("$NODE" -e '
  // what settle-job.sh decides from each record: official when it took the official path; harness otherwise; an
  // official run that exited 3 is followed by a harness run in the same job
  const out = []; for (const l of require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n")) { const r = JSON.parse(l);
    if (r.path === "official") out.push("--official"); else if (/exit 3/.test(r.pathReason)) out.push("--official", "--harness"); else out.push("--harness") }
  console.log(out.join(" ") + " ")' "$ST/evidence/settle-runs.jsonl")
ok "$(t [ "$CALLS" = "$EXPECT" ])" "run-official.sh was called exactly as the evidence records say ($(echo "$CALLS" | wc -w | tr -d ' ') calls)"
ok "$(grep -q '\[settle-job\] path=harness (cre whoami failed' "$SC/out-L1.log" && grep -q '\[settle-job\] path=official (cre whoami succeeded)' "$SC/out-L6.log" && echo 1 || echo 0)" "a whoami failure still selects the harness, a whoami success the official path"

echo; echo "## L14. the alert URL never reaches an output, a log or an evidence file"
N=$(grep -rlF "$TOPIC" "$SC"/out-*.log "$SC"/status-*.txt "$ST" 2>/dev/null | wc -l | tr -d ' ')
ok "$([ "$N" = 0 ] && [ "$(cut -f3 "$SD/pushes" | sort -u)" = yes ] && echo 1 || echo 0)" "0 files contain it; every push read it from the file (curl -K)"

# ---------------------------------------------------------------------------------------------------- relogin.sh
SB="$SC/stubbin"; RD="$SC/relogin-shim"; RT="$SC/relogin-tmp"; mkdir -p "$SB" "$RD" "$RT"
cat >"$SB/ssh" <<'EOF'
#!/bin/bash
# TEST stub of ssh for relogin.sh: never connects
D=${SHIM_DIR:?}
if [ "${1:-}" = -G ]; then for a in "$@"; do h=$a; done; [ "$h" = isotherm-test ] && h=test-host.invalid; printf 'hostname %s\nport 22\n' "$h"; exit 0; fi
echo "$$" >"$D/ssh-pid"; printf '%s\n' "$@" >"$D/ssh-argv"; [ -t 0 ] && echo "stdin was a terminal" >"$D/ssh-stdin"
sleep 1.2   # a connection takes a moment: relogin.sh's first passes see an empty output file
[ "$RELOGIN_STUB" = connect-fail ] && { echo "ssh: connect to host test-host.invalid port 22: Connection refused" >&2; exit 255; }
# what the VPS helper prints first, then the CLI, through a pseudo-terminal (CRLF, colour codes)
printf 'CRE login on a headless VPS (the CLI waits for the browser on http://localhost:53682/callback ON THIS VPS):\r\n'
printf '  2. The CLI prints "Opening browser to: https://login.chain.link/authorize?..." and "Could not open browser\r\n'
[ "$RELOGIN_STUB" = silent ] && exec sleep 300
printf '\033[1mCRE Login\033[0m\r\n  Authenticate with your Chainlink account\r\n \033[36mOpening browser to:\033[0m\r\n'
printf '\033]8;;%s\033\\%s\033]8;;\033\\\r\n' "$FAKE_URL" "$FAKE_URL"
printf '\033[33m! Could not open browser automatically\033[0m\r\n  Please open the URL above in your browser\r\n'
printf '  Waiting for authentication... (Press Ctrl+C to cancel)\r\n'
[ "$RELOGIN_STUB" = hang ] && exec sleep 300
[ "$RELOGIN_STUB" = stubborn ] && { trap '' TERM; exec sleep 300; }   # an ssh slow to stop: SIGTERM ignored
for _ in $(seq 1 50); do [ -f "$D/opened" ] && break; [ "${STUB_NO_OPEN:-0}" = 1 ] && break; sleep 0.1; done
printf 'refresh_token: %s\r\n' "$FAKE_TOKEN"
printf '\033[32m✓ Login successful\033[0m (tester@example.com, org %s)\r\n' "$FAKE_ORG"
case "$RELOGIN_STUB" in ok) printf 'cre whoami: yes\r\n' ;; *) printf 'cre whoami: no\r\n' ;; esac
EOF
printf '#!/bin/bash\nprintf "%%s\\n" "$*" >"${SHIM_DIR:?}/open-args"; touch "$SHIM_DIR/opened"\n' >"$SB/open"
printf '#!/bin/bash\necho Darwin\n' >"$SB/uname"
chmod +x "$SB/ssh" "$SB/open" "$SB/uname"
FAKE_URL="https://login.chain.link/authorize?audience=https%3A%2F%2Fapi.cre.chain.link%2F&client_id=TESTCLIENTID0001&code_challenge=TESTCHALLENGE0001&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A53682%2Fcallback&response_type=code&scope=openid+profile+email+offline_access&state=TESTSTATE0001"
FAKE_TOKEN="eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LW9ubHkifQ.dGVzdC1zaWduYXR1cmUtbm90LXJlYWw"
FAKE_ORG="org_TESTONLY0123456789abcdefghijklmnop"
FREEPORT=$("$NODE" -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close() })')
rr() { # rr <case> <stub scenario> [relogin args...]: the real relogin.sh; its output in $SC/relogin-<case>.txt
  local c=$1 s=$2; shift 2
  rm -f "$RD"/*
  env -i PATH="$SB:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$SC/home" TMPDIR="$RT" SHIM_DIR="$RD" RELOGIN_STUB="$s" \
    FAKE_URL="$FAKE_URL" FAKE_TOKEN="$FAKE_TOKEN" FAKE_ORG="$FAKE_ORG" STUB_NO_OPEN="${STUB_NO_OPEN:-0}" \
    ISOTHERM_RELOGIN_PORT="${RPORT:-$FREEPORT}" "$TBASH" "$REAL/vps/relogin.sh" "$@" >"$SC/relogin-$c.txt" 2>&1 </dev/null
  RC=$?; sed -E 's/^\[[^]]+\] //; s/^/    | /' "$SC/relogin-$c.txt"; echo "    exit $RC"
}
gone() { # the stub ssh process is not running and the private temp dir is empty
  local p; p=$(cat "$RD/ssh-pid" 2>/dev/null); { [ -z "$p" ] || ! kill -0 "$p" 2>/dev/null; } && [ -z "$(ls -A "$RT")" ]
}
secretfree() { ! grep -qE "eyJ|$FAKE_TOKEN|tester@example\.com|TESTONLY|TESTSTATE|TESTCHALLENGE|client_id=" "$SC/relogin-$1.txt"; }

echo; echo "## R1. relogin.sh --dry-run: prerequisites only"
rr R1 ok isotherm-test --dry-run
ok "$([ "$RC" = 0 ] && grep -q 'DRY RUN: nothing started' "$SC/relogin-R1.txt" && [ ! -f "$RD/ssh-argv" ] && echo 1 || echo 0)" "exit 0, no connection started"

echo; echo "## R2. the callback port is in use on this machine"
"$NODE" -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$FREEPORT" & LISTENER=$!
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$FREEPORT") 2>/dev/null && break; sleep 0.1; done
rr R2 ok isotherm-test
kill "$LISTENER" 2>/dev/null; wait "$LISTENER" 2>/dev/null; LISTENER=""
ok "$([ "$RC" = 2 ] && grep -q "FAIL     port $FREEPORT: something on this machine already listens" "$SC/relogin-R2.txt" && [ ! -f "$RD/ssh-argv" ] && echo 1 || echo 0)" "refused (exit 2), ssh never started"

echo; echo "## R3. the sign-in completes"
rr R3 ok isotherm-test
ok "$([ "$RC" = 0 ] && grep -q "SIGNED IN: the VPS answered 'cre whoami: yes'" "$SC/relogin-R3.txt" && grep -q 'vps | cre whoami: yes' "$SC/relogin-R3.txt" && echo 1 || echo 0)" "exit 0, 'cre whoami: yes' shown"
ok "$(t [ "$(cat "$RD/open-args" 2>/dev/null)" = "$FAKE_URL" ])" "\`open\` got the exact sign-in URL (terminal codes stripped)"
ok "$(grep -q 'vps | *Waiting for authentication' "$SC/relogin-R3.txt" && grep -q 'vps | <sign-in URL>' "$SC/relogin-R3.txt" && ! grep -q 'headless VPS' "$SC/relogin-R3.txt" && echo 1 || echo 0)" "the CLI's progress streamed (the URL masked; the helper's manual instructions skipped)"
ok "$(t secretfree R3)" "no token, e-mail, org id or URL parameter in the output"
ok "$(! grep -qE '(^|: )(head|sed|grep|perl|wc):|line [0-9]+:|integer expression' "$SC/relogin-R3.txt" && echo 1 || echo 0)" "no tool or shell error in the output (the first passes saw an empty file)"
ARGV=$(tr '\n' ' ' <"$RD/ssh-argv")
echo "    ssh argv: $ARGV"
argv_ok() { case " $ARGV" in *" -tt "*"-o BatchMode=yes"*"-o ExitOnForwardFailure=yes"*"-L $FREEPORT:127.0.0.1:53682 isotherm-test stty cols 1000 2>/dev/null; bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh login ") return 0 ;; esac; return 1; }
ok "$(t argv_ok)" "ssh -tt, BatchMode, ExitOnForwardFailure, -L <port>:127.0.0.1:53682, the alias, isotherm-vps.sh login"
ok "$(t [ ! -f "$RD/ssh-stdin" ])" "ssh's stdin is not the terminal (nothing is typed on the VPS)"
sleep 0.5; ok "$(t gone)" "ssh process gone, temp dir empty"
ok "$([ -z "$(grep -rlF TESTSTATE "$SC/home" "$RT" 2>/dev/null)" ] && echo 1 || echo 0)" "the sign-in URL is in no file under HOME or TMPDIR afterwards (it lived only in the private temp file)"

echo; echo "## R4. --print-url: the URL printed instead of opened"
STUB_NO_OPEN=1 rr R4 ok isotherm-test --print-url
ok "$([ "$RC" = 0 ] && [ ! -f "$RD/open-args" ] && [ "$(grep -cxF "  $FAKE_URL" "$SC/relogin-R4.txt")" = 1 ] && echo 1 || echo 0)" "exit 0, \`open\` not called, the URL printed once"

echo; echo "## R5. no browser sign-in before --timeout 4"
S=$(date +%s); rr R5 hang isotherm-test --timeout 4; E=$(($(date +%s) - S))
ok "$([ "$RC" = 124 ] && grep -q 'TIMED OUT after 4 s waiting for the browser sign-in' "$SC/relogin-R5.txt" && [ "$E" -le 12 ] && echo 1 || echo 0)" "exit 124 after ${E} s, a clear message"
ok "$(t gone)" "ssh process gone, temp dir empty"

echo; echo "## R6. no sign-in URL at all before --timeout 3"
rr R6 silent isotherm-test --timeout 3
ok "$([ "$RC" = 124 ] && grep -q 'TIMED OUT after 3 s waiting for the sign-in URL' "$SC/relogin-R6.txt" && [ ! -f "$RD/open-args" ] && gone && echo 1 || echo 0)" "exit 124 (URL stage), nothing opened, cleaned up"

echo; echo "## R7. the VPS answers 'cre whoami: no'"
rr R7 no isotherm-test
ok "$([ "$RC" = 1 ] && grep -q "answered 'cre whoami: no'" "$SC/relogin-R7.txt" && echo 1 || echo 0)" "exit 1"
ok "$(t secretfree R7)" "the failure output shows nothing secret"

echo; echo "## R8. ssh cannot connect"
rr R8 connect-fail isotherm-test
ok "$([ "$RC" = 1 ] && grep -q 'ssh could not connect' "$SC/relogin-R8.txt" && echo 1 || echo 0)" "exit 1 with the reason"

echo; echo "## R9. destinations that are options or carry odd characters"
rr R9a ok '-oProxyCommand=false'; A=$RC
rr R9b ok 'isotherm-test;id'; B=$RC
ok "$([ "$A" = 2 ] && [ "$B" = 2 ] && [ ! -f "$RD/ssh-argv" ] && echo 1 || echo 0)" "both refused (exit 2), ssh never started"

rr_bg() { # rr_bg <case> <stub scenario> [relogin args...]: the real relogin.sh as a terminal's foreground job would run
  # it (its own process group, SIGINT/SIGHUP/SIGTERM at their defaults; a test's background job would ignore SIGINT)
  local c=$1 s=$2; shift 2
  rm -f "$RD"/*
  env -i PATH="$SB:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$SC/home" TMPDIR="$RT" SHIM_DIR="$RD" RELOGIN_STUB="$s" \
    FAKE_URL="$FAKE_URL" FAKE_TOKEN="$FAKE_TOKEN" FAKE_ORG="$FAKE_ORG" STUB_NO_OPEN=0 ISOTHERM_RELOGIN_PORT="$FREEPORT" \
    perl -e 'setpgrp(0, 0); $SIG{$_} = "DEFAULT" for qw(INT HUP TERM QUIT); exec @ARGV' "$TBASH" "$REAL/vps/relogin.sh" "$@" \
    >"$SC/relogin-$c.txt" 2>&1 </dev/null &
  BGPID=$!
  for _ in $(seq 1 100); do [ -f "$RD/opened" ] && break; sleep 0.1; done   # the browser opened: now waiting for the sign-in
}
bg_end() { # bg_end <case>: wait for relogin.sh, show its output
  wait "$BGPID"; RC=$?; sed -E 's/^\[[^]]+\] //; s/^/    | /' "$SC/relogin-$1.txt"; echo "    exit $RC"
}

echo; echo "## R10. Ctrl-C while waiting for the browser sign-in (SIGINT to the whole process group)"
rr_bg R10 hang isotherm-test --timeout 60; SSHP=$(cat "$RD/ssh-pid" 2>/dev/null)
kill -INT -- -"$BGPID"; bg_end R10
ok "$([ "$RC" = 130 ] && grep -q 'interrupted: stopping ssh' "$SC/relogin-R10.txt" && [ -n "$SSHP" ] && echo 1 || echo 0)" "exit 130, 'interrupted' (the ssh stub had started: pid file present)"
sleep 0.3; ok "$(gone && secretfree R10 && echo 1 || echo 0)" "ssh process gone (it ignores SIGINT as a background job; the trap stopped it), temp dir empty, nothing secret shown"

echo; echo "## R11. the terminal closes while waiting (SIGHUP to the process group)"
rr_bg R11 hang isotherm-test --timeout 60
kill -HUP -- -"$BGPID"; bg_end R11
sleep 0.3; ok "$([ "$RC" = 130 ] && gone && echo 1 || echo 0)" "exit 130, ssh process gone, temp dir empty"

echo; echo "## R12. Ctrl-C twice, with an ssh that ignores SIGTERM"
S=$(date +%s); rr_bg R12 stubborn isotherm-test --timeout 60
kill -INT -- -"$BGPID"; sleep 0.8; kill -INT -- -"$BGPID" 2>/dev/null; bg_end R12; E=$(($(date +%s) - S))
sleep 0.3; ok "$([ "$RC" = 130 ] && gone && [ "$E" -le 15 ] && echo 1 || echo 0)" "exit 130 after ${E} s; the cleanup finished (kill -9): ssh process gone, temp dir empty"

echo; echo "## R13. the callback port held on the IPv6 loopback only"
if command -v lsof >/dev/null 2>&1 && "$NODE" -e 'const s = require("net").createServer().on("error", () => process.exit(1)).listen(0, "::1", () => s.close())' 2>/dev/null; then
  "$NODE" -e 'require("net").createServer().listen(Number(process.argv[1]), "::1")' "$FREEPORT" & LISTENER=$!
  for _ in $(seq 1 50); do lsof -nP -iTCP:"$FREEPORT" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.1; done
  rr R13 ok isotherm-test
  kill "$LISTENER" 2>/dev/null; wait "$LISTENER" 2>/dev/null; LISTENER=""
  ok "$([ "$RC" = 2 ] && grep -q "FAIL     port $FREEPORT" "$SC/relogin-R13.txt" && [ ! -f "$RD/ssh-argv" ] && echo 1 || echo 0)" "refused (exit 2), ssh never started"
else echo "  SKIP  no lsof or no IPv6 loopback here (the /dev/tcp probe covers 127.0.0.1 only)"; fi

echo; echo "# $(date -u +%FT%TZ) done: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
}

main 2>&1 | tee "$SC/report.txt"; RC=${PIPESTATUS[0]}
mkdir -p "$(dirname "$EVOUT")"
sed -e "s#$SCP#<scratch>#g" -e "s#$SC#<scratch>#g" -e "s#$REPO#<repo>#g" -e "s#$HOME#~#g" "$SC/report.txt" >"$EVOUT"
echo "-> vps/evidence/login-lapse-unit.txt"
exit "$RC"
