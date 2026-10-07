# mm-plugin-isotherm: RESULT (2026-10-07)

**Verdict: the plugin is built and every command works in the real MetaMask Agent Wallet host (`@metamask/agent-wallet`
7.0.0) on an anvil fork of live Monad testnet. The read path also works against the live chain.** One hop has never
run: MetaMask's real signing service broadcasting one of our 10143 transactions. It needs a team member to sign in.

What the plugin covers:
- **Weather commands.** Eight `weather` commands: `markets`, `quote`, `edge`, `positions` and `doctor` read state;
  `buy`, `sell` and `redeem` submit transactions.
- **Generic Kuru commands.** Three `kuru` commands for any Kuru v1 market: `book`, `limit` and `cancel`.
- **Wallet path.** Every write goes through `ctx.walletExecutor`.
- **Contracts.** It uses the v1 IsothermZap, whose `canonicalMarket` registry it reads, and falls back to the
  feasibility deployment.

No transaction was sent to the live testnet or to mainnet from this workstream. Live reads were `eth_call` only.

## 1. What works, with evidence (all in `packages/mm-plugin/evidence/`)

| Claim | Evidence |
|---|---|
| **Unit tests pass.** 27 tests cover pure logic. The integer book walk reproduces three recorded fills to the unit: the live Kuru spike's `20 AUSD @0.44 -> 45.409090 YES`, and the e2e's `50 @0.57 -> 87,631,578` and `40 YES into 0.28 -> 11,188,800 AUSD`. | `npm test` -> `tests 27, pass 27, fail 0` |
| **v1 contracts, real host, fork of live testnet.** Fork block 68,888,626 with `--network monad`. All 34 steps behaved as expected: 27 transactions CONFIRMED through the executor, 1 policy denial and 5 expected refusals (outcome locked, non-canonical market, off tick, not your order, gateway 400). Settlement went through the real MockKeystoneForwarder bytecode, then redeem ran after the 900 s challenge window. | `harness-v1/SUMMARY.txt`, the per-command `NN-*.txt` files, `harness-v1/stub.log`, `harness-v1/TX-TABLE.md` |
| **Feasibility contracts, same harness.** This deployment has no on-chain registry, so markets come from the deployment file plus the plugin's canonical-book check. All 34 steps behaved as expected, with 27 transactions CONFIRMED. | `harness-feasibility/SUMMARY.txt` |
| **Signed transactions reach the backend.** Each step arrives at the backend stand-in as a signed request with our gas limit, for example `{"kind":"tx-request","chainId":10143,"to":"0x1acaf479…","intent":"Isotherm buyYes Tmax>=30C Taipei 2026-10-08","signed":true}`. | `harness-v1/stub.log` |
| **Exact plan for `buy --side yes`.** The plan was `spendAusd 20.000000, expectedYes 40.120481, minYesOut 39.919878`. The simulation returned `40120481`, and the `ZapBuyYes` event showed `yesOut 40120481` on the registry book `0x702A…36DC`. | `harness-v1/07-buy-yes.txt` |
| **`buy --side no`.** The Zap minted 10 sets and sold the YES leg at 0.818. The wallet ended with 10 NO and 8.171820 AUSD back, an average NO price of 0.1828. The simulated NO price was re-checked before signing. | `harness-v1/08-buy-no.txt` |
| **Sell flows.** `sell --side yes` and `sell --side no` (exact-out buy-back, then merge), and `redeem --merge` all work. | `harness-v1/13,14,18-*.txt` |
| **Kuru commands on our book and on a third-party book.** `kuru limit` ran approve, MarginAccount deposit of the exact shortfall, then a post-only `addBuyOrder` and returned the order id. `kuru cancel --all --withdraw` freed the margin. The same commands also worked on the Kuru spike's SpikeToken/AUSD market, which is not an Isotherm book. | `harness-v1/20,23,25,26-*.txt` |
| **Refusals before signing.** `ISOTHERM_OUTCOME_LOCKED` (observed RCSS max 28 °C ≥ 28, from live aviationweather.gov), `ISOTHERM_NONCANONICAL_MARKET` (a `--market` that differs from the registry), `KURU_OFF_TICK` and `KURU_NOT_YOUR_OPEN_ORDER`. (`ISOTHERM_NO_LIQUIDITY` was hit in earlier runs when the book had no depth inside the limit; its message names the best bid or ask.) | `harness-v1/09,27,21,22-*.txt` |
| **Host-side failures map to clear codes.** A toy Guard allowlist on the stub gives `ISOTHERM_TX_DENIED`, decoded from mm's `TRANSACTION_REQUEST_FAILED` with terminalStatus DENIED; the stub log shows `tx-denied` and no broadcast. Removing `customEvmChains[10143]` gives `ISOTHERM_CHAIN_NOT_CONFIGURED`, from the real gateway-style 400 `Invalid chainId`. | `harness-v1/28,29-*.txt` |
| **Setup-script issues from the verifier are fixed.** On a truly empty `HOME`, `ISOTHERM_TGZ=./mm-plugin-isotherm-0.1.0.tgz sh scripts/setup-mm-monad.sh` (a bare relative path) installs the plugin, gets all 11 commands consented, writes `customEvmChains[10143]` and exits 0. Writing the chain entry *before* `mm init` is safe: after `mm init --wallet byok` the entry is still there. | `01-setup-fresh-home.txt`, `03-harness-setup-then-init.txt`, `harness-v1/00-setup.txt` |
| **Signed-out host, live Monad testnet.** `doctor`, `markets --all`, `quote taipei`, `quote tokyo`, `edge` and `positions` all return `ok:true` using the bundled v1 deployment. `kuru book` on the live spike market shows taker1 holding 45.409090 YES, the Kuru spike's live fill. A `buy` stops at the host's `AUTH_FAILED` (`mm login` needed). | `02-readonly-live-signed-out.txt` |
| **Tarball ready.** `mm-plugin-isotherm-0.1.0.tgz`, 47 files, 73.1 kB. It bundles the v1 `deployments/testnet.json` and `packages/abi/*.json`, with sha256 hashes in `assets/bundle-info.json`. A leak check found no wallet key and no mnemonic in the tarball or the package tree, apart from the gitignored `harness/.secrets/`. | `npm-pack.txt` |

### Numbers
- **Gas per user trade.** Monad bills the limit; MON below is at 102 gwei.
  - `Zap.buyYes`: estimate about 466k, limit 582,504 (×1.25), 0.059 MON.
  - `Zap.buyNo`: limit 788,552, 0.080 MON.
  - `Zap.sellYes`: limit 594,320, 0.061 MON.
  - Exact approve: limit 77,748, 0.008 MON.
  - `vault.redeem`: limit 161,640, 0.017 MON.
- **Whole v1 suite.** 27 transactions, total limit 8,605,170, about 0.88 MON.
- **Host wall time.** 0–3 s per command, including mm start-up and the Polymarket, Open-Meteo and aviationweather calls. Signing and confirming on the fork are sub-second.

## 2. What does not work, or is not verified

| # | Gap | Closest working path |
|---|---|---|
| 1 | **No real MetaMask sign-in yet.** The submit path through Mimir (MetaMask's signing service) with a real account has never been exercised. Guard-Mode email approvals and server-wallet policy YAML are also untested. | The harness proves everything up to the signing-service HTTP hop. `ISOTHERM_AWAITING_APPROVAL` and `ISOTHERM_TX_DENIED` handling is implemented. Human action 2 closes the gap. |
| 2 | **The plugin cannot edit the Guard allowlist.** The policy YAML is server-defined and changing it needs MFA. | `mm weather doctor` prints the allowlist targets. The human edits the policy with `mm wallet policy get` and `mm wallet policy set`. |
| 3 | **`buy --side no` has a weak on-chain bound.** The v1 `Zap.buyNo` takes no `minNoOut`. If the book thins between quote and fill, the unsold YES is merged back at par. The user then gets fewer NO at a higher effective price, yet `minAusdBack` still passes. | The plugin re-checks the simulated NO price immediately before signing (`ISOTHERM_PRICE_LIMIT`) and reports a `guardNote`. If the Zap later gains a `minNoOut` parameter, the plugin's name-based encoder fills it automatically (unit-tested). **Request to contracts:** add `minNoOut`. |
| 4 | **No `arb vs mm predict` command.** Plugins cannot call `mm predict`. | `weather edge` reads Polymarket's public gamma API directly, the same data `mm predict` uses. |
| 5 | **`targetChains` covers 10143 only.** mm 7.0.0 does not enforce the field anyway. The plan mentions 143 for reading mainnet ForecastCommits. | Not built. A read-only `weather commits` command is a small follow-up. |
| 6 | **v0 guardrail is a "lite" version.** It is a raw Open-Meteo 4-model mean with σ ≈ 1.5 °C and no bias correction. On 2026-10-08 Taipei it sits well below Polymarket, so `guardrailFlag` fires. | It is labelled a guardrail, with the backtest result stated. The calibrated engine lives in `packages/forecast`, which needs a history download and does not fit a CLI call. |
| 7 | **The harness uses an anvil fork.** Anvil does not enforce Monad's reserve-balance rule, and its gas price decays, so `maxMonBilled` on the fork is tiny. | The README tx table recomputes cost at 102 gwei. |
| 8 | **No live v1 ladder yet** (`vault.ladderCount() = 0` at 05:38Z). Live `markets` and `quote` show reference prices only. | Once the maker workstream opens the Taipei ladder and calls `setCanonicalMarket`, the same commands show it with no plugin change. |

## 3. Interfaces for the other workstreams

- **Maker / daily roll.** The plugin finds a strike's book only through `IsothermZap.canonicalMarket(seriesId)` on v1.
  Every book must therefore be registered with `setCanonicalMarket` by the operator; otherwise `buy` and `sell`
  refuse with `ISOTHERM_NONCANONICAL_MARKET`. Books must use the standard params (pp 1e4, sp 1e6, tick 10,
  taker ≤ 30 bps).
- **Contracts.**
  - Deployments: the loader accepts the current flat `deployments/testnet.json` and is tolerant of nested shapes.
  - ABIs: it reads `packages/abi/*.json` (array or `{abi}`).
  - Rebuild the plugin (`npm run build`) after any redeploy, because the bundle is copied at build time.
  - Wish list: `minNoOut` on `buyNo`, and optionally a `sellNo`.
- **apps/web and apps/api.** Reusable pure helpers for anyone who needs them:
  - `src/lib/plan.ts`: integer book walks and min-out;
  - `src/lib/weather.ts`: Polymarket-implied ladder, METAR observed max, `parseDateArg`;
  - `src/lib/kuru.ts`: L2 decode and open-order scan.
- **Override for forks and redeploys.** Env `ISOTHERM_DEPLOYMENTS=<json>`, with optional `ISOTHERM_ABI_DIR` and
  `ISOTHERM_RPC_URL`.

## 4. Human actions

1. **Publish to npm.** The name was free on 2026-10-06; re-check it.
   ```sh
   cd <repo>/packages/mm-plugin
   npm ci && npm test && npm run build
   npm view mm-plugin-isotherm            # expect E404
   npm login                              # npm account, 2FA
   npm publish --access public            # prepack rebuilds + bundles the current deployments/testnet.json
   npm view mm-plugin-isotherm@0.1.0 dist.tarball
   ```
2. **Run one real signed-in trade.** This is the only hop that has never run.
   - Install the host and plugin:
     ```sh
     npm i -g @metamask/agent-wallet@7.0.0
     curl -fsSL https://unpkg.com/mm-plugin-isotherm@0.1.0/scripts/setup-mm-monad.sh -o setup-mm-monad.sh && sh setup-mm-monad.sh
     mm login        # pick one method and keep it: the server-wallet address depends on the method
     mm init         # BYOK gives a deterministic address
     mm weather doctor --json
     ```
   - Fund `wallet.address` with about 0.3 MON from https://faucet.monad.xyz.
   - Get AUSD by calling `requestFunds(<addr>)` on `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`.
   - When the live Taipei ladder exists, run:
     ```sh
     mm weather quote taipei --json
     mm weather buy taipei --strike <k> --side yes --amount 2 --max-price <ask> --dry-run --json
     mm weather buy taipei --strike <k> --side yes --amount 2 --max-price <ask> --json
     ```
   - Paste the output and the transaction hash back. In Guard Mode, approve the email link when asked; if the
     transaction is denied, add the targets that `doctor` lists to the policy.
3. **Optional: record a Claude Code session.** Load `SKILL.md` and run quote, dry-run, buy and positions. This is
   the bounty's "recorded Claude Code run".
4. **Optional: report upstream on MetaMask/agentic.** A team member should post these:
   - installing by npm name silently uninstalls the plugin (stale oclif Config in the postrun hook);
   - `file:` directory installs are symlinked, which causes `PLUGIN_INVALID_BASE`;
   - the gateway rejects 10143 although the docs list it.

## 5. Files

- **`src/commands/weather/*.ts`, `src/commands/kuru/*.ts`:** the 11 commands.
- **`src/lib/`:**
  - `config.ts`: deployments, ABIs, cities;
  - `chain.ts`: RPC fallback, wallet, revert decoding;
  - `exec.ts`: executor wrapper, gas, error mapping;
  - `plan.ts`: book walks;
  - `weather.ts`: Polymarket, METAR, v0-lite;
  - `isotherm.ts`: ladders, registry, canonical check;
  - `kuru.ts`, `kurucmd.ts`;
  - `trade.ts`: guards and simulation;
  - `view.ts`: the quote and edge view.
- **`scripts/`:**
  - `setup-mm-monad.sh` (self-contained);
  - `add-monad-testnet-chain.mjs`;
  - `rpc-shim.mjs`;
  - `bundle-assets.mjs` (build step, not shipped).
- **`assets/`:** the bundled v1 deployment and ABIs, plus the feasibility fallback.
- **`test/unit.test.ts`, `test/fixtures/`:** the unit tests and the captured gamma, AWC and deployment fixtures.
- **`harness/`:**
  - `run-all.sh` (full evidence run), `fork-scenario.mjs`, `settle-fork.mjs`, `tx-table.mjs`, `reinstall.sh`;
  - `stub-backend.mjs`, `seed-session.py`, `bin/mm`, `bin/mm-harness`;
  - `host/`, an isolated mm 7.0.0 install;
  - `.secrets/`, a gitignored test-only mnemonic.
- **`SKILL.md`, `README.md`** (bounty mapping, tx table, publish steps), **`evidence/`**.
- **`mm-plugin-isotherm-0.1.0.tgz`:** the packed tarball. It is gitignored and rebuilt by `npm pack`.
