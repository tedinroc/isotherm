#!/usr/bin/env bash
# Isotherm v1 testnet deploy: Resolver + CollateralVault + IsothermZap, stations RCSS/RJTT, roles, role funding,
# then writes deployments/<name>.json from the broadcast file + on-chain reads.
#
#   MODE=anvil RPC=http://127.0.0.1:19100 script/deploy-testnet.sh   # rehearsal on an anvil fork (writes script/evidence/deploy-anvil/)
#   MODE=live  script/deploy-testnet.sh                               # REAL Monad testnet 10143 (writes deployments/testnet.json)
#
# Keys: $KEYDIR/{deployer,guardian,attester,operator}.key (one hex key per file, never printed).
# Gas: Monad bills the gas LIMIT, so forge uses --gas-estimate-multiplier 108 and value transfers use 21000 exactly.
# Monad reserve balance: an account under 10 MON may only send value in an "emptying" tx (no other tx from it in the
# previous 3 blocks), so each MON transfer waits a few blocks first.
set -euo pipefail

MODE=${MODE:-anvil}
KEYDIR=${KEYDIR:-$HOME/.config/isotherm}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$PATH:$HOME/.foundry/bin"
if [[ "$MODE" == "live" ]]; then RPC=${RPC:-https://testnet-rpc.monad.xyz}; NAME=testnet; else RPC=${RPC:-http://127.0.0.1:19100}; NAME=${NAME:-anvil}; fi
CHALLENGE_WINDOW=${CHALLENGE_WINDOW:-900}
FUND_OPERATOR=${FUND_OPERATOR:-0.15ether}
FUND_ATTESTER=${FUND_ATTESTER:-0.1ether}
MULT=${MULT:-108}
OUT=${OUT:-$ROOT/script/evidence/deploy-$NAME}
mkdir -p "$OUT"

key() { tr -d '\n' < "$KEYDIR/$1.key"; }
addr() { cast wallet address --private-key "$(key "$1")"; }
DEPLOYER=$(addr deployer); GUARDIAN=$(addr guardian); ATTESTER=$(addr attester); OPERATOR=$(addr operator)
CHAIN=$(cast chain-id --rpc-url "$RPC")
[[ "$CHAIN" == "10143" ]] || { echo "refusing: chain $CHAIN is not Monad testnet 10143"; exit 1; }
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

log "mode=$MODE rpc=$RPC chain=$CHAIN"
log "owner(deployer)=$DEPLOYER guardian=$GUARDIAN attester=$ATTESTER operator=$OPERATOR challengeWindow=${CHALLENGE_WINDOW}s"
BAL0=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
log "deployer balance $(cast from-wei "$BAL0") MON, nonce $(cast nonce "$DEPLOYER" --rpc-url "$RPC")"

# ---- 1. deploy (one forge script: 3 creates + 2 registerStation + setOperator) ------------------------------
log "1. forge script Deploy.s.sol --broadcast --slow --gas-estimate-multiplier $MULT"
(cd "$ROOT" && ATTESTER=$ATTESTER GUARDIAN=$GUARDIAN OPERATOR=$OPERATOR CHALLENGE_WINDOW=$CHALLENGE_WINDOW \
  FOUNDRY_BROADCAST="$OUT/broadcast" FOUNDRY_CACHE_PATH="$OUT/cache" \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow --gas-estimate-multiplier "$MULT" \
  --private-key "$(key deployer)" > "$OUT/forge-script.log" 2>&1) || { tail -40 "$OUT/forge-script.log"; exit 1; }
rm -rf "$OUT/cache"; find "$OUT/broadcast" -name '*.lock' -delete 2>/dev/null || true
RUN="$OUT/broadcast/Deploy.s.sol/$CHAIN/run-latest.json"
grep -E "Resolver |CollateralVault |IsothermZap |OutcomeToken impl" "$OUT/forge-script.log" | sed 's/^ */  /'

# ---- 2. fund the operator and attester from the deployer --------------------------------------------------
fund() { # $1=label $2=to $3=value
  local start; start=$(cast block-number --rpc-url "$RPC")
  while (( $(cast block-number --rpc-url "$RPC") < start + 4 )); do sleep 0.5; done # emptying-tx spacing
  local r; r=$(cast send --rpc-url "$RPC" --private-key "$(key deployer)" --gas-limit 21000 --value "$3" "$2" --json)
  echo "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d.get("data",d) if "schema_version" in d else d; print(d["transactionHash"], d["status"], int(d["blockNumber"],16))' \
    | while read -r H ST BN; do log "2. fund $1 $3 -> tx $H status $ST block $BN"; echo "$1 $H $ST $BN" >> "$OUT/funding.txt"; done
}
: > "$OUT/funding.txt"
if [[ "${SKIP_FUNDING:-0}" != "1" ]]; then fund operator "$OPERATOR" "$FUND_OPERATOR"; fund attester "$ATTESTER" "$FUND_ATTESTER"; fi

# ---- 3. deployments/<name>.json from the broadcast + on-chain reads ------------------------------------------
BAL1=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
if [[ "$MODE" == "live" ]]; then OUTJSON="$ROOT/deployments/testnet.json"; else OUTJSON="$OUT/deployments-$NAME.json"; fi
RPC="$RPC" RUN="$RUN" OUTJSON="$OUTJSON" FUNDING="$OUT/funding.txt" BAL0="$BAL0" BAL1="$BAL1" \
  DEPLOYER="$DEPLOYER" GUARDIAN="$GUARDIAN" ATTESTER="$ATTESTER" OPERATOR="$OPERATOR" MODE="$MODE" \
  python3 "$ROOT/script/write-deployments.py"
log "deployer spent $(cast from-wei $((BAL0 - BAL1))) MON (incl. funding); wrote $OUTJSON"
