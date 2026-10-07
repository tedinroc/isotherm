---
name: isotherm-weather-trading
description: Read and trade Isotherm daily max-temperature strike ladders (Taipei, Tokyo; YES/NO tokens on Kuru v1 order books, Monad testnet 10143) and place or cancel limit orders on any Kuru v1 market, through the MetaMask Agent Wallet `mm` CLI with the mm-plugin-isotherm plugin. Use when the user asks about "Tmax >= k" temperature markets, Isotherm, Kuru order books on Monad testnet, or wants an agent to quote, compare with Polymarket, buy, sell or redeem weather strikes.
---

# Isotherm weather ladders via `mm` (MetaMask Agent Wallet plugin)

Each strike is "official integer METAR daily max at the station >= k °C" for one station-local day
(Taipei = RCSS, Tokyo = RJTT). YES pays 1 AUSD if it happens, NO pays 1 AUSD if not, a void pays 0.5/0.5.
A complete YES+NO set always costs exactly 1 AUSD. Only YES has a Kuru order book; NO is bought by minting
sets in the CollateralVault and selling exactly that YES through `IsothermZap.sellYes` with a min-out bound
(two transactions, plus approvals; `Zap.buyNo` is deliberately not used because its bound fails under partial fills).

**This is Monad TESTNET with faucet AUSD. No real money. Never describe results as profit, and never claim a
forecasting edge**: Isotherm's own model loses to Polymarket in backtest. The house maker quotes around the
Polymarket-implied probability. `weather edge` shows a price gap between two venues, not a prediction.

## Before anything

```sh
mm weather doctor --json        # chain config, RPC, deployment, wallet MON/AUSD, Guard allowlist targets
```
- `checks[].ok == false` with a `fix` field: tell the user the fix. "mm customEvmChains[10143]" missing means
  trades will fail; the fix is the bundled `scripts/setup-mm-monad.sh` (a human runs it once).
- "mm gateway ctx.publicClient(10143)" failing is expected and harmless (the plugin reads through its own RPC).
- Read commands work without `mm login`. Trades need `mm login` + `mm init`, testnet MON for gas
  (https://faucet.monad.xyz, human step) and testnet AUSD (faucet contract in the doctor output).

## Read (wallet-read, no signing)

| Command | Use it to |
|---|---|
| `mm weather markets [city] [--date D] [--all] --json` | list ladders: state (`open`/`closed`/`awaiting-settlement`/`settled`/`void`), close time, every strike's canonical Kuru market and best bid/ask |
| `mm weather quote <city> [--date D] --json` | per strike: our book (`book.bestBid/bestAsk/sizes`), `fairValue` with `fairValueSource`, `polymarketImplied` (the plugin's own live read), `guardrail`, `observedLocked`, plus `observed.maxC` so far today |
| `mm weather edge <city> [--date D] [--min-gap 0.03] --json` | `yesCheapVsPolymarket` / `yesRichVsPolymarket` against `reference` after Kuru's taker fee, with a ready `suggestion` command when the gap is large and the ladder is open |
| `mm weather positions [--address 0x…] --json` | balances per strike, mark or redeemable AUSD, and a `nextAction` per position |
| `mm kuru book <market> --json` | any Kuru v1 market: params, L2 depth, your open orders and MarginAccount balances |

`D` is `today`, `tomorrow`, `YYYY-MM-DD` or `yyyymmdd`, always station-local. Without `--date` the plugin picks
the open ladder that closes first.

How to read the price fields (and what to say about them):
- `fairValue` is the price the house maker quotes around. `fairValueSource: "maker-snapshot"` means it came from the
  maker's snapshot on the Isotherm API (fresh, and the same seriesId and book as on-chain); `"polymarket-live"` means
  the snapshot was missing or stale and the plugin used its own Polymarket read. `fairValueBasis` is normally
  `polymarket` (Polymarket-implied, conditioned on today's observed max during the day) or `certain`; a
  `fallback-*` basis means the maker had no usable Polymarket price and used its model, so say so.
- `reference` in `edge` is always Polymarket-based, never a model.
- `guardrail` is **GUARDRAIL ONLY**: a sanity check, not a forecast and not a fair value. `source: "maker-snapshot"`
  is Isotherm v0 (bias-corrected); `source: "plugin-v0-lite"` is a crude local fallback (raw Open-Meteo mean, no
  bias correction) that is often far from Polymarket. `guardrail.flag` = it differs from the reference by > 0.15.
  Never present the guardrail as a prediction or as a reason to trade.
- `makerSnapshot` at the top says whether the snapshot was used, its age, and why not (`note`).

## Trade (wallet-read + wallet-submit; every write goes through MetaMask's executor and policy)

Always run the same command with `--dry-run` first, show the user the `plan`, and get a yes before sending.

```sh
mm weather buy  <city> --strike K --side yes|no --amount <AUSD>  --max-price <p> [--date D] --dry-run --json
mm weather sell <city> --strike K --side yes|no --amount <tokens> --min-price <p> [--date D] --dry-run --json
mm weather redeem <city> --date D [--strike K] [--merge] --json
mm kuru limit  <market> --side buy|sell --price <p> --size <n> [--take] [--dry-run] --json
mm kuru cancel <market> (--order <id,…> | --all) [--withdraw] --json
```
- `--max-price` / `--min-price` are mandatory. The plugin walks the live L2 book, spends only what fills inside
  the limit (`plan.cappedByMaxPrice`), and sets the on-chain min-out to the walk result minus `--slippage-bps`
  (default 50). It simulates the Zap call after any approval and refuses if the simulation disagrees.
- Gas: Monad bills the gas LIMIT. The plugin estimates and sends limit = estimate x 1.25 for book trades
  (x 1.1 for approvals/redeems). Each step reports `gasLimit` and `maxMonBilled`.
- Approvals are exact by default (one extra approve tx per trade). `--approve max` approves once per spender.
- `buy --side no` = approve AUSD to the CollateralVault, approve YES to the Zap (each only if needed), then
  `CollateralVault.mintSet(N)` (N YES + N NO to the wallet), then `Zap.sellYes(N YES, minAusdOut)`. `plan.worstCaseNoPrice`
  is a hard on-chain bound: sellYes reverts rather than paying less than `minAusdOut`, and NO received is exactly N.
  The plugin re-reads the book just before minting and stops with nothing minted if the plan no longer holds.
- If the mint confirmed but the YES leg did not sell, the command fails with `ISOTHERM_SET_HELD`: the wallet holds
  N YES + N NO (worth exactly N AUSD together). **Do not re-run the buy** (it would mint again). Follow the hint:
  either `mm weather redeem <city> --date D --strike K --merge` (back to AUSD at par) or
  `mm weather sell <city> --date D --strike K --side yes --amount N --min-price <same limit>` to finish the NO purchase.
- `sell --side no` = buy that many YES on the book, then merge YES+NO into AUSD (two transactions).
- `redeem` after settlement pays winners; before settlement `--merge` turns YES+NO pairs back into AUSD. Losing
  tokens are skipped unless `--burn-losers`.
- `kuru limit` is post-only unless `--take`; it tops up your Kuru MarginAccount with exactly the shortfall first.

## Built-in refusals (nothing is signed) and what to do

| Code | Meaning | Do |
|---|---|---|
| `ISOTHERM_OUTCOME_LOCKED` | today's observed max already reached k, so that side has almost surely lost | don't trade it; explain why |
| `ISOTHERM_LADDER_CLOSED` | past close (the day's max is public by then) | wait for settlement, then `redeem` |
| `ISOTHERM_NO_LIQUIDITY` | no book depth inside your price limit | show the book; suggest a resting order via `kuru limit` |
| `ISOTHERM_NONCANONICAL_MARKET` | the market is not the series' registered YES/AUSD book or has non-standard params | never override; use `weather markets` |
| `ISOTHERM_PRICE_LIMIT` / `ISOTHERM_WOULD_REVERT` | simulation outside your limit, or the call would revert (reason decoded) | re-run to re-plan |
| `ISOTHERM_SET_HELD` | buy NO minted the sets but the YES leg was not sold (the book moved, or sellYes reverted on its bound) | do NOT re-run the buy; merge (`redeem --merge`) or sell the YES with the hinted `--min-price` |
| `ISOTHERM_SERIES_GATED` | compliance-gated series: minting (so buying NO) is allowlist-only | buy YES on the book instead |
| `ISOTHERM_AWAITING_APPROVAL` | Guard Mode wants the user's approval (email/app) | ask the user to approve, then re-run; confirmed steps are not repeated |
| `ISOTHERM_TX_DENIED` | MetaMask policy refused the transaction | user adds the doctor's allowlist targets |
| `ISOTHERM_CHAIN_NOT_CONFIGURED` | executor cannot reach 10143 | user runs `scripts/setup-mm-monad.sh` |
| `ISOTHERM_NOT_SIGNED_IN` | no mm session | user runs `mm login` and `mm init` |

## Typical agent loop

1. `mm weather quote taipei --json` and summarise the book vs `fairValue` for each strike (say where it came from:
   `fairValueSource`); mention `observed.maxC` if the ladder is today's. Mention the guardrail only as a labelled
   sanity check.
2. Only if the user wants to trade: `--dry-run`, show `plan` (spend, expected tokens, average price, min-out,
   gas limit), confirm, then send the same command without `--dry-run`.
3. Report `tx`, `balancesAfter`, and `steps[].explorerUrl` (testnet.monadexplorer.com).
4. After the day: `mm weather positions --json`, then `mm weather redeem <city> --date D --json` for winners.

## Facts you may state (and nothing stronger)

- Settlement rule: integer °C METAR max for the station-local day, including SPECI and :30 reports. It matches
  Polymarket's resolved bucket on 183/184 Taipei (RCSS) days and 209/209 Tokyo (RJTT) days.
- Settlement reports arrive through Chainlink CRE (on testnet today: the CRE simulation forwarder) and must carry
  the Isotherm attester's EIP-712 signature; results are write-once, redeemable after a short challenge window.
- Fair values are Polymarket-implied probabilities (from the house maker's snapshot or the plugin's own read); the
  house maker trades against users, so its fills are not organic volume.
- Testnet only, faucet AUSD, no profit claims, no forecasting-edge claims.
