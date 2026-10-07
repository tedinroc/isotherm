#!/usr/bin/env bash
# CRE simulator (`cre workflow simulate --broadcast`, compiled WASM in the CRE engine) against a fresh anvil fork of
# LIVE Monad testnet with the v1 contracts, using LIVE IEM / aviationweather / Ogimet data. Spends no MON.
#
# The fork shares the live Resolver's EIP-712 domain, so the REAL attester key is never used here: the script
# impersonates the owner on the fork and points the Resolver at anvil's public test key #9. The tx sender is
# anvil's public dev key #1. Both keys are public and worthless.
#
# What it settles: there are no live ladders yet, so it uses a replay config (extraTargets) for days that are already
# over: REPLAY_TARGETS (default RCSS:2026-10-06,RJTT:2026-10-06; Polymarket resolved Taipei 25 C, Tokyo 26 C).
# Fallback demo: REPLAY_TARGETS=RCSS:2026-05-04,RCSS:2025-11-15 OUT_NAME=sim-fork-fallback SIM_GAP_SEC=90
#   (05-04: aviationweather aged out -> IEM + Ogimet 2-of-3 = 25; 2025-11-15: IEM outage, past deadline -> VOID).
#
# Binary: the official `cre` if you are logged in (`cre whoami`). Otherwise, ONLY with ISOTHERM_ALLOW_PATCHED_SIM=1,
# the spike's dev build with the client-side login check removed (spikes/cre/patches; same engine, v1.37.0).
# Output: evidence/sim-fork*.txt. Port: ISOTHERM_ANVIL_PORT (default 19311; this package uses 19300-19349).
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH:$HOME/.foundry/bin"
PORT=${ISOTHERM_ANVIL_PORT:-19311}
REPLAY_TARGETS=${REPLAY_TARGETS:-RCSS:2026-10-06,RJTT:2026-10-06}
RPC="http://127.0.0.1:$PORT"
mkdir -p var evidence
D=$(node -e 'const d=require(process.argv[1]); console.log([d.resolver,d.roles.owner,d.mockForwarder].join(" "))' "$PKG/../../deployments/testnet.json")
read -r RESOLVER OWNER FORWARDER <<<"$D"
TEST_ATTESTER=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720   # anvil #9 (public)

CRE=cre
LABEL="official cre CLI v1.37.0"
if ! cre whoami >/dev/null 2>&1; then
  PATCHED="$PKG/../../spikes/cre/.tools/bin/cre-nologin-sim"
  if [ "${ISOTHERM_ALLOW_PATCHED_SIM:-0}" = "1" ] && [ -x "$PATCHED" ]; then
    CRE="$PATCHED"
    LABEL="DEV HARNESS: spike-built cre v1.37.0 with ONLY the client-side login check removed (not the official binary)"
  else
    echo "Not logged in to CRE. Run 'cre login' (see scripts/run-official.sh --help), or set ISOTHERM_ALLOW_PATCHED_SIM=1 for the dev harness." >&2
    exit 3
  fi
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy" >&2; exit 1; fi
anvil --fork-url "${ISOTHERM_FORK_URL:-https://testnet-rpc.monad.xyz}" --port "$PORT" --silent >"var/anvil-$PORT.log" 2>&1 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done

OUT="$PKG/evidence/${OUT_NAME:-sim-fork}.txt"
{
  echo "# $(date -u +%FT%TZ) $LABEL"
  echo "# anvil fork of live Monad testnet at block $(cast block-number --rpc-url "$RPC"), pid $ANVIL_PID, port $PORT"
  cast rpc anvil_impersonateAccount "$OWNER" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
  cast send --unlocked --from "$OWNER" "$RESOLVER" "setAttester(address)" "$TEST_ATTESTER" --rpc-url "$RPC" >/dev/null
  echo "# fork: Resolver.attester -> $(cast call "$RESOLVER" 'attester()(address)' --rpc-url "$RPC") (public test key; real attester key not used)"
  cast rpc anvil_mine 0x50 --rpc-url "$RPC" >/dev/null   # anvil's finalized tag lags 64 blocks; the workflow reads at finalized

  # replay config: the shipped config + extraTargets (written next to the workflow; --config path must be <= 97 chars)
  node -e '
    const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    c.extraTargets=process.argv[2].split(",").map(s=>({icao:s.split(":")[0],date:s.split(":")[1]}));
    fs.writeFileSync(process.argv[3], JSON.stringify(c,null,2)+"\n");' settle/config.anvil.json "$REPLAY_TARGETS" settle/config.anvil-replay.json
  echo "# replay targets: $REPLAY_TARGETS"

  for run in 1 2; do
    if [ "$run" = 2 ] && [ "${SIM_GAP_SEC:-0}" -gt 0 ]; then echo "## waiting ${SIM_GAP_SEC}s (Ogimet throttles back-to-back queries)"; sleep "$SIM_GAP_SEC"; fi
    echo "## simulate run $run"
    CRE_ETH_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
    ISOTHERM_ATTESTER_KEY_ALL=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 \
    ISOTHERM_ANVIL_PORT=$PORT \
      "$CRE" workflow simulate ./settle -T anvil-fork --config ./config.anvil-replay.json \
        --non-interactive --trigger-index "${SIM_TRIGGER:-2}" --broadcast 2>&1 | grep -v "Update available\|cre update\|upgrade\.$" | tee "var/sim-run-$run.log" || true
    for T in ${REPLAY_TARGETS//,/ }; do
      ST=0x$(printf '%s' "${T%%:*}" | xxd -p); DT=${T#*:}; DT=${DT//-/}
      echo "resultOf(${T%%:*}, $DT) = $(cast call "$RESOLVER" 'resultOf(bytes4,uint32)((uint8,int16,uint64,uint64,bytes32))' "$ST" "$DT" --rpc-url "$RPC")"
    done
    cast rpc anvil_mine 0x50 --rpc-url "$RPC" >/dev/null
  done

  echo "## confirm the simulator's report txs from their receipts (ReportProcessed.result + LadderResolved)"
  HASHES=$(grep -oE 'tx 0x[0-9a-f]{64} ->' var/sim-run-1.log | grep -oE '0x[0-9a-f]{64}' | tr '\n' ' ')
  if (cd settle && bun e2e/confirm.ts --rpc "$RPC" $HASHES); then echo "confirm exit 0"; else echo "confirm exit $?"; fi
  echo "## replay the first report tx's exact calldata -> the forwarder tx succeeds but the report is NOT accepted"
  FIRST=${HASHES%% *}
  INPUT=$(cast tx "$FIRST" input --rpc-url "$RPC")
  REPLAY=$(cast send --unlocked --from 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 "$FORWARDER" "$INPUT" --gas-limit 200000 --rpc-url "$RPC" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).transactionHash))')
  if (cd settle && bun e2e/confirm.ts --rpc "$RPC" "$REPLAY"); then echo "confirm exit 0 (UNEXPECTED)"; else echo "confirm exit $? (4 = not accepted, as expected for a replay)"; fi
} 2>&1 | tee "$OUT"
