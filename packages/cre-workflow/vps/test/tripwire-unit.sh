#!/usr/bin/env bash
# TEST ONLY. Runs ON the (test) VPS after vps/setup.sh --with-anvil. Checks the on-chain tripwire of vps/settle-vps.sh
# against what the OFFICIAL path logs; the systemd fork e2e cannot run that path (it needs a CRE login). The real
# settle-vps.sh, lib.sh and isotherm-vps.sh run from a scratch package whose scripts/settle-job.sh is a stub: it prints
# official-path log lines and sends real transactions on a LOCAL anvil chain (not a fork) from a fresh random key.
#   T1 a report logged "<ICAO> <date>: tx 0x… -> resolved"                  -> single writer, nonce recorded
#   T2 a report whose writeReport failed: no hash logged, but its transaction used a nonce (mined and reverted, or
#      still pending)                                                       -> no conflict; the next run re-baselines
#   T3 as T2, plus a transaction from another host in the same run         -> WRITER CONFLICT
#   T4 a transaction this run did not log at all                           -> WRITER CONFLICT
#   T5 `claim` after the role was away (the other host sent in between)    -> re-baselined, the next run is no conflict
# Output: stdout (run-container-tests.sh saves it to vps/evidence/).
set -uo pipefail
REAL="$HOME/isotherm/packages/cre-workflow"
export PATH="$REAL/.tools/bin:$PATH"
PORT=${PORT:-19390}; RPC="http://127.0.0.1:$PORT"
T="$HOME/tripwire-test"; P="$T/pkg"; ST="$T/state"
PASS=0; FAIL=0
ok() { if [ "$1" = 1 ]; then PASS=$((PASS + 1)); echo "  PASS  $2"; else FAIL=$((FAIL + 1)); echo "  FAIL  $2"; fi; }
cleanup() { kill "$ANVIL_PID" 2>/dev/null || true; rm -rf "$T/keys"; }
trap cleanup EXIT

rm -rf "$T"; mkdir -p "$P/vps" "$P/scripts" "$T/keys" "$ST"
for f in settle-vps.sh lib.sh isotherm-vps.sh; do ln -s "$REAL/vps/$f" "$P/vps/$f"; done   # the code under test
ln -s "$REAL/settle" "$P/settle"; ln -s "$REAL/.tools" "$P/.tools"                           # bun + viem, cast
cat >"$P/scripts/settle-job.sh" <<'EOF'
#!/usr/bin/env bash
# TEST stub of scripts/settle-job.sh: official-path log lines + real transactions on the local anvil chain
K=$(cat "$ISOTHERM_TX_KEY_FILE")
tx() { cast send --private-key "$K" 0x000000000000000000000000000000000000dEaD --value 0 --rpc-url "$ISOTHERM_RPC" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).transactionHash))'; }
at() { date -u +%FT%TZ; }
case "$STUB" in
  logged)   H=$(tx); echo "$(at) [USER LOG] RCSS 2026-10-09: tx $H -> resolved" ;;
  failed)   tx >/dev/null; echo "$(at) [USER LOG] RCSS 2026-10-09: writeReport 1 execution reverted" ;;
  failed+peer) tx >/dev/null; tx >/dev/null; echo "$(at) [USER LOG] RCSS 2026-10-09: writeReport 1 execution reverted" ;;
  unlogged) tx >/dev/null; echo "$(at) [USER LOG] nothing to settle (ladders=3, due=0)" ;;
  none)     echo "$(at) [USER LOG] nothing to settle (ladders=3, due=0)" ;;
esac
exit 0
EOF
anvil --chain-id 10143 --port "$PORT" --silent >"$T/anvil.log" 2>&1 & ANVIL_PID=$!
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.25; done
read -r A K < <(cast wallet new 2>/dev/null | tail -n1); printf '%s' "$K" >"$T/keys/tx.key"; unset K; chmod 600 "$T/keys/tx.key"
cast rpc anvil_setBalance "$A" 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null
echo "# $(date -u +%FT%TZ) tripwire-unit on $(. /etc/os-release; echo "$PRETTY_NAME") $(uname -m): local anvil chain $(cast chain-id --rpc-url "$RPC"), tx sender $A (fresh random key)"
export ISOTHERM_STATE_DIR=$ST ISOTHERM_RPC=$RPC ISOTHERM_TX_KEY_FILE=$T/keys/tx.key ISOTHERM_WRITER_CLAIM_REQUIRED=0 \
  ISOTHERM_ALERT_URL_FILE=$T/no-alert-url
nonce() { cast nonce "$A" --rpc-url "$RPC"; }
run() { # run <stub scenario>: the real settle-vps.sh; prints its [vps] lines; returns its exit code
  local rc; STUB=$1 bash "$P/vps/settle-vps.sh" >"$T/out.log" 2>&1; rc=$?
  grep -F '[vps]' "$T/out.log" | sed 's/^/    | /'; echo "    exit $rc, writer-nonce: $(cat "$ST/writer-nonce" 2>/dev/null)"; return $rc
}
rec() { cut -d' ' -f1-2 <"$ST/writer-nonce"; }

echo; echo "## T0. first run, nothing sent: the baseline is recorded"
run none; ok "$([ "$(rec)" = "$A $(nonce)" ] && echo 1 || echo 0)" "baseline '$A $(nonce)'"

echo; echo "## T1. a report sent and logged (official format 'tx 0x… -> resolved')"
N=$(nonce); run logged; RC=$?
ok "$([ "$RC" = 0 ] && [ ! -f "$ST/writer-conflict" ] && [ "$(rec)" = "$A $((N + 1))" ] && echo 1 || echo 0)" "single writer, record '$A $((N + 1))'"

echo; echo "## T2. a report whose writeReport failed (no hash logged) but whose transaction used a nonce"
N=$(nonce); run failed; RC=$?
ok "$([ "$RC" = 0 ] && [ ! -f "$ST/writer-conflict" ] && grep -q '^pending ' "$ST/writer-nonce" && echo 1 || echo 0)" "no conflict; the record stays pending"
run none; RC=$?
ok "$([ "$RC" = 0 ] && [ ! -f "$ST/writer-conflict" ] && [ "$(rec)" = "$A $((N + 1))" ] && echo 1 || echo 0)" "the next run re-baselines at '$A $((N + 1))', no conflict"

echo; echo "## T3. as T2, plus a transaction from another host during the same run"
rm -f "$ST/writer-conflict"; echo "$A $(nonce) $(date +%s)" >"$ST/writer-nonce"   # a clean start, whatever T2 left
run failed+peer; RC=$?
ok "$([ "$RC" = 1 ] && [ -f "$ST/writer-conflict" ] && echo 1 || echo 0)" "WRITER CONFLICT (exit 1)"
rm -f "$ST/writer-conflict"; run none >/dev/null

echo; echo "## T4. a transaction this run did not log at all"
run unlogged; RC=$?
ok "$([ "$RC" = 1 ] && [ -f "$ST/writer-conflict" ] && echo 1 || echo 0)" "WRITER CONFLICT (exit 1)"
rm -f "$ST/writer-conflict"; echo "$A $(nonce) $(date +%s)" >"$ST/writer-nonce"

echo; echo "## T5. the role goes to the other host and comes back: its transactions in between are not a conflict"
bash "$P/vps/isotherm-vps.sh" release --no-timer >/dev/null 2>&1
STUB=logged bash "$P/scripts/settle-job.sh" >/dev/null; STUB=logged bash "$P/scripts/settle-job.sh" >/dev/null
echo "    (test) the other host sent 2 txs while it held the role; nonce now $(nonce)"
node -e 'console.log(JSON.stringify({from:"mac",lastRunEpoch:Math.floor(Date.now()/1000)-4000,finishedAt:null}))' \
  | bash "$P/vps/isotherm-vps.sh" claim --no-timer >/dev/null 2>&1
echo "    claim -> writer-nonce: $(cat "$ST/writer-nonce" 2>/dev/null || echo none)"
run none; RC=$?
ok "$([ "$RC" = 0 ] && [ ! -f "$ST/writer-conflict" ] && [ "$(rec)" = "$A $(nonce)" ] && echo 1 || echo 0)" "no conflict after the claim; record '$A $(nonce)'"

echo; echo "# $(date -u +%FT%TZ) done: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
