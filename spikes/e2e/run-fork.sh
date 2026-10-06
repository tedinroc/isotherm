#!/usr/bin/env bash
# Full product loop as real txs on an anvil fork of LIVE Monad testnet (10143). Starts its own anvil on $PORT and
# stops only that process (never pkill: other agents run their own anvils).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
export PATH="$PATH:$HOME/.foundry/bin"
PORT=${PORT:-18991}
UPSTREAM=${UPSTREAM:-https://testnet-rpc.monad.xyz}
FORK_BLOCK=${FORK_BLOCK:-$(cast block-number --rpc-url "$UPSTREAM")}
LOGDIR="$HERE/logs"; mkdir -p "$LOGDIR"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT busy; set PORT=" >&2; exit 1; fi
(cd "$ROOT" && forge build >/dev/null)
anvil --fork-url "$UPSTREAM" --fork-block-number "$FORK_BLOCK" --network monad --port "$PORT" \
  --retries 6 --timeout 60000 --silent > "$LOGDIR/anvil-$PORT.log" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for i in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 0.5; done
echo "anvil pid $ANVIL fork block $FORK_BLOCK: $(cast rpc anvil_nodeInfo --rpc-url http://127.0.0.1:$PORT | python3 -c 'import json,sys; d=json.load(sys.stdin); print("network="+str(d.get("network")), "hardFork="+str(d.get("hardFork")))')"
cd "$HERE" && MODE=fork RPC="http://127.0.0.1:$PORT" npx tsx ts/e2e.ts
