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

**Update after the v1 security review (see `FIXES.md`).** `buy --side no` no longer calls `Zap.buyNo` (finding N1):
it mints sets with `CollateralVault.mintSet` and sells exactly that YES with `Zap.sellYes(minAusdOut)`, a real
on-chain bound. The N1 sandwich was replayed in the real host on both forks: the plugin's sell reverted, while the
old `buyNo` at the same state would have filled at 0.999 per NO. `quote`/`edge` now show the maker snapshot's fair
value (Polymarket-implied) and label the guardrail; the plugin's crude v0-lite is only a labelled fallback.

## 1. What works, with evidence (all in `packages/mm-plugin/evidence/`)

In the transcripts, `<repo>` is the repository root and `<former API host>` is the API's hostname at the time of the
run. Since 2026-10-07 16:06 UTC the API is served at `https://isotherm.pages.dev/api/*`, the plugin's default.

| Claim | Evidence |
|---|---|
| **Unit tests pass.** 34 tests cover pure logic. The integer book walk reproduces three recorded fills to the unit: the live Kuru spike's `20 AUSD @0.44 -> 45.409090 YES`, and the e2e's `50 @0.57 -> 87,631,578` and `40 YES into 0.28 -> 11,188,800 AUSD`. New: the Buy-NO planner reproduces the earlier e2e numbers (`8.171820` back, min `8.130960`), a pure N1 test shows the old bound passing and the new one failing on a drained book, and the snapshot parser runs on a captured live API response. | `npm test` -> `tests 34, pass 34, fail 0` |
| **v1 contracts, real host, fork of live testnet.** Fork block 68,907,593 with `--network monad`; tomorrow's ladder there is the live RCSS 2026-10-08 ladder on its live canonical books. All 38 steps behaved as expected: 39 transactions CONFIRMED through the executor, 1 transaction reverted on-chain by design (the sandwiched `sellYes`), and 7 expected errors: outcome locked, set held after the sandwich, off tick, not your order, non-canonical market, policy denial, gateway 400. Settlement went through the real MockKeystoneForwarder bytecode, then redeem ran after the 900 s challenge window. | `harness-v1/SUMMARY.txt`, the per-command `NN-*.txt` files, `harness-v1/stub.log`, `harness-v1/TX-TABLE.md` |
| **Feasibility contracts, same harness.** This deployment has no on-chain registry, so markets come from the deployment file plus the plugin's canonical-book check. All 38 steps behaved as expected, with 39 transactions CONFIRMED and the same sandwich result. The maker snapshot was ignored for all four strikes (same seriesIds, different books), so `quote` fell back to the plugin's own Polymarket read and said why. | `harness-feasibility/SUMMARY.txt`, `harness-feasibility/04-quote-tomorrow.txt` |
| **N1 replay in the real host.** The stub held the plugin's signed `Zap.sellYes` and first ran `harness/sandwich.mjs`: an impersonated attacker sold into every bid of the Tmax≥30 book and left 0.001 × 5. The plugin had planned 10 NO with `minAusdOut` 3.608238 (worst case 0.6392 per NO). Its `sellYes` reverted with `Slippage(4995, 3608238)`; the command stopped with `ISOTHERM_SET_HELD` and `redeem --merge` returned the 10 AUSD. Control at the same post-attack state: the pre-fix `Zap.buyNo` with the same amount and bound would fill 5 NO for 4.995 AUSD, 0.999 per NO. | `harness-v1/20,21,22-*.txt` (20 includes the stub's front-run record with the control) |
| **Signed transactions reach the backend.** Each step arrives at the backend stand-in as a signed request with our gas limit, for example `{"kind":"tx-request","chainId":10143,"to":"0x1acaf479…","intent":"Isotherm buyYes Tmax>=30C Taipei 2026-10-08","signed":true}`. | `harness-v1/stub.log` |
| **Exact plan for `buy --side yes`.** The plan was `spendAusd 20.000000, expectedYes 47.122641, minYesOut 46.887027`. The simulation returned `47122641`, matching the `ZapBuyYes` event, on the registry book `0x702A…36DC`. | `harness-v1/07-buy-yes.txt` |
| **`buy --side no` (new route).** Exact AUSD approval to the vault, exact YES approval to the Zap, `vault.mintSet(10)`, then `Zap.sellYes(10 YES, minAusdOut 8.240301)` into the 0.829 bid. Result: 10 NO for 1.718290 AUSD net, 0.1718 per NO, inside the planned worst case 0.1760 (`result.withinWorstCase: true`). | `harness-v1/08-buy-no-dryrun.txt`, `09-buy-no.txt` |
| **Sell flows.** `sell --side yes` and `sell --side no` (exact-out buy-back, then merge), and `redeem --merge` all work. | `harness-v1/14,15,19-*.txt` |
| **Kuru commands on our book and on a third-party book.** `kuru limit` ran approve, MarginAccount deposit of the exact shortfall, then a post-only `addBuyOrder` and returned the order id. `kuru cancel --all --withdraw` freed the margin. The same commands also worked on the Kuru spike's SpikeToken/AUSD market, which is not an Isotherm book. | `harness-v1/24,27,29,30-*.txt` |
| **Refusals before signing.** `ISOTHERM_OUTCOME_LOCKED` (observed RCSS max 28 °C ≥ 28, from live aviationweather.gov), `ISOTHERM_NONCANONICAL_MARKET` (a `--market` that differs from the registry), `KURU_OFF_TICK` and `KURU_NOT_YOUR_OPEN_ORDER`. (`ISOTHERM_NO_LIQUIDITY` was hit in earlier runs when the book had no depth inside the limit; its message names the best bid or ask.) | `harness-v1/10,31,25,26-*.txt` |
| **Host-side failures map to clear codes.** A toy Guard allowlist on the stub gives `ISOTHERM_TX_DENIED`, decoded from mm's `TRANSACTION_REQUEST_FAILED` with terminalStatus DENIED; the stub log shows `tx-denied` and no broadcast. Removing `customEvmChains[10143]` gives `ISOTHERM_CHAIN_NOT_CONFIGURED`, from the real gateway-style 400 `Invalid chainId`. | `harness-v1/32,33-*.txt` |
| **Fair value from the maker snapshot.** For the live 2026-10-08 ladder, `quote` reads `GET /api/snapshot` (29 s old in the run), checks each strike's seriesId and book against the chain, and shows `fairValue` with `fairValueSource: maker-snapshot` and the maker's v0 as the guardrail. For the fork-only 2026-10-07 ladder it falls back to `polymarket-live` with the plugin's v0-lite, and says so. | `harness-v1/03,04,05-*.txt` |
| **Setup-script issues from the verifier are fixed.** On a truly empty `HOME`, `ISOTHERM_TGZ=./mm-plugin-isotherm-0.1.0.tgz sh scripts/setup-mm-monad.sh` (a bare relative path) installs the plugin, gets all 11 commands consented, writes `customEvmChains[10143]` and exits 0. Writing the chain entry *before* `mm init` is safe: after `mm init --wallet byok` the entry is still there. | `01-setup-fresh-home.txt`, `03-harness-setup-then-init.txt`, `harness-v1/00-setup.txt` |
| **Signed-out host, live Monad testnet.** `doctor`, `markets --all`, `quote taipei --date 2026-10-08`, `edge`, and `quote tokyo` all return `ok:true` using the bundled v1 deployment; the Taipei quote shows the live ladder's books with fair values from the live maker snapshot. A `buy` stops at the host's auth gate (`mm login` needed). | `02-readonly-live-signed-out.txt` |
| **Tarball ready.** `mm-plugin-isotherm-0.1.0.tgz`, 48 files, 81.4 kB (repacked after the review fixes). It bundles the v1 `deployments/testnet.json` and `packages/abi/*.json`, with sha256 hashes in `assets/bundle-info.json`. A leak check found no wallet key and no mnemonic in the tarball or the package tree, apart from the gitignored `harness/.secrets/`. | `npm-pack.txt` |

### Numbers
- **Gas per user trade.** Monad bills the limit; MON below is at 102 gwei.
  - `Zap.buyYes`: estimate about 466k, limit 582,547 (×1.25), 0.059 MON.
  - Buy NO (new route): `vault.mintSet` limit 252,139 (×1.1) + `Zap.sellYes` limit 594,378, 0.086 MON once
    approvals exist; plus two exact approvals (77,748 + 68,979) the first time, 0.101 MON in all. The old single
    `Zap.buyNo` was 788,552, 0.080 MON.
  - `Zap.sellYes`: limit 594,588, 0.061 MON.
  - Exact approve: limit 77,748, 0.008 MON.
  - `vault.redeem`: limit 161,627 to 200,459, 0.017 to 0.020 MON.
- **Whole v1 suite.** 39 confirmed transactions; the 36 with gas figures total 9,374,306 gas limit, about 0.96 MON.
- **Host wall time.** 0–3 s per command (up to 8 s for the sandwiched step, which includes the harness's attack),
  including mm start-up and the Polymarket, Open-Meteo, aviationweather and Isotherm API calls.

## 2. What does not work, or is not verified

| # | Gap | Closest working path |
|---|---|---|
| 1 | **No real MetaMask sign-in yet.** The submit path through Mimir (MetaMask's signing service) with a real account has never been exercised. Guard-Mode email approvals and server-wallet policy YAML are also untested. | The harness proves everything up to the signing-service HTTP hop. `ISOTHERM_AWAITING_APPROVAL` and `ISOTHERM_TX_DENIED` handling is implemented. Human action 2 closes the gap. |
| 2 | **The plugin cannot edit the Guard allowlist.** The policy YAML is server-defined and changing it needs MFA. | `mm weather doctor` prints the allowlist targets. The human edits the policy with `mm wallet policy get` and `mm wallet policy set`. |
| 3 | **Buy NO is two transactions, not one.** The fix for N1 mints first and then sells. If the sell fails after the mint (the book moved, or the bound reverted it), the wallet holds complete sets. | Nothing is lost: the command stops with `ISOTHERM_SET_HELD`, says how many YES+NO the wallet holds, and gives the two exact follow-ups (`redeem --merge` at par, or `sell --side yes` at the same limit). Shown in harness steps 20–22. A Zap redeploy with `minNoOut` would allow one transaction again. |
| 4 | **No `arb vs mm predict` command.** Plugins cannot call `mm predict`. | `weather edge` reads Polymarket's public gamma API directly, the same data `mm predict` uses. |
| 5 | **`targetChains` covers 10143 only.** mm 7.0.0 does not enforce the field anyway. The plan mentions 143 for reading mainnet ForecastCommits. | Not built. A read-only `weather commits` command is a small follow-up. |
| 6 | **The plugin's own guardrail (v0-lite) is crude.** It is a raw Open-Meteo 4-model mean with σ ≈ 1.5 °C and no bias correction; on 2026-10-08 Taipei it put P(Tmax ≥ 29) at 0.346 against Polymarket's 0.860. | It is now only a fallback. When the maker snapshot is fresh and matches the chain, the guardrail is the maker's bias-corrected v0 (0.869 for the same strike), and `fairValue` is the maker's Polymarket-implied value. Both are labelled (`guardrail.source`, `GUARDRAIL ONLY`). |
| 7 | **The harness uses an anvil fork.** Anvil does not enforce Monad's reserve-balance rule, and its gas price decays, so `maxMonBilled` on the fork is tiny. | The README tx table recomputes cost at 102 gwei. |
| 8 | **The maker snapshot is trusted for display only.** It comes from the Isotherm API, which anyone holding the snapshot token can write. | It never sizes a trade, sets a min-out or picks a market. A strike is used only if it is under 10 minutes old and its seriesId and book match the chain; out-of-range numbers are dropped. |

## 3. Interfaces for the other workstreams

- **Maker / daily roll.** The plugin finds a strike's book only through `IsothermZap.canonicalMarket(seriesId)` on v1.
  Every book must therefore be registered with `setCanonicalMarket` by the operator; otherwise `buy` and `sell`
  refuse with `ISOTHERM_NONCANONICAL_MARKET`. Books must use the standard params (pp 1e4, sp 1e6, tick 10,
  taker ≤ 30 bps).
- **Contracts.**
  - Deployments: the loader accepts the current flat `deployments/testnet.json` and is tolerant of nested shapes.
  - ABIs: it reads `packages/abi/*.json` (array or `{abi}`).
  - Rebuild the plugin (`npm run build`) after any redeploy, because the bundle is copied at build time.
  - Wish list: `minNoOut` on `buyNo` (then Buy NO could go back to one transaction), and optionally a `sellNo`.
- **API.** The plugin reads `GET /api/snapshot` and uses, per strike: `k`, `seriesId`, `market`, `fair`, `pmImplied`,
  `model` (or `guard`), `flags`, and `fairSource`/`guardSource` if the API starts passing them through (it infers the
  fair-value basis from `flags` until then). Renaming `fair`, `model` or `generatedAt` would make the plugin fall back
  to its own Polymarket read.
- **apps/web and apps/api.** Reusable pure helpers for anyone who needs them:
  - `src/lib/plan.ts`: integer book walks and min-out;
  - `src/lib/weather.ts`: Polymarket-implied ladder, METAR observed max, `parseDateArg`;
  - `src/lib/kuru.ts`: L2 decode and open-order scan.
- **Override for forks and redeploys.** Env `ISOTHERM_DEPLOYMENTS=<json>`, with optional `ISOTHERM_ABI_DIR` and
  `ISOTHERM_RPC_URL`.

## 4. Human actions

1. **Publish to npm.** The name was free on 2026-10-06; re-check it.
   ```sh
   cd packages/mm-plugin                  # from the repo root
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
   - The live Taipei ladder (RCSS 2026-10-08) trades until 2026-10-08 09:30 UTC (17:30 Taipei). Run:
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
  - `snapshot.ts`: the maker snapshot client and the fair-value / guardrail choice;
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
  - `run-all.sh` (full evidence run), `fork-scenario.mjs`, `prices.py`, `sandwich.mjs` (N1 replay), `settle-fork.mjs`, `tx-table.mjs`, `reinstall.sh`;
  - `stub-backend.mjs`, `seed-session.py`, `bin/mm`, `bin/mm-harness`;
  - `host/`, an isolated mm 7.0.0 install;
  - `.secrets/`, a gitignored test-only mnemonic.
- **`SKILL.md`, `README.md`** (bounty mapping, tx table, publish steps), **`evidence/`**.
- **`mm-plugin-isotherm-0.1.0.tgz`:** the packed tarball. It is gitignored and rebuilt by `npm pack`.
