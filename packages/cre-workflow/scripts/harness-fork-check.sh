#!/usr/bin/env bash
# Exercises scripts/run-official.sh --harness end to end on a fresh anvil fork of LIVE testnet (0 MON, public keys):
#   A. replay RCSS + RJTT 2026-10-06 with live METAR data -> settled through the MockKeystoneForwarder, confirmed
#   B. warp the fork to 02:05 Taipei on the day after the LIVE maker ladder (RCSS 2026-10-08): the workflow finds it
#      through Vault.duePendingLadders and - with no complete data yet for that day - must NOT report (PENDING)
#   C. the runner refuses the LIVE attester key on a non-live RPC
# The fork's Resolver attester is pointed at anvil's public key #9 (owner impersonation); the tx sender is anvil #1.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH:$HOME/.foundry/bin"
PORT=${ISOTHERM_ANVIL_PORT:-19312}
RPC="http://127.0.0.1:$PORT"
OUT="$PKG/evidence/harness-fork.txt"
mkdir -p var/fork-keys
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT busy" >&2; exit 1; fi
anvil --fork-url "${ISOTHERM_FORK_URL:-https://testnet-rpc.monad.xyz}" --port "$PORT" --silent >"var/anvil-$PORT.log" 2>&1 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true; rm -rf var/fork-harness/run.lock' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
# public anvil dev keys (#9 attester, #1 tx sender): worthless, published in every Foundry install
printf '%s' 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 > var/fork-keys/attester.key
printf '%s' 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d > var/fork-keys/tx.key
chmod 600 var/fork-keys/*.key
RESOLVER=$(node -e 'console.log(require(process.argv[1]).resolver)' "$PKG/../../deployments/testnet.json")
OWNER=$(node -e 'console.log(require(process.argv[1]).roles.owner)' "$PKG/../../deployments/testnet.json")
export ISOTHERM_RPC=$RPC ISOTHERM_STATE_DIR=var/fork-harness
{
  echo "# $(date -u +%FT%TZ) harness runner on an anvil fork of live testnet, block $(cast block-number --rpc-url "$RPC") (pid $ANVIL_PID)"
  echo "## C. the LIVE attester key on a non-live RPC is refused"
  ./scripts/run-official.sh --harness --preflight-only && echo "UNEXPECTED: accepted" || echo "refused as designed (exit $?)"
  cast rpc anvil_impersonateAccount "$OWNER" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
  cast send --unlocked --from "$OWNER" "$RESOLVER" "setAttester(address)" 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 --rpc-url "$RPC" >/dev/null
  cast rpc anvil_mine 0x50 --rpc-url "$RPC" >/dev/null
  export ISOTHERM_ATTESTER_KEY_FILE=$PKG/var/fork-keys/attester.key ISOTHERM_TX_KEY_FILE=$PKG/var/fork-keys/tx.key
  echo "## A. replay RCSS + RJTT 2026-10-06 (live METAR data) through the harness"
  HARNESS_EXTRA=RCSS:2026-10-06,RJTT:2026-10-06 ./scripts/run-official.sh --harness --force
  echo "## B. 02:05 Taipei on 2026-10-09: the LIVE maker ladder RCSS 2026-10-08 is due, but its data does not exist yet"
  T=$(node -e 'console.log(Date.parse("2026-10-08T18:05:00Z")/1000)')
  cast rpc evm_setNextBlockTimestamp "$T" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_mine 0x50 0x1 --rpc-url "$RPC" >/dev/null
  HARNESS_AT=$((T + 80)) ./scripts/run-official.sh --harness --force
  echo "resultOf(RCSS,20261008) = $(cast call "$RESOLVER" 'resultOf(bytes4,uint32)((uint8,int16,uint64,uint64,bytes32))' 0x52435353 20261008 --rpc-url "$RPC")"
} 2>&1 | tee "$OUT"
