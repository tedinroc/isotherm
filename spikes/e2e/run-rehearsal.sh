#!/usr/bin/env bash
# No-cheat rehearsal of `make testnet-e2e`: MODE=live code path against an anvil fork of the CURRENT live testnet
# (real balances, block every 1 s like a live chain, real waiting for the test station's day to end).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export PATH="$PATH:$HOME/.foundry/bin"
PORT=${PORT:-18992}
UPSTREAM=${UPSTREAM:-https://testnet-rpc.monad.xyz}
FORK_BLOCK=${FORK_BLOCK:-$(cast block-number --rpc-url "$UPSTREAM")}
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT busy" >&2; exit 1; fi
anvil --fork-url "$UPSTREAM" --fork-block-number "$FORK_BLOCK" --network monad --port "$PORT" --block-time 1 \
  --retries 6 --timeout 60000 --silent > "$HERE/logs/anvil-$PORT.log" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for i in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 0.5; done
echo "rehearsal anvil pid $ANVIL fork block $FORK_BLOCK (block time 1 s)"
cd "$HERE" && RPC="http://127.0.0.1:$PORT" npx tsx ts/preflight.ts && \
  MODE=live REHEARSAL=1 RPC="http://127.0.0.1:$PORT" npx tsx ts/e2e.ts
