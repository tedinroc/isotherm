# mm-plugin-isotherm

A plugin for the MetaMask Agent Wallet CLI (`mm`, `@metamask/agent-wallet` 7.x). It gives an agent wallet two
new trading abilities on Monad testnet (chain 10143):

1. **Weather strike ladders (Isotherm).** Read, price-check and trade daily "Tmax >= k °C" contracts for Asian
   cities. Each strike is a fully collateralized YES/NO pair (1 AUSD per complete set). YES trades on its own
   Kuru v1 order book. Settlement uses the airport METAR station (Taipei RCSS, Tokyo RJTT).
2. **Generic Kuru v1 CLOB orders.** Resting limit orders and cancels on *any* Kuru v1 market, with automatic
   MarginAccount top-ups.

Every write goes through `ctx.walletExecutor`, so MetaMask's signing service and policy (Guard Mode) see each
transaction before it is broadcast. The plugin never holds a key.

> **Testnet only.** Monad testnet, faucet AUSD, no real money. The `edge` command shows a price gap between our
> book and the Polymarket-implied probability; it is **not a forecast**. Isotherm's own forecast model loses to
> Polymarket in backtest (Brier 0.0656 vs 0.0594 over 381 station-days), so the plugin shows it only as a
> guardrail.

## Commands

| Command | Capabilities | What it does |
|---|---|---|
| `mm weather markets [city] [--date D] [--all]` | wallet-read | Lists ladders with their state, close time, and each strike's canonical Kuru book (best bid and ask). |
| `mm weather quote <city> [--date D]` | wallet-read | Per strike: our book's bid, ask and size; the Polymarket-implied P(Tmax ≥ k); the v0-lite guardrail; the observed max so far today (METAR and SPECI). |
| `mm weather edge <city> [--date D] [--min-gap g]` | wallet-read | Book vs Polymarket-implied, after Kuru's taker fee. When the gap is large it suggests a ready command. A large disclaimer is attached. |
| `mm weather positions [--address A]` | wallet-read | YES and NO balances per strike, with a mark or the redeemable AUSD, and a `nextAction` for each. Also shows AUSD, MON and the Zap allowance. |
| `mm weather doctor` | wallet-read | Checks the 10143 chain config, RPC, contract code, wallet gas and AUSD, and lists Guard-allowlist targets. |
| `mm weather buy <city> --strike k --side yes\|no --amount AUSD --max-price p` | wallet-read, wallet-submit | YES: `Zap.buyYes` on the canonical book. NO: `Zap.buyNo` mints sets and sells the YES leg. Both use a book walk and a min-out guard. |
| `mm weather sell <city> --strike k --side yes\|no --amount N --min-price p` | wallet-read, wallet-submit | YES: `Zap.sellYes`. NO: buys exactly N YES, then merges YES and NO into AUSD. |
| `mm weather redeem <city> --date D [--strike k] [--merge] [--burn-losers]` | wallet-read, wallet-submit | After settlement it pays the winners. Before settlement, `--merge` turns YES+NO pairs back into AUSD. |
| `mm kuru book <market>` | wallet-read | Any Kuru v1 market: params, L2 depth, your open orders and MarginAccount balances. |
| `mm kuru limit <market> --side buy\|sell --price p --size n [--take]` | wallet-read, wallet-submit | Post-only limit order by default. It deposits exactly the margin shortfall first and reports the order id. |
| `mm kuru cancel <market> (--order ids \| --all) [--withdraw]` | wallet-read, wallet-submit | Cancels only your own open orders, then can withdraw the freed margin. |

All commands accept `--json`, so they are machine-readable for agents. Commands that submit transactions also
accept these flags:
- `--dry-run`: plan only, nothing is signed.
- `--slippage-bps`: default 50.
- `--gas-mult`: default 1.25 for book trades and 1.1 otherwise.
- `--approve exact|max`: default exact.
- `--rpc`: the RPC used for reads.

[SKILL.md](SKILL.md) teaches a Claude Code agent how to use all of this safely.

## Safety built into the plugin

These checks run before anything is signed:

- **Canonical book only.** The plugin resolves each series' market in this order:
  1. the on-chain registry `IsothermZap.canonicalMarket(seriesId)` (v1);
  2. the deployment file;
  3. `--market`.

  It then checks the market against Kuru's router, `verifiedMarket`: base must be the series YES token, quote
  must be AUSD, decimals 6/6, precisions 1e4 and 1e6, taker fee at most 30 bps, and maker fee no higher than the
  taker fee. A `--market` that disagrees with the registry is refused. This closes security finding #4
  (the hostile 90%-fee second book) even on the feasibility Zap, which has no registry.
- **Price limits are mandatory.** The plugin walks the live L2 book with integer math and spends only what fills
  within `--max-price` (or `--min-price`). The on-chain min-out is the walk result minus the slippage. The walk
  reproduces recorded fills exactly: 20 AUSD at 0.44 gives 45.409090 YES (live Kuru spike), and 40 YES into a 0.28
  bid gives 11.188800 AUSD (e2e).
- **Simulation before submit.** After any approval, the Zap call is `eth_call`-simulated from the wallet. A revert
  is decoded, for example `Slippage(…)`, `MarketMismatch(…)` or `TradingClosed(…)`. For `buy --side no`, the
  simulated NO price is checked again, because the Zap bounds only the AUSD coming back.
- **Outcome-locked refusal.** If today's observed METAR max has already reached k, buying NO or selling YES on that
  strike is refused (`ISOTHERM_OUTCOME_LOCKED`).
- **Trading stops at close.** After a ladder's close time the plugin refuses to trade, because books keep matching
  after close (security finding #5).
- **Monad gas.** Monad bills the gas *limit*. Every step estimates gas first, then sends
  `limit = ceil(estimate × multiplier)`, and reports the limit and the maximum MON billed.
- **Clear failures.** Policy denial, expired approval, the 10143 gateway 400, a missing sign-in and Guard approval
  waits each map to a specific error code with a hint. The message also lists the steps that already confirmed.

## Install and setup

**The 10143 problem.** In mm 7.0.0, MetaMask's hosted RPC gateway answers HTTP 400 `Invalid chainId` for 10143. The
plugin's *reads* fall back to the RPC in your `customEvmChains[10143]` entry, and then to the public Monad RPC.
*Signing* needs that chain entry to exist.

**The install bug.** On 7.0.0, `mm plugins install <npm-name>` prints "installed" and then silently uninstalls the
plugin. Installing from the registry **tarball URL** works.

`scripts/setup-mm-monad.sh` handles both problems:

```sh
npm i -g @metamask/agent-wallet@7.0.0
curl -fsSL https://unpkg.com/mm-plugin-isotherm@0.1.0/scripts/setup-mm-monad.sh -o setup-mm-monad.sh
sh setup-mm-monad.sh
#  -> mm config set experimentalPlugins true
#  -> mm config set experimentalAllowUnverifiedInstalls true
#  -> mm plugins install https://registry.npmjs.org/mm-plugin-isotherm/-/mm-plugin-isotherm-0.1.0.tgz --accept-permissions
#  -> writes ~/.metamask/wallets.json#data.customEvmChains[10143] (rpcTarget = public Monad testnet RPC)
mm weather doctor --json        # read-only; no sign-in needed
mm weather markets --json
mm weather quote taipei --json
# Trading also needs these, once:
mm login && mm init     # plus testnet MON (https://faucet.monad.xyz) and testnet AUSD (faucet contract)
```

The script fixes two problems that the independent verifier found in the spike version:
- **Fresh-home crash.** The chain step now creates `~/.metamask/wallets.json` if it is missing. The harness checks
  that `mm init` keeps the entry afterwards.
- **Local tarball paths.** A local path such as `ISOTHERM_TGZ=./mm-plugin-isotherm-0.1.0.tgz` is now given the
  `file:` prefix automatically. Without it, oclif reads a bare path as a GitHub ref.

The chain writer is inlined in the script, so the single downloaded file is enough. The optional
`scripts/rpc-shim.mjs` also repairs `ctx.publicClient(10143)` for other commands.

**Guard Mode allowlist.** If your server wallet uses a policy allowlist, `mm weather doctor` lists the contracts this
plugin calls:
- the Zap;
- the CollateralVault;
- AUSD;
- Kuru's MarginAccount;
- each strike's market.

The policy YAML format is server-defined. Change it with `mm wallet policy get` and `mm wallet policy set`, which
needs MFA approval.

## Deployment, addresses, ABIs

- **Build-time bundle.** `npm run build` copies the repo's single source of truth into the package:
  - `deployments/testnet.json` to `assets/deployments.testnet.json`;
  - `packages/abi/*.json` to `assets/abi/`;
  - sha256 hashes to `assets/bundle-info.json`.
- **Fallback.** The 2026-10-06 feasibility deployment always ships in `assets/deployments.feasibility.json` and
  `assets/abi-feasibility/`.
- **Override.** `ISOTHERM_DEPLOYMENTS=<json>` and, optionally, `ISOTHERM_ABI_DIR` override the bundled deployment
  (forks, newer deploys).
- **ABI matching.** Zap calls are encoded by matching ABI parameter *names*. A future Zap signature, for example one
  that drops `market` or adds `minNoOut` or `deadline`, is followed without code changes. Unknown parameters are
  refused.

## Evidence: every command in the real mm 7.0.0 host

**How the harness works.** `harness/run-all.sh` runs:
- the real `@metamask/agent-wallet@7.0.0` binary;
- with a fresh isolated `HOME`;
- against an anvil fork of live Monad testnet (`--network monad`), with fresh-fork blocks recorded in each run.

`harness/stub-backend.mjs` stands in for MetaMask's backend on 127.0.0.1. It receives the host's locally signed
BYOK transaction and broadcasts it to anvil, as the signing service would. Nothing reaches MetaMask's servers or
the live chain.

**How the market is built.** `harness/fork-scenario.mjs` builds it with impersonated accounts:
- today's and tomorrow's Taipei ladders;
- one Kuru book per strike, registered on the v1 Zap;
- maker quotes around the Polymarket-implied fair value.

`harness/settle-fork.mjs` settles today's ladder through the real CRE MockKeystoneForwarder bytecode, using a
throwaway attester (fork only).

| Run | Result | Folder |
|---|---|---|
| v1 contracts (`deployments/testnet.json`, on-chain canonical registry) | all 34 steps as expected: 27 transactions CONFIRMED (including settlement and redeem after the 900 s challenge window), 1 policy denial, and every expected refusal | [`evidence/harness-v1/`](evidence/harness-v1/SUMMARY.txt) |
| feasibility contracts (fallback, no registry) | all 34 steps as expected: 27 transactions CONFIRMED, including settlement and redeem | [`evidence/harness-feasibility/`](evidence/harness-feasibility/SUMMARY.txt) |
| signed-out host on **live** testnet (read only) | `doctor`, `markets`, `quote` and `edge` work with no `mm login` | [`evidence/02-readonly-live-signed-out.txt`](evidence/02-readonly-live-signed-out.txt) |
| fresh `HOME` setup with a bare local tarball path | install and chain entry succeed | [`evidence/01-setup-fresh-home.txt`](evidence/01-setup-fresh-home.txt) |

### Transaction table (v1 run, anvil fork of live Monad testnet)

Monad bills the gas **limit**. The MON column is limit × 102 gwei, the live testnet price. These are fork
transactions, not live ones. The full table, with gas estimates and fork gas used, is in
[`evidence/harness-v1/TX-TABLE.md`](evidence/harness-v1/TX-TABLE.md).

| Plugin command | Transaction (intent shown to MetaMask) | Gas limit | MON billed |
|---|---|---|---|
| `weather buy … --side yes` | AUSD approve (exact) | 77,748 | 0.0079 |
| | `Zap.buyYes` Tmax≥30C | 582,504 | 0.0594 |
| `weather buy … --side no` | `Zap.buyNo` Tmax≥29C (mint set, sell YES leg) | 788,552 | 0.0804 |
| `weather sell … --side yes` | YES approve + `Zap.sellYes` | 68,979 + 594,320 | 0.0676 |
| `weather sell … --side no` | `Zap.buyYes` (exact-out) + `vault.redeemSet` | 578,617 + 175,978 | 0.0769 |
| `weather redeem --merge` | `vault.redeemSet` | 175,992 | 0.0180 |
| `weather redeem` (after settlement) | `vault.redeem` per strike held | 161,640 | 0.0165 |
| `kuru limit` (first use) | approve + MarginAccount deposit + `addBuyOrder` (post-only) | 77,735 + 156,192 + 264,333 | 0.0508 |
| `kuru cancel --all --withdraw` | `batchCancelOrdersNoRevert` + `batchWithdrawMaxTokens` | 191,785 + 131,894 | 0.0331 |

## Bounty mapping: MetaMask "Best Agent Wallet Plugin" (Track 01)

| Requirement / judging point | Where |
|---|---|
| Plugin for the MetaMask Agent Wallet via its plugin architecture | oclif plugin, every command extends the published `PluginCommand` (sealed lifecycle, only `execute`). `@metamask/agent-wallet ^7.0.0` is a **peerDependency**. No install scripts, no oclif hooks. |
| Capabilities declared per command | `package.json#mm`: every command is `wallet-read`, and the 5 submit commands add `wallet-submit`. `targetChains [10143]`. A unit test checks that the manifest, the oclif manifest and each class's `pluginCommandId` agree. |
| Writes through the agent wallet | Every transaction goes through `ctx.walletExecutor`, with an `intent.summary` per step and `emitStepNotices` for multi-step flows. The stub log shows each request arriving signed (`signed:true`, `txKeys` incl. `gasLimit`). |
| "New trading superpower" | A new asset class: weather strikes, with a book walk, a Polymarket cross-venue gap, an observed-max guard, canonical-book protection and settlement redemption. Plus generic Kuru v1 CLOB limit and cancel on Monad, which mm's built-in commands cannot do. |
| Works in the real host | Real `mm` 7.0.0 binary, tarball install with consent, `--json` outputs in `evidence/`. |
| Monad support despite the host gap | Read fallback, a self-contained setup script, `weather doctor`, and mapping of the gateway 400 error. |
| Agent-ready | `SKILL.md`, `--json` everywhere, `--dry-run`, structured error codes with hints. |

## Development

```sh
npm ci
npm run build                           # bundle-assets + tsc + oclif manifest
npm test                                # 27 unit tests (pure logic, captured fixtures)
sh harness/run-all.sh                   # full v1 run in the real host on an anvil fork (ports 19251/19288)
sh harness/run-all.sh assets/deployments.feasibility.json feasibility
npm pack                                # -> mm-plugin-isotherm-0.1.0.tgz
```

The harness needs:
- Foundry `anvil` and `cast`;
- `harness/host` (`npm ci` there);
- a test-only BYOK mnemonic in `harness/.secrets/mnemonic.txt` (gitignored; create one with
  `cast wallet new-mnemonic`).

## Publishing (a human step)

```sh
cd packages/mm-plugin
npm ci && npm test && npm run build
npm view mm-plugin-isotherm             # expect 404 (name free)
npm login                               # the publisher's npm account
npm publish --access public             # prepack rebuilds and bundles the current deployments/testnet.json
npm view mm-plugin-isotherm@0.1.0 dist.tarball
```

If the contracts are redeployed, bump the version and publish again, because the addresses are bundled at publish
time. Users can always point at a newer file with `ISOTHERM_DEPLOYMENTS`.

## Facts and limits

- **Settlement rule.** The integer °C METAR max for the station-local day, including SPECI and :30 reports. It
  matches Polymarket's resolved bucket on 183/184 RCSS days and 209/209 RJTT days. Shenzhen and Seoul are listed as
  cities, but their fidelity is not measured.
- **What the plugin talks to.** Polymarket's public gamma API, aviationweather.gov and Open-Meteo, all keyless.
  Plugins cannot call `mm predict`.
- **Not exercised yet.** Real MetaMask sign-in, Mimir broadcasting a 10143 transaction, and Guard Mode email
  approvals. All three need a human sign-in. See `RESULT.md`.

MIT licensed.
