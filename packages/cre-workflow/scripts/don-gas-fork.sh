#!/usr/bin/env bash
# Measures the gas a DON-signed Isotherm report needs through the PRODUCTION KeystoneForwarder (0xF834…4482) into the
# live v1 Resolver, on a fresh anvil fork of Monad testnet (settle/e2e/don-gas.fork.test.ts). Sizes `gasLimit` in
# settle/config.don.json. No MON, no keys: the forwarder owner and the Resolver owner are impersonated on the fork, and
# the DON signers and the attester are public throwaway keys.
# Port: ISOTHERM_ANVIL_PORT (default 19341; this package uses 19300-19349). Stops only the anvil it started.
# Output: evidence/don-gas-fork.txt (log) and evidence/don-gas-fork.json (numbers).
# ISOTHERM_LIVE_COMPARE=0 skips the read-only eth_estimateGas comparison against live testnet.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH:$HOME/.foundry/bin"
PORT=${ISOTHERM_ANVIL_PORT:-19341}
FORK_URL=${ISOTHERM_FORK_URL:-https://testnet-rpc.monad.xyz}
mkdir -p var evidence
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy; set ISOTHERM_ANVIL_PORT (19300-19349)" >&2; exit 1; fi
anvil --fork-url "$FORK_URL" --port "$PORT" --silent >"var/anvil-$PORT.log" 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 0.5; done
LIVE_CMP=""
[ "${ISOTHERM_LIVE_COMPARE:-1}" = 1 ] && LIVE_CMP=https://testnet-rpc.monad.xyz
{
  echo "# $(date -u +%FT%TZ) DON gas measurement: anvil $(anvil --version | head -1 | awk '{print $3}') fork of $FORK_URL at block $(cast block-number --rpc-url "http://127.0.0.1:$PORT") (pid $ANVIL_PID, port $PORT)"
  cd settle
  ISOTHERM_FORK_RPC="http://127.0.0.1:$PORT" ISOTHERM_LIVE_COMPARE_RPC="$LIVE_CMP" ISOTHERM_DON_GAS_OUT="$PKG/evidence/don-gas-fork.json" \
    bun test --timeout 600000 ./e2e/don-gas.fork.test.ts 2>&1
} | tee "$PKG/evidence/don-gas-fork.txt"
exit "${PIPESTATUS[0]}"
