#!/usr/bin/env bash
# shellcheck disable=SC2001  # `echo "$OUT" | sed` indents multi-line output on purpose
# TEST ONLY. Runs ON the (test) VPS as the job's user, in a login session (ssh), after vps/setup.sh --with-anvil.
# Drives the INSTALLED systemd user unit isotherm-settle.service against an anvil fork of LIVE Monad testnet, with
# public anvil dev keys installed on the fork by impersonating the owner (nothing live is signed or sent):
#   S0 no claim -> refused, 0 txs          S1 claim + previous writer ran 10 min ago -> refused (50-min guard)
#   S2 previous writer 55 min ago -> the job runs: no CRE login -> labelled HARNESS fallback settles RCSS 2026-10-09
#      on the fork (ISOTHERM_TEST_RELABEL serves the live Oct 8 archive as Oct 9; fork only); evidence host=vps; push
#   S3 again at once -> the 30-min spacing guard skips, 0 txs
#   S4 "another host" sends from the same key -> WRITER CONFLICT before signing, sticky, alert pushed
#   S5 next run still refused, alert not repeated (dedupe)    S6 clear-conflict re-baselines
#   S7 another host sends DURING a run -> conflict detected after the run
#   S8 release -> var/writer.released: a broadcasting run-official.sh refuses; a dry run still works
#   S9 the timer itself starts the service (temporary every-minute drop-in), then the :05 schedule is back
# Env: ISOTHERM_FORK_URL (default the Ankr Monad testnet RPC, so the official RPC's per-IP limit is not touched),
#      PORT (default 19350). Output: stdout (the runner saves it to vps/evidence/).
set -uo pipefail
PKG="$HOME/isotherm/packages/cre-workflow"
export PATH="$PKG/.tools/bin:$PATH"
PORT=${PORT:-19350}; RPC="http://127.0.0.1:$PORT"; APORT=$((PORT + 1))
FORK_URL=${ISOTHERM_FORK_URL:-https://rpc.ankr.com/monad_testnet}
T="$HOME/fork-test"; ST="$T/state"
DEP="$PKG/../../deployments/testnet.json"
jd() { node -e 'console.log(process.argv[2].split(".").reduce((o,k)=>o[k],require(process.argv[1])))' "$DEP" "$1"; }
RESOLVER=$(jd resolver); OWNER=$(jd roles.owner)
ATT9_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6; ATT9=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
# The tx sender is a FRESH random key per run (never printed): the public anvil dev keys carry EIP-7702 delegations on
# live Monad testnet (a plain transfer from anvil #1 uses 37,988 gas and a sweeper empties the account on the fork).
read -r TX1 TX1_KEY < <(cast wallet new 2>/dev/null | tail -n1)   # stdout: "<address>\t<key>"
case "$TX1:$TX1_KEY" in 0x????????????????????????????????????????:0x*) ;; *) echo "could not create a throwaway key" >&2; exit 1 ;; esac
SINK=0x000000000000000000000000000000000000dEaD
PASS=0; FAIL=0
ok() { if [ "$1" = 1 ]; then PASS=$((PASS + 1)); echo "  PASS  $2"; else FAIL=$((FAIL + 1)); echo "  FAIL  $2"; fi; }
nonce() { cast nonce "$TX1" --rpc-url "$RPC"; }
res() { cast call "$RESOLVER" 'resultOf(bytes4,uint32)((uint8,int16,uint64,uint64,bytes32))' 0x52435353 20261009 --rpc-url "$RPC"; }
alerts() { [ -f "$T/alerts.jsonl" ] && wc -l <"$T/alerts.jsonl" | tr -d ' ' || echo 0; }
cursor() { journalctl --user -u isotherm-settle -n 1 --show-cursor --no-pager -o cat 2>/dev/null | sed -n 's/^-- cursor: //p'; }
since_cursor() { if [ -n "$1" ]; then journalctl --user -u isotherm-settle --after-cursor "$1" --no-pager -o cat 2>/dev/null; else journalctl --user -u isotherm-settle --no-pager -o cat 2>/dev/null; fi; }
run_unit() { # start the oneshot unit, wait, print this run's journal lines and the result
  local c; c=$(cursor)
  systemctl --user start isotherm-settle.service; local rc=$?
  since_cursor "$c" \
    | grep -E '\[vps\]|settle-job\]|\[path\]|\[sent\]|SKIPPED|REFUSED|block .* status=|\[evidence\]|last run|preflight|attester .* ==' | sed 's/^/    | /'
  echo "    unit: start rc=$rc, Result=$(systemctl --user show isotherm-settle.service -p Result --value), ExecMainStatus=$(systemctl --user show isotherm-settle.service -p ExecMainStatus --value)"
  return $rc
}
cleanup() {
  kill "$ANVIL_PID" "$STUB_PID" 2>/dev/null || true
  rm -rf "$HOME/.config/systemd/user/isotherm-settle.service.d" "$HOME/.config/systemd/user/isotherm-settle.timer.d"
  systemctl --user daemon-reload; systemctl --user disable --now isotherm-settle.timer >/dev/null 2>&1 || true
  rm -rf "$T/keys"
}
trap cleanup EXIT

echo "# $(date -u +%FT%TZ) e2e-systemd-fork on $(. /etc/os-release; echo "$PRETTY_NAME") $(uname -m), systemd $(systemctl --version | head -1 | awk '{print $2}'), user $(id -un) (uid $(id -u)), linger $(loginctl show-user "$(id -un)" -p Linger --value)"
rm -rf "$T"; mkdir -p "$T/keys" "$ST"
anvil --fork-url "$FORK_URL" --port "$PORT" --silent >"$T/anvil.log" 2>&1 & ANVIL_PID=$!
node -e '
  const fs = require("fs"), f = process.argv[1];
  require("http").createServer((q, s) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), title: q.headers.title, priority: q.headers.priority, body: b }) + "\n"); s.end("ok") }) })
  .listen(Number(process.argv[2]), "127.0.0.1")' "$T/alerts.jsonl" "$APORT" & STUB_PID=$!
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
echo "# anvil fork of live testnet via the Ankr RPC: chain $(cast chain-id --rpc-url "$RPC"), block $(cast block-number --rpc-url "$RPC"); alert stub on 127.0.0.1:$APORT"
printf '%s' "$ATT9_KEY" >"$T/keys/attester.key"; printf '%s' "$TX1_KEY" >"$T/keys/tx.key"; chmod 600 "$T/keys/"*.key
printf 'http://127.0.0.1:%s/isotherm-test\n' "$APORT" >"$T/alert.url"; chmod 600 "$T/alert.url"
cast rpc anvil_impersonateAccount "$OWNER" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$TX1" 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null
cast send --unlocked --from "$OWNER" "$RESOLVER" "setAttester(address)" "$ATT9" --rpc-url "$RPC" >/dev/null
W=$(node -e 'console.log(Date.parse("2026-10-09T18:05:00Z")/1000)')
cast rpc evm_setNextBlockTimestamp "$W" --rpc-url "$RPC" >/dev/null; cast rpc anvil_mine 0x50 0x1 --rpc-url "$RPC" >/dev/null
echo "# fork only: Resolver.attester -> $(cast call "$RESOLVER" 'attester()(address)' --rpc-url "$RPC") (anvil #9), tx sender $TX1 (fresh random key, 1 MON); chain time $(node -e 'console.log(new Date(Number(process.argv[1])*1000).toISOString())' "$(cast block latest --field timestamp --rpc-url "$RPC")") = 02:0x Taipei, Oct 10"
echo "# live ladder RCSS 2026-10-09 before: resultOf = $(res)"
mkdir -p "$HOME/.config/systemd/user/isotherm-settle.service.d"
cat >"$HOME/.config/systemd/user/isotherm-settle.service.d/fork-test.conf" <<EOF
# TEST ONLY drop-in: the installed unit, pointed at the anvil fork, test keys and a test state dir
[Service]
Environment=ISOTHERM_RPC=$RPC
Environment=ISOTHERM_ATTESTER_KEY_FILE=$T/keys/attester.key
Environment=ISOTHERM_TX_KEY_FILE=$T/keys/tx.key
Environment=ISOTHERM_STATE_DIR=$ST
Environment=ISOTHERM_TEST_RELABEL=RCSS:2026-10-09=2026-10-08
Environment=ISOTHERM_ALERT_URL_FILE=$T/alert.url
EOF
systemctl --user daemon-reload
echo "# unit under test: $(systemctl --user show isotherm-settle.service -p FragmentPath --value) + drop-in $(systemctl --user show isotherm-settle.service -p DropInPaths --value)"
VH() { ISOTHERM_STATE_DIR=$ST ISOTHERM_RPC=$RPC ISOTHERM_ATTESTER_KEY_FILE=$T/keys/attester.key ISOTHERM_TX_KEY_FILE=$T/keys/tx.key ISOTHERM_ALERT_URL_FILE=$T/alert.url bash "$PKG/vps/isotherm-vps.sh" "$@"; }

echo; echo "## S0. no claim: the unit refuses, nothing is signed"
N=$(nonce); run_unit; ok "$([ "$(nonce)" = "$N" ] && grep -q '"code":"no-claim"' "$ST/evidence/writer-guard.jsonl" && echo 1 || echo 0)" "refused no-claim, sender nonce unchanged ($N)"

echo; echo "## S1. claim (as vps/cutover.sh does over ssh); the previous writer ran 10 min ago"
node -e 'console.log(JSON.stringify({from:"mac",lastRunEpoch:Math.floor(Date.now()/1000)-600,finishedAt:null,path:"official",exitCode:0}))' | VH claim --no-timer | tail -n1 | cut -c1-200
N=$(nonce); run_unit; ok "$([ "$(nonce)" = "$N" ] && tail -n1 "$ST/evidence/writer-guard.jsonl" | grep -q peer-recent && echo 1 || echo 0)" "refused peer-recent (< 50 min), nonce unchanged"

echo; echo "## S2. the previous writer ran 55 min ago: the job settles through the HARNESS fallback (no CRE login here)"
node -e 'console.log(JSON.stringify({from:"mac",lastRunEpoch:Math.floor(Date.now()/1000)-3300,finishedAt:null,path:"official",exitCode:0}))' >"$ST/peer-last-run.json"
N=$(nonce); A=$(alerts); run_unit
echo "    resultOf(RCSS,20261009) = $(res)"
L="$ST/evidence/LATEST.json"
node -e 'const r=require(process.argv[1]); console.log("    evidence: "+JSON.stringify({job:r.job,host:r.host,path:r.path,pathReason:r.pathReason,network:r.network,testDataRelabel:r.testDataRelabel,exitCode:r.exitCode,reportsSent:r.reportsSent}))' "$L"
ok "$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.host==="vps"&&r.job==="isotherm-settle.service"&&r.path==="harness-fallback"&&r.exitCode===0&&r.reportsSent.length===1&&r.reportsSent[0].confirmed==="resolved"?"1":"0")' "$L")" "evidence: host vps, job isotherm-settle.service, path harness-fallback, 1 report confirmed"
ok "$(res | grep -q '^(1, ' && echo 1 || echo 0)" "RCSS 2026-10-09 Settled on the fork (status 1)"
ok "$([ "$(nonce)" = $((N + 1)) ] && grep -q "^$TX1 $((N + 1)) " "$ST/writer-nonce" && echo 1 || echo 0)" "tripwire recorded '$TX1 $((N + 1))' (own tx counted)"
ok "$([ "$(alerts)" -ge $((A + 2)) ] && echo 1 || echo 0)" "pushes received: $(tail -n +$((A + 1)) "$T/alerts.jsonl" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.trim().split("\n").filter(Boolean).map(l=>JSON.parse(l).title).join(" | ")))')"

echo; echo "## S3. started again at once: the 30-min spacing guard (run-official.sh) skips; 0 txs"
N=$(nonce); run_unit; ok "$([ "$(nonce)" = "$N" ] && grep -q 'spacing' "$ST/logs/"job-*.log && echo 1 || echo 0)" "skipped by the spacing guard, nonce unchanged"

echo; echo "## S4. another host sends from the same key between runs: WRITER CONFLICT before anything is signed"
cast send --private-key "$TX1_KEY" "$SINK" --value 0 --rpc-url "$RPC" >/dev/null && echo "    (test) a 0-value tx from $TX1, as a second writer would"
A=$(alerts); run_unit
ok "$([ -f "$ST/writer-conflict" ] && [ "$(systemctl --user show isotherm-settle.service -p Result --value)" = exit-code ] && echo 1 || echo 0)" "var/writer-conflict written, unit failed (visible in systemctl --user --failed)"
ok "$([ "$(alerts)" = $((A + 1)) ] && tail -n1 "$T/alerts.jsonl" | grep -q 'WRITER CONFLICT' && echo 1 || echo 0)" "high-priority push: $(tail -n1 "$T/alerts.jsonl" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.priority+" "+j.title)})')"

echo; echo "## S5. the conflict is sticky: the next runs are refused too; one reminder push, then deduplicated (6 h)"
A=$(alerts); N=$(nonce); run_unit; run_unit
ok "$([ "$(nonce)" = "$N" ] && [ "$(alerts)" = $((A + 1)) ] && tail -n1 "$ST/evidence/writer-guard.jsonl" | grep -q conflict-standing && echo 1 || echo 0)" "two runs refused conflict-standing, no tx, one reminder push"

echo; echo "## S6. clear-conflict (the owner, after making sure one host settles)"
VH clear-conflict --yes | sed 's/^/    /'
ok "$([ ! -f "$ST/writer-conflict" ] && grep -q "^$TX1 $(nonce) " "$ST/writer-nonce" && echo 1 || echo 0)" "cleared and re-baselined at the current nonce"

echo; echo "## S7. another host sends DURING a run: detected after the run"
echo "    (test: the spacing guard is bypassed by deleting var/last-run. On the fork the 'finalized' read lags, so this run"
echo "    re-sends the ladder settled in S2; the write-once Resolver rejects it (exit 4). The tripwire counts that own tx.)"
rm -f "$ST/last-run"
c=$(cursor)
systemctl --user start --no-block isotherm-settle.service
for _ in $(seq 1 40); do grep -q 'pending ' "$ST/writer-nonce" 2>/dev/null && break; sleep 0.25; done
sleep 1; cast send --private-key "$TX1_KEY" "$SINK" --value 0 --rpc-url "$RPC" >/dev/null && echo "    (test) a 0-value tx from $TX1 while the job runs"
for _ in $(seq 1 120); do [ "$(systemctl --user show isotherm-settle.service -p ActiveState --value)" = activating ] || break; sleep 1; done
since_cursor "$c" | grep -E '\[vps\]|SKIPPED|\[evidence\]' | sed 's/^/    | /'
ok "$([ -f "$ST/writer-conflict" ] && grep -q 'during this run' "$ST/writer-conflict" && echo 1 || echo 0)" "conflict detected during the run"
VH clear-conflict --yes >/dev/null

echo; echo "## S8. release (as vps/rollback.sh does): a broadcasting run refuses; a dry run still works"
VH release --no-timer | tail -n1 | sed 's/^/    release -> /'
OUT=$(ISOTHERM_STATE_DIR=$ST ISOTHERM_RPC=$RPC ISOTHERM_ATTESTER_KEY_FILE=$T/keys/attester.key ISOTHERM_TX_KEY_FILE=$T/keys/tx.key bash "$PKG/scripts/run-official.sh" --harness --force 2>&1); RC=$?
echo "$OUT" | sed 's/^/    | /'
ok "$([ "$RC" = 0 ] && echo "$OUT" | grep -q 'SKIPPED: this host released' && echo 1 || echo 0)" "run-official.sh refuses to sign (exit $RC)"
N=$(nonce); run_unit
ok "$([ "$(nonce)" = "$N" ] && tail -n1 "$ST/evidence/writer-guard.jsonl" | grep -q no-claim && echo 1 || echo 0)" "the unit refuses (no claim)"
PRE=$(VH preflight 2>&1 | tail -n1); echo "    | $PRE"
ok "$(echo "$PRE" | grep -q 'preflight OK' && echo 1 || echo 0)" "--preflight-only still runs in full on a released host (the cutover gate needs it)"
echo "    dry run, without the test relabel (it reads the real 2026-10-09 archives); nothing is sent:"
DRY=$(VH dry-run 2>&1); echo "$DRY" | grep -E 'settle-job\]|\[path\]|not sent|\[evidence\]' | sed 's/^/    | /'
ok "$(echo "$DRY" | grep -q 'dry=1' && echo "$DRY" | grep -q '\[evidence\] path=harness-fallback exit=0' && echo 1 || echo 0)" "dry run (no broadcast) still runs, in var/dry"

echo; echo "## S9. the timer starts the service (temporary every-minute drop-in), then the hourly :05 schedule"
mkdir -p "$HOME/.config/systemd/user/isotherm-settle.timer.d"
printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* *:*:30 UTC\n' >"$HOME/.config/systemd/user/isotherm-settle.timer.d/every-minute-test.conf"
systemctl --user daemon-reload; systemctl --user enable --now isotherm-settle.timer >/dev/null 2>&1
before=$(systemctl --user show isotherm-settle.service -p ExecMainStartTimestampMonotonic --value)
for _ in $(seq 1 75); do [ "$(systemctl --user show isotherm-settle.service -p ExecMainStartTimestampMonotonic --value)" != "$before" ] && break; sleep 1; done
sleep 3
ok "$([ "$(systemctl --user show isotherm-settle.service -p ExecMainStartTimestampMonotonic --value)" != "$before" ] && echo 1 || echo 0)" "the timer started isotherm-settle.service at $(systemctl --user show isotherm-settle.service -p ExecMainStartTimestamp --value) (refused: no claim, as expected)"
rm -rf "$HOME/.config/systemd/user/isotherm-settle.timer.d"; systemctl --user daemon-reload
systemctl --user list-timers isotherm-settle.timer --no-pager | sed -n '1,2p' | sed 's/^/    /'
ok "$(systemctl --user show isotherm-settle.timer -p TimersCalendar --value | grep -q '\*-\*-\* \*:05:00 UTC' && systemctl --user show isotherm-settle.timer -p Persistent --value | grep -q yes && echo 1 || echo 0)" "schedule back to *-*-* *:05:00 UTC, Persistent=yes"

echo; echo "# $(date -u +%FT%TZ) done: $PASS passed, $FAIL failed (anvil and the stub stop on exit; drop-ins removed; timer disabled)"
[ "$FAIL" = 0 ]
