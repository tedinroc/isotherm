# mm-plugin-isotherm (spike, v0.0.1)

A MetaMask Agent Wallet (`mm` 7.x) plugin that adds Isotherm commands. Isotherm lists daily max-temperature (Tmax ≥ k) strike ladders for Asian cities on Monad testnet (chain 10143).

| Command | Capabilities | What it does |
|---|---|---|
| `mm weather quote <city> [--address 0x…] [--rpc url]` | `wallet-read` | Gets the Open-Meteo Tmax forecast for the city's METAR station (Taipei uses RCSS) and prices a placeholder Tmax ≥ k ladder. It also reads Monad testnet state: the AUSD collateral balance of the selected mm wallet and the Kuru router code. Runs without `mm login`. |
| `mm weather memo <city> [--wait] [--gas N]` | `wallet-read`, `wallet-submit` | Sends a harmless 0-value transaction with the memo `isotherm:v0:<station>:<date>:tmax=<n>` through `ctx.walletExecutor`. MetaMask policy applies. The default gas limit is 30000, because Monad bills the gas limit. |

`targetChains: [10143]` is shown on the consent screen. mm 7.0.0 does not enforce it.

## Install (mm 7.0.0)

Run these steps once, after `mm login` and `mm init`:

```sh
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true
mm plugins install https://registry.npmjs.org/mm-plugin-isotherm/-/mm-plugin-isotherm-0.0.1.tgz --accept-permissions
python3 ../scripts/add-monad-testnet-chain.py "$HOME"       # executor: 10143 -> public Monad RPC
node ../scripts/rpc-shim.mjs & export MM_INFURA_RPC_BASE_URL=http://127.0.0.1:18790   # optional: ctx.publicClient(10143)
```

`../scripts/setup-mm-monad.sh` runs all of the steps above. The scripts live in `spikes/mm/scripts/` and are not shipped in the package yet.

### Why install from the tarball URL

On 7.0.0, `mm plugins install mm-plugin-isotherm` (install by npm name) prints "installed" and then silently uninstalls the plugin. The cause is the postrun consent hook. It looks the new plugin up in a stale oclif `Config`. The host bundles `@oclif/core` 4.11.4, and `@oclif/plugin-plugins` reloads the Config into its own `@oclif/core` 4.14.0 copy. Install by tarball URL or `file:` path instead. Those take the local-source branch of the hook, which falls back to reading `package.json` in the data directory.

### Local development

```sh
npm install && npm run build
npm_config_install_links=true mm plugins install "file:$PWD" --accept-permissions
```

Without `install_links`, npm symlinks the folder. The plugin then imports its own devDependency copy of `@metamask/agent-wallet`, the `instanceof PluginCommand` check fails, and the command errors with `PLUGIN_INVALID_BASE`.

## Publish

```sh
npm login
npm publish
```

`prepack` runs `tsc` and `oclif manifest`. The package ships `dist/` and `oclif.manifest.json`. It has no install scripts and no oclif hooks. `@metamask/agent-wallet` is a peer dependency.
