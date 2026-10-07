#!/usr/bin/env bash
# The real CLI, end to end, against an anvil fork of live Monad testnet with LIVE market data (Polymarket CLOB,
# aviationweather/IEM METAR, Open-Meteo for the v0 guard) and a local stand-in for POST /api/snapshot.
#   preflight -> roll tomorrow (Taipei) -> loop 3 ticks -> status -> jump to the stop time -> watchdog (kill switch)
# Nothing reaches the live chain: every tx goes to our own anvil (port FORK_PORT, default 19152), killed on exit.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${FORK_PORT:-19152}"; API_PORT="${API_PORT:-19160}"
export PATH="$PATH:$HOME/.foundry/bin"
TS="$(date -u +%Y-%m-%dT%H-%M-%S)"; OUT="$PKG/evidence/cli-fork-$TS"; mkdir -p "$OUT/var"
anvil --fork-url https://testnet-rpc.monad.xyz --port "$PORT" --retries 8 --fork-retry-backoff 800 > "$OUT/anvil.log" 2>&1 & APID=$!
TOKEN="fork-demo-$(date +%s)"
node "$PKG/scripts/mock-api.mjs" "$API_PORT" "$OUT/api-received.jsonl" "$TOKEN" & MPID=$!
trap 'kill $APID $MPID 2>/dev/null || true' EXIT
RPC="http://127.0.0.1:$PORT"
for i in $(seq 1 120); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
echo "anvil pid $APID on $RPC, block $(cast block-number --rpc-url "$RPC")" | tee "$OUT/summary.txt"
for k in maker operator; do
  a=$(cast wallet address --private-key "$(cat "$HOME/.config/isotherm/$k.key")")
  cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x56BC75E2D63100000 >/dev/null   # 100 MON, fork only
done
echo '{"loop":{"tickSec":8,"watchdogSec":5}}' > "$OUT/local.json"
export MAKER_RPC="$RPC" MAKER_VAR="$OUT/var" MAKER_CONFIG="$OUT/local.json" ISOTHERM_API_URL="http://127.0.0.1:$API_PORT" ISOTHERM_SNAPSHOT_TOKEN="$TOKEN"
cd "$PKG"
node src/cli.ts preflight --station RCSS --date tomorrow > "$OUT/preflight.json"
node -e 'const p=require(process.argv[1]); console.log("preflight: ready="+p.ready+" strikes="+JSON.stringify(p.plan.strikes)+" warnings="+JSON.stringify(p.warnings))' "$OUT/preflight.json" | tee -a "$OUT/summary.txt"
node src/cli.ts roll --station RCSS --date tomorrow > "$OUT/roll.json" 2> "$OUT/roll.stderr" || true
node -e 'const r=require(process.argv[1]); console.log("roll: ok="+r.ok+" strikes="+JSON.stringify(r.strikes)+" close="+r.closeLocal+" mon="+JSON.stringify(r.monByRole)); for (const s of r.steps) console.log("  ["+s.step+"] "+s.status+": "+s.detail)' "$OUT/roll.json" | tee -a "$OUT/summary.txt"
node src/cli.ts loop --max-ticks 3 2>&1 | grep -E 'tick [0-9]+ done|WARN|ERROR' | tee -a "$OUT/summary.txt"
node src/cli.ts status | tee -a "$OUT/summary.txt"
STOP=$(node -e 'const s=require(process.argv[1]); console.log(Object.values(s.ladders)[0].stopAt)' "$OUT/var/state.json")
NOW=$(cast block --rpc-url "$RPC" latest --field timestamp)
cast rpc --rpc-url "$RPC" evm_increaseTime $((STOP - NOW + 5)) >/dev/null; cast rpc --rpc-url "$RPC" evm_mine >/dev/null
echo "time travel to the stop-quoting time (+5 s)" | tee -a "$OUT/summary.txt"
node src/cli.ts watchdog --verify 2>&1 | tail -3 | tee -a "$OUT/summary.txt"
node src/cli.ts status | tee -a "$OUT/summary.txt"
echo "snapshot POSTs received by the stand-in API: $(grep -c '"auth":true' "$OUT/api-received.jsonl" || true)" | tee -a "$OUT/summary.txt"
cp "$OUT/var/snapshot.json" "$OUT/snapshot.json" 2>/dev/null || true
echo "evidence: $OUT"
