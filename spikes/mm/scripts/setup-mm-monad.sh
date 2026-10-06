#!/bin/sh
# One-time setup so mm-plugin-isotherm works on Monad testnet (10143) in a real mm 7.x host.
# Prereqs (human): `npm i -g @metamask/agent-wallet@7`, then `mm login` and `mm init`.
#
#   ISOTHERM_TGZ=<tarball url or path>  plugin source (default: the npm registry tarball)
#   MONAD_RPC=<url>                      RPC used by the executor for nonce/gas (default public testnet RPC)
#   MM="<command>"                       mm binary (default: mm)
set -eu
MM="${MM:-mm}"
HERE="$(cd "$(dirname "$0")" && pwd)"
VER="${ISOTHERM_VERSION:-0.0.1}"
TGZ="${ISOTHERM_TGZ:-https://registry.npmjs.org/mm-plugin-isotherm/-/mm-plugin-isotherm-$VER.tgz}"

$MM config set experimentalPlugins true >/dev/null
# 7.0.0: installing by npm *name* reports "installed" and then silently uninstalls
# (its postrun consent hook reads a stale oclif Config). Installing the registry
# tarball URL takes the local-source path, which works but needs this flag.
$MM config set experimentalAllowUnverifiedInstalls true >/dev/null
$MM plugins install "$TGZ" --accept-permissions

# Executor-side fix for 10143: a customEvmChains entry with rpcTarget (no CLI command for this in 7.0.0).
python3 "$HERE/add-monad-testnet-chain.py" "$HOME" "${MONAD_RPC:-https://testnet-rpc.monad.xyz}"

cat <<'EOF'
Done. Optional, so ctx.publicClient(10143) also works (the hosted gateway rejects 10143):
  node scripts/rpc-shim.mjs &
  export MM_INFURA_RPC_BASE_URL=http://127.0.0.1:18790
Try:  mm weather quote taipei --json      mm weather memo taipei --wait --json
EOF
