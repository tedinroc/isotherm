#!/usr/bin/env bash
# Runs settle/e2e/fork.e2e.test.ts against a fresh anvil fork of LIVE Monad testnet (v1 contracts), no MON spent.
# Starts its own anvil on ISOTHERM_ANVIL_PORT (default 19310, this package's range is 19300-19349) and stops ONLY
# that PID. Output is also written to a new file kept under $TMPDIR (its path printed); ISOTHERM_WRITE_EVIDENCE=1 also
# writes the tracked evidence/fork-e2e.txt, and only from a run that passed.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH:$HOME/.foundry/bin"
PORT=${ISOTHERM_ANVIL_PORT:-19310}
FORK_URL=${ISOTHERM_FORK_URL:-https://testnet-rpc.monad.xyz}
mkdir -p var evidence
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy; set ISOTHERM_ANVIL_PORT (19300-19349)" >&2; exit 1; fi

anvil --fork-url "$FORK_URL" --port "$PORT" --silent >"var/anvil-$PORT.log" 2>&1 &
ANVIL_PID=$!
cleanup() { kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 0.5; done
echo "anvil pid $ANVIL_PID on :$PORT, fork of $FORK_URL at block $(cast block-number --rpc-url "http://127.0.0.1:$PORT")"

cd settle
KEPT=$(mktemp -d "${TMPDIR:-/tmp}/isotherm-evidence.XXXXXX")/fork-e2e.txt
echo "report: $KEPT"
# a failing test ends this script here (set -e, pipefail): the tracked evidence is written only after a pass
ISOTHERM_FORK_RPC="http://127.0.0.1:$PORT" bun test --timeout 600000 ./e2e/fork.e2e.test.ts 2>&1 | tee "$KEPT"
echo "-> $KEPT"
if [ "${ISOTHERM_WRITE_EVIDENCE:-0}" = 1 ]; then cp "$KEPT" "$PKG/evidence/fork-e2e.txt"; echo "-> evidence/fork-e2e.txt"; fi
