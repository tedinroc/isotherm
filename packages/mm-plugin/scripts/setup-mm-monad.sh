#!/bin/sh
# One-time setup so mm-plugin-isotherm can trade on Monad testnet (10143) from a real mm 7.x host.
#
#   sh setup-mm-monad.sh                         install the published plugin + add chain 10143
#   ISOTHERM_TGZ=./mm-plugin-isotherm-0.1.0.tgz sh setup-mm-monad.sh   install a local tarball instead
#
# Env:
#   ISOTHERM_TGZ   plugin source: registry tarball URL (default), a local .tgz path, or a plugin directory
#   MONAD_RPC      RPC the executor uses for nonce/gas/fees on 10143 (default https://testnet-rpc.monad.xyz)
#   MM             mm command (default: mm)
#   SKIP_INSTALL=1 only (re)write the chain entry
#
# Prereqs (human): `npm i -g @metamask/agent-wallet@7`, then `mm login` and `mm init` before the first TRADE.
# Read-only commands (weather markets/quote/edge/positions, kuru book) work without signing in.
set -eu
MM="${MM:-mm}"
VER="${ISOTHERM_VERSION:-0.1.0}"
SRC="${ISOTHERM_TGZ:-https://registry.npmjs.org/mm-plugin-isotherm/-/mm-plugin-isotherm-$VER.tgz}"
RPC="${MONAD_RPC:-https://testnet-rpc.monad.xyz}"

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  # A bare local path is read by oclif's plugin installer as a GitHub "user/repo" ref -> needs a file: prefix.
  case "$SRC" in
    http://*|https://*|file:*) ;;
    *)
      if [ -e "$SRC" ]; then
        SRC="file:$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"
      else
        echo "setup-mm-monad: no such file or directory: $SRC" >&2; exit 2
      fi ;;
  esac
  $MM config set experimentalPlugins true >/dev/null
  # 7.0.0: installing by npm *name* reports "installed" and then silently uninstalls (its postrun consent hook reads
  # a stale oclif Config). Installing the registry tarball URL takes the local-source path, which works but needs:
  $MM config set experimentalAllowUnverifiedInstalls true >/dev/null
  # A plugin *directory* would otherwise be symlinked, making it resolve its own copy of the host (PLUGIN_INVALID_BASE).
  npm_config_install_links=true $MM plugins install "$SRC" --accept-permissions
fi

# Executor-side fix for 10143 (works on a fresh home too; mm keeps the entry when `mm init` runs later).
# Same code as scripts/add-monad-testnet-chain.mjs, inlined so this file also works when downloaded on its own.
node --input-type=module - "$HOME" "$RPC" <<'JS'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.argv[2] || homedir();
const rpc = process.argv[3] || process.env.MONAD_RPC || "https://testnet-rpc.monad.xyz";
if (!/^https?:\/\//.test(rpc)) {
  console.error(`rpcUrl must be http(s): ${rpc}`);
  process.exit(2);
}
const dir = join(home, ".metamask");
const file = join(dir, "wallets.json");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
let doc = { schemaVersion: "0.0.1", data: {} };
let created = true;
if (existsSync(file)) {
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
    created = false;
  } catch (e) {
    console.error(`refusing to touch ${file}: not valid JSON (${e.message})`);
    process.exit(3);
  }
}
doc.data = doc.data && typeof doc.data === "object" ? doc.data : {};
const chains = Array.isArray(doc.data.customEvmChains) ? doc.data.customEvmChains.filter((c) => Number(c?.chainId) !== 10143) : [];
chains.push({
  key: "monad-testnet",
  chainId: 10143,
  caip2: "eip155:10143",
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  blockExplorer: "https://testnet.monadexplorer.com",
  rpcTarget: rpc,
});
doc.data.customEvmChains = chains;
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
chmodSync(tmp, 0o600);
renameSync(tmp, file);
console.log(`customEvmChains[10143].rpcTarget = ${rpc}  (${file}${created ? ", created" : ""})`);
JS

cat <<MSG
Done. Check with:   $MM weather doctor --json
Read-only, no sign-in needed:   $MM weather markets --json    $MM weather quote taipei --json
Trading needs \`mm login\` + \`mm init\` once, testnet MON for gas (https://faucet.monad.xyz) and testnet AUSD.
Optional, so ctx.publicClient(10143) works too: run scripts/rpc-shim.mjs from the plugin package and export MM_INFURA_RPC_BASE_URL=http://127.0.0.1:18790
MSG
