#!/bin/bash
# launchd entry point: loads ~/.config/isotherm/maker.env (chmod 600; ISOTHERM_ALLOW_LIVE, ISOTHERM_API_URL,
# ISOTHERM_SNAPSHOT_TOKEN, optional MAKER_RPC / MAKER_STATIONS) and runs the CLI with the node it was installed with.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ISOTHERM_ENV_FILE:-$HOME/.config/isotherm/maker.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
NODE_BIN="${NODE_BIN:-$(command -v node || echo /usr/local/bin/node)}"
cd "$PKG"
exec "$NODE_BIN" src/cli.ts "$@"
