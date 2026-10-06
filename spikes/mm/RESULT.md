# Spike: MetaMask Agent Wallet plugin (`mm` 7.0.0) for Isotherm

**Verdict: this can be built.** A plugin package (`mm-plugin-isotherm`) loads and runs inside the real `@metamask/agent-wallet@7.0.0` host.

- The `wallet-read` command works today without signing in.
- The `wallet-submit` command sends real signed EIP-1559 transactions through `ctx.walletExecutor` on chain 10143. This was proven end to end with the real host binary, but the MetaMask backend was a local stub and the chain was an anvil fork.

There are three caveats, and each is backed by evidence below:

1. **Bring-your-own-key (BYOK) mode still requires `mm login`.** There is no fully local mode.
2. **Monad testnet (10143) needs a workaround.** The hosted RPC gateway rejects it. The fix is a `customEvmChains` entry or the RPC shim in this folder.
3. **Installing by npm name is broken in 7.0.0.** Installing by tarball URL works.

The real signed-in path with MetaMask's servers is **not yet run**. It needs a team member to sign in (see Human actions).

All work is in `spikes/mm/`. Every `mm` run here uses an isolated `HOME`, so the real `~/.metamask` is never touched.

| Path | Purpose |
|---|---|
| `bin/mm` | `mm` 7.0.0 with `HOME=.mmhome`, no sign-in, telemetry off |
| `bin/mm-harness` | Same binary with `HOME=.mmhome-harness`. Every `MM_*` backend URL points to `harness/stub-backend.mjs` on 127.0.0.1:18788. |
| `mm-plugin-isotherm/` | The plugin: `weather quote` (`wallet-read`) and `weather memo` (`wallet-read` + `wallet-submit`) |
| `scripts/setup-mm-monad.sh` | Real-world setup: beta flags, tarball install, adds `customEvmChains` for 10143 |
| `scripts/add-monad-testnet-chain.py` | Writes `wallets.json#data.customEvmChains[10143]` with `rpcTarget` |
| `scripts/rpc-shim.mjs` | `MM_INFURA_RPC_BASE_URL` shim: serves 10143 from the Monad RPC and passes other chains through to MetaMask's gateway |
| `harness/stub-backend.mjs` | **Test-only** stand-in for MetaMask's backend services (BYOK registration, trading mode, transaction requests). It broadcasts to anvil. |
| `.secrets/mnemonic.txt` | Fresh mnemonic, testnet only, gitignored. Its index-0 address is `0xA74351452257c5bf84167F2D597E994f792134cf`. |

---

## 1. What works, with evidence

### 1a. Plugin architecture, learned from the installed 7.0.0 package
- **Plugin lifecycle**
  - Plugins are oclif user plugins, loaded only when `experimentalPlugins=true`.
  - `PluginCommand` seals `run`, `init`, `beforeExecute`, `requiresAuth`, `requiresInit` and `requiresFees`.
  - `this.ctx` is a frozen, restricted view. `wallet-read` unlocks `publicClient`, `walletStateManager` and the other services. `wallet-submit` unlocks `walletExecutor`. `session` and `mnemonicStore` always throw `PERMISSION_DENIED`.
  - Source: `dist/chunks/PluginCommand-*.js`.
- **Executor request shape**
  - Read from the built-in `wallet:send-transaction`: `exec({kind:"transaction", chainId, transaction:{to,data,value,gas,...}, intent:{action:"custom",summary}}, {signal, waitForReceipt})`.
  - In BYOK mode the host signs locally with its keyring, then POSTs `signedTransaction` to MetaMask's signing service (Mimir), `POST /v1/projects/<projectId>/transaction-requests`. **Mimir decides and broadcasts.** It is the policy hop, and the CLI never broadcasts on its own.
- **`targetChains` is not enforced.** The manifest field is only shown on the consent screen.

### 1b. Loads and runs in the real host without signing in (`bin/mm`)
```
$ bin/mm plugins install file:$PWD/mm-plugin-isotherm --accept-permissions     # before the beta flag
{"ok":false,"error":{"code":"PLUGIN_BETA_DISABLED", ...}}
$ bin/mm config set experimentalPlugins true ; bin/mm config set experimentalAllowUnverifiedInstalls true
$ npm_config_install_links=true bin/mm plugins install "file:$PWD/mm-plugin-isotherm" --accept-permissions
@metamask/agent-wallet: Installing plugin file:.../mm-plugin-isotherm... installed v0.0.1
$ bin/mm weather quote taipei --json
{"ok":true,"data":{"city":"Taipei","station":"RCSS","date":"2026-10-07","forecastTmaxC":26,
  "ladder":[...{"strike":"Tmax>=26C","fairYes":0.6227}...],
  "chain":{"chainId":10143,"blockNumber":"68691388","rpcSource":"direct-rpc",
           "gatewayError":"A project id is required to resolve the default EVM gateway RPC URL."},
  "collateral":{"symbol":"AUSD","decimals":6,"totalSupply":"1302010000.000000"},
  "venue":{"kuruRouter":"0x7EFbE105Ca7415dE98F96622173458ac1c054630","routerDeployed":true}}}
$ bin/mm weather memo taipei --json
{"ok":false,"error":{"code":"AUTH_FAILED","message":"No CLI refresh token available — run `mm login` to sign in."}}
```
The consent record is written to `~/.metamask/config.json#plugins` with `approvedCapabilities:["wallet-read","wallet-submit"]` and a manifest hash. `mm weather --help` lists both commands.

### 1c. The `wallet-submit` path end to end in the real host, against the local stub (`bin/mm-harness`)

These steps ran the real `mm init` BYOK flow with `MM_MNEMONIC` from `.secrets` (never printed):

1. Challenge, then sign, then register, then set trading mode `guard`. The stub logged each step.
2. Add `customEvmChains[10143]`, with anvil as the RPC.
3. Run the plugin command:
```
$ bin/mm-harness weather memo taipei --wait --json
Intent: Isotherm forecast memo for Taipei (0 MON)
{"ok":true,"data":{"chainId":10143,"from":"0xA743…34cf","memo":"isotherm:v0:RCSS:2026-10-07:tmax=26",
 "gasLimit":"30000","status":"CONFIRMED","hash":"0xbc5c37455f8235efca4515edc64b906019ba9c8fe3d0f541507bf2f455f43c2e","submitMs":270}}
stub.log: tx-request {chainId:10143, signed:true, txKeys:[from,to,chainId,data,value,nonce,gasLimit,maxFeePerGas,maxPriorityFeePerGas]}
$ cast tx 0x54da…1147 → type 2, chainId 10143, gasLimit 30000, maxFeePerGas 105.8 gwei; receipt status 1, gasUsed 22400;
  input decodes to "isotherm:v0:RCSS:2026-10-07:tmax=26"
```
The fork was anvil 1.8.5 `--network monad`, pinned at block 68691827. Ten memo transactions all succeeded, each using about 22,000–22,480 gas against a 30,000 limit.

Other checks in the same harness:
- **Policy hop is real.** With `STUB_ALLOWLIST=<Kuru router>`, the same command fails with `stub Guard: 0xa743… not on allowlist`, and the signed transaction is **not** broadcast.
- **Capability gate works.** With `wallet-submit` removed from the manifest and the plugin reinstalled: `{"code":"PERMISSION_DENIED","message":"Plugin 'weather:memo' did not declare the 'wallet-submit' capability."}`
- **`ctx.publicClient(10143)` works through the shim.** `weather quote` returned `"rpcSource":"mm-gateway"` and `holderSource:"mm-wallet-state"`. The stub logged batched JSON-RPC requests to `/rpc/10143/isotherm-local`.
- **Setup script works.** `scripts/setup-mm-monad.sh` was run against a fresh `HOME` (`.mmhome-setuptest`), using the tarball from a local Verdaccio. The memo for Hong Kong then CONFIRMED.

### 1d. The 10143 problem, reproduced and fixed

Probes of MetaMask's live endpoints (no auth, `eth_chainId` or GET only):
```
gateway .../infura-service/v1/1/<pid>     → 200 0x1      .../143/<pid> → 200 0x8f
gateway .../infura-service/v1/10143/<pid> → 400 {"error":"Invalid chainId"}   (also 6343, 1328; sepolia/base-sepolia are fine)
accounts-api /v2/supportedNetworks        → eip155:143 present, 10143 absent
tx-sentinel /networks                     → 143 present (relayTransactions:true), 10143 absent
Mimir  /v1/supportedNetworks              → {"chainId":10143,"name":"Monad Testnet","shieldSupported":false,"guardSupported":true}  ← the signer DOES list 10143
```

The same three cases were run in the harness, with the gateway mirroring the real 400 response:

| Case | Setup | Result |
|---|---|---|
| A | No `customEvmChains` | `weather memo` fails with `Non-200 status code: '400'` and `data:{error:'Invalid chainId'}`. This matches the research note. |
| B | Gateway replaced by the shim, no `customEvmChains` | CONFIRMED |
| C | `customEvmChains` set, real-like gateway | CONFIRMED. `quote` falls back to a direct RPC. |

### 1e. Publishing path, tested with a local Verdaccio registry (not npmjs)
- `npm publish` to Verdaccio succeeded. The registry metadata keeps the `mm` block and the integrity hash.
- `npm view mm-plugin-isotherm` on npmjs returns 404, so the name is free.
- `npm publish --dry-run` packs 5 files (6.0 kB) and fails only on `npm whoami` (not signed in).
- The consent screen text, as printed by mm: `Requested capabilities: wallet-read, wallet-submit ⚠ … Signing still routes through MetaMask policy (MFA-gated).`

## 2. What does not work, and the closest working path

| # | Problem | Evidence | Workaround |
|---|---|---|---|
| 1 | **BYOK is not local-only.** `mm init`, `wallet list` and all signing require `mm login`. The BYOK keyring unlock also needs Mimir's URL and an auth token. | `mm init --wallet byok` → `AUTH_FAILED`. In the source: `NO_AUTH_TOKEN: BYOK wallet unlock requires an auth token` and `InitCommand.requiresAuth = true`. | A team member signs in once with Google, email, or the QR code. Read-only plugin commands can set `requiresAuth=false` and work without sign-in, as `weather quote` does. |
| 2 | **Hosted gateway rejects 10143.** This breaks `ctx.publicClient(10143)` and the executor's nonce, gas and fee reads. | See 1d, case A. | Run `add-monad-testnet-chain.py`, which fixes the executor. Run `rpc-shim.mjs` with `MM_INFURA_RPC_BASE_URL`, which fixes both. The plugin itself falls back to a direct RPC for reads. |
| 3 | **`mm plugins install <npm-name>` silently uninstalls itself.** It prints "installed", then "Uninstalling… done", and exits 0. | `DEBUG=*` shows `reloading config from @oclif/core@4.11.4 to @oclif/core@4.14.0`, then the postrun hook runs `runCommand plugins:uninstall`. Cause: the hook does `config.plugins.get(name)` on the host's stale Config, gets nothing, and fails with `PLUGIN_MANIFEST_FILE_MISSING`. | Install with the registry **tarball URL** (needs `experimentalAllowUnverifiedInstalls true`), which works. Also report it upstream. |
| 4 | **The documented `file:` install gives `PLUGIN_INVALID_BASE`** for any template-style plugin that keeps `@metamask/agent-wallet` as a devDependency. This is the error monagent hit. | npm symlinks the folder, so the plugin resolves its own copy of the host and `instanceof PluginCommand` fails. | Install with `npm_config_install_links=true`, or from a tarball. |
| 5 | Guard Mode, email approvals and Transaction Shield are server-wallet features. The docs say "Trading modes apply to server-wallet only". For BYOK, `init` offers "Policy-based 2FA coming soon". | Docs `trading-modes.md`, `InitCommand` options | BYOK should not trigger email approvals. Server-wallet Guard Mode on 10143 (`guardSupported:true`, `shieldSupported:false`) may need allowlist approvals. **Not verified**: it needs a real sign-in. |

## 3. Numbers
- **Host overhead:** `mm --version` takes 0.46–0.50 s wall time.
- **`weather quote`:** 2.9 s wall, mostly Open-Meteo and RPC; one run took 5.9 s.
- **`weather memo`** (local signing, stub, anvil): `submitMs` was 248–270 ms when warm and 1,926 ms on a cold first run.
- **Memo transaction:** gasLimit 30,000, gasUsed 22,000–22,480 (73–75%). The fork's fee was maxFeePerGas 105.8 gwei and effective price 93.3 gwei. Because Monad bills the limit, the worst case is about **0.0032 MON per memo**.
- **Plugin tarball:** 6.0 kB, 5 files. The installed plugin directory needs about 149 MB, which is the oclif data dir including the peer host.
- **Live testnet:** the deployer has **4.70 MON**, below the 5 MON bar, and the BYOK address has 0 MON. No live-testnet transaction was sent. The read path does run against live testnet (`weather quote`, block 68694052).

## 4. Human actions
1. `npm i -g @metamask/agent-wallet@7.0.0`, then `mm login`. Choose browser sign-in with Google or email, or the QR code with MetaMask Mobile.
   - Browser sign-in means Guard Mode approvals arrive by email link.
   - BYOK vs server wallet: BYOK gives a deterministic address. Run `MM_MNEMONIC="$(cat spikes/mm/.secrets/mnemonic.txt)" mm init --wallet byok --mode guard`.
   - **Different sign-in methods produce different server-wallet addresses**, so pick one and keep it.
2. Fund the agent address with testnet MON from faucet.monad.xyz (browser checkpoint). For the BYOK spike that address is `0xA74351452257c5bf84167F2D597E994f792134cf`. 0.05 MON covers about 15 memos.
3. Run `spikes/mm/scripts/setup-mm-monad.sh`, then the following. Paste the outputs and the transaction hash back. This is the one untested hop: does Mimir accept and broadcast a 10143 transaction for this account?
   ```
   mm weather quote taipei --json
   mm weather memo taipei --wait --json
   ```
4. `npm login`, or create an npm account, then run `npm publish` in `mm-plugin-isotherm/`. The name is free.
5. Optional: open an issue on MetaMask/agentic covering problems 3 and 4. A team member should post it. Problem 2 contradicts the "Monad Testnet 10143 supported" row in the docs.

## 5. Next steps (build)
- Add the plan's superpower commands on the same executor pattern:
  - `weather buy|sell|redeem`
  - `kuru limit|cancel`, as calldata to Kuru OrderBook plus an AUSD approve transaction
  - `weather edge|arb`, using Polymarket's public API directly, because plugins cannot call `mm predict`
- Map `TRANSACTION_REQUEST_FAILED` to `CommandError` with hints.
- Ship `setup-mm-monad.sh`, the shim and the chain script inside the package, for example as a `scripts/` folder in `files`.
- Write `SKILL.md` and a README transaction table.
- After step 3 above, record a Claude Code run in the real signed-in host.

### Reproduce
```sh
cd spikes/mm && npm ci && (cd mm-plugin-isotherm && npm ci && npm run build)
bin/mm config set experimentalPlugins true && bin/mm config set experimentalAllowUnverifiedInstalls true
npm_config_install_links=true bin/mm plugins install "file:$PWD/mm-plugin-isotherm" --accept-permissions
bin/mm weather quote taipei --json
# harness: anvil --fork-url https://testnet-rpc.monad.xyz --network monad --port 18745 --chain-id 10143 &
#          node harness/stub-backend.mjs & ; python3 harness/seed-session.py .mmhome-harness
#          MM_MNEMONIC=... bin/mm-harness init --wallet byok --mode guard; python3 scripts/add-monad-testnet-chain.py .mmhome-harness http://127.0.0.1:18745
#          cast rpc anvil_setBalance 0xA743…34cf 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:18745; bin/mm-harness weather memo taipei --wait --json
```
