---
name: isotherm-weather-trading
description: Read and trade Isotherm daily max-temperature strike ladders (Taipei, Tokyo; YES/NO tokens on Kuru v1 order books, Monad testnet 10143) and place or cancel limit orders on any Kuru v1 market, through the MetaMask Agent Wallet `mm` CLI with the mm-plugin-isotherm plugin. Use when the user asks about "Tmax >= k" temperature markets, Isotherm, Kuru order books on Monad testnet, or wants an agent to quote, compare with Polymarket, buy, sell or redeem weather strikes.
---

# Isotherm weather ladders via `mm` (MetaMask Agent Wallet plugin)

Each strike is "official integer METAR daily max at the station >= k °C" for one station-local day
(Taipei = RCSS, Tokyo = RJTT). YES pays 1 AUSD if it happens, NO pays 1 AUSD if not, a void pays 0.5/0.5.
A complete YES+NO set always costs exactly 1 AUSD. Only YES has a Kuru order book; NO is bought by minting
a set and selling the YES leg (the IsothermZap does this in one transaction).

**This is Monad TESTNET with faucet AUSD. No real money. Never describe results as profit, and never claim a
forecasting edge**: Isotherm's own model loses to Polymarket in backtest. `weather edge` shows a price gap between
two venues, not a prediction.

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
| `mm weather quote <city> [--date D] --json` | per strike: our book (`book.bestBid/bestAsk/sizes`), `polymarketImplied`, `v0Guardrail`, `observedLocked`, plus `observed.maxC` so far today |
| `mm weather edge <city> [--date D] [--min-gap 0.03] --json` | `yesCheapVsPolymarket` / `yesRichVsPolymarket` after Kuru's taker fee, with a ready `suggestion` command when the gap is large and the ladder is open |
| `mm weather positions [--address 0x…] --json` | balances per strike, mark or redeemable AUSD, and a `nextAction` per position |
| `mm kuru book <market> --json` | any Kuru v1 market: params, L2 depth, your open orders and MarginAccount balances |

`D` is `today`, `tomorrow`, `YYYY-MM-DD` or `yyyymmdd`, always station-local. Without `--date` the plugin picks
the open ladder that closes first.

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
- Approvals are exact by default (one extra approve tx per trade). `--approve max` approves the Zap once.
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
| `ISOTHERM_SERIES_GATED` | compliance-gated series: NO minting is allowlist-only | buy YES on the book instead |
| `ISOTHERM_AWAITING_APPROVAL` | Guard Mode wants the user's approval (email/app) | ask the user to approve, then re-run; confirmed steps are not repeated |
| `ISOTHERM_TX_DENIED` | MetaMask policy refused the transaction | user adds the doctor's allowlist targets |
| `ISOTHERM_CHAIN_NOT_CONFIGURED` | executor cannot reach 10143 | user runs `scripts/setup-mm-monad.sh` |
| `ISOTHERM_NOT_SIGNED_IN` | no mm session | user runs `mm login` and `mm init` |

## Typical agent loop

1. `mm weather quote taipei --json` and summarise the book vs `polymarketImplied` for each strike; mention
   `observed.maxC` if the ladder is today's.
2. Only if the user wants to trade: `--dry-run`, show `plan` (spend, expected tokens, average price, min-out,
   gas limit), confirm, then send the same command without `--dry-run`.
3. Report `tx`, `balancesAfter`, and `steps[].explorerUrl` (testnet.monadexplorer.com).
4. After the day: `mm weather positions --json`, then `mm weather redeem <city> --date D --json` for winners.

## Facts you may state (and nothing stronger)

- Settlement rule: integer °C METAR max for the station-local day, including SPECI and :30 reports. It matches
  Polymarket's resolved bucket on 183/184 Taipei (RCSS) days and 209/209 Tokyo (RJTT) days.
- Settlement reports arrive through Chainlink CRE (on testnet today: the CRE simulation forwarder) and must carry
  the Isotherm attester's EIP-712 signature; results are write-once, redeemable after a short challenge window.
- Testnet only, faucet AUSD, no profit claims, no forecasting-edge claims.
