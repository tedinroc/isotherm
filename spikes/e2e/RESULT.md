# Isotherm end-to-end integration: RESULT (2026-10-06)

**Verdict: yes, it can be built on Monad testnet, and the whole product loop now runs end to end.**
- **Fork run:** 59 real transactions on an anvil fork of live Monad testnet, all succeeded.
- **Rehearsal of the live code path:** 56 of 56 transactions succeeded with no cheats and today's real wallet balances (§3).
- **Foundry tests:** 2 in-process fork tests with exact asserts.
- **Not yet on the live chain.** The deployer holds 3.65 MON, below the 5 MON go-live rule. The read-only preflight says today's balances would already cover one run (3.69 MON in total), so it is one command away: `script/testnet-e2e.sh`.

The loop runs entirely against real live-testnet contracts:
- testnet AUSD and its faucet;
- the Kuru v1 Router, MarginAccount and new order books;
- the Chainlink CRE `MockKeystoneForwarder`.

It goes: deploy → Taipei ladder (28/29/30 °C) → the maker mints complete sets and quotes both sides on 3 new Kuru books → a taker buys YES on a book → a second user goes through the Zap (buy NO, buy YES) → the maker re-quotes, then pulls its quotes at close → the day ends → an attested CRE report (Tmax 29) arrives through the real mock forwarder (a replay is rejected) → redemptions: winners get 1, losers 0 → a void ladder pays 0.5/0.5 → a stale ladder is voided by anyone after 24 h → solvency checks.

## 1. What I ran (commands and real output)

### 1a. `make fork-e2e`: the full loop as real transactions (anvil fork, block 68,700,516)
`anvil --fork-block-number 68700516 --network monad` reports `network=monad hardFork=MonadTen`. The run uses the four real wallet addresses, funded with `anvil_setBalance`. Every transaction estimates gas, then sets limit = estimate × 1.10 (× 1.25 for taker market orders). Evidence: `logs/fork-2026-10-06T13-54-06/` (`console.txt`, `steps.tsv` with every tx hash, `summary.json`).

```
#1  deploy Resolver (forwarder=MockKeystoneForwarder, attester=deployer)  used 2534104  limit 2787515  0.2843 MON
#2  deploy CollateralVault (+OutcomeToken impl)                            used 4359857  limit 4795843  0.4892
#6  deploy IsothermZap                                                     used 1385339  limit 1523873  0.1554
#7  createLadder RCSS 20261007 strikes [28,29,30]                          used  848810  limit  933692  0.0952
#10 AUSD faucet.requestFunds -> maker                                      used  111414                  0.0126
#12 maker mintSet >=28 x500                                                used  279231  (repeat 262243) 0.031
    forecast: Taipei 20261007 Tmax mu=26 sigma=1.5 (Open-Meteo) -> P(>=k): 28:0.159 29:0.048 30:0.010
#17 Kuru Router.deployProxy YES>=28/AUSD  (x3)                             used 1310536  limit 1463712  0.1493
#28 maker quote >=28: 200@0.138 / 200@0.179  (1 bid + 1 ask, batchUpdate)  used  528262  limit  589552  0.0601
#33 taker1 Kuru market-buy YES>=29 for 12 AUSD                             used  306037  limit  392945  0.0401
    taker1 got 176.294117 YES>=29 in wallet (1 Trade event at 0.068; expected 176.294118)
#36 taker2 Zap.buyNo >=30 with 40 AUSD (mint set, sell YES)                used  653179  limit  816474  0.0833
    taker2 got 40.000000 NO>=30 + 0.039960 AUSD back; net NO price 0.9990 (1 - bid 0.001 - fee)
#37 taker2 Zap.buyYes >=28 with 30 AUSD                                    used  493583  limit  616979  0.0629
    Zap balance after both flows: 0 AUSD, 0 YES, 0 NO
#38 maker re-quote >=28: 200@0.148 / 132@0.189 cancel 2                    used  487056  limit  543502  0.0554
#41 maker pull quotes >=28 (batchCancelOrdersNoRevert x2)                  used  248833  limit  277331  0.0283
    book >=28C bestBid none bestAsk none   (same for 29, 30)
    anvil clock -> 2026-10-07T16:10:00Z (dayEnd + 10 min); vault.duePendingLadders -> RCSS/20261007, RJTT/20261007, ZGSZ/20261007
#44 CRE report RCSS tmax=29 via MockKeystoneForwarder                      used  152505  limit  220000  0.0224
    ReportProcessed.result=true  LadderResolved status=1 tmax=29  resultOf=(1, 29)
#45 CRE replay RCSS tmax=35                                                used  112335  -> ReportProcessed.result=false (write-once)
#46 CRE void report RJTT                                                   used  152415  -> accepted
#47 taker1 redeem YES>=29 x176.294117 (29>=29 wins)                        used  146595   payout == 176.294117
#48 taker2 redeem NO>=30 x40 (29<30: NO wins)                              payout 40
#51 maker redeem losing NO>=29 x500 -> pays 0                              used   99993   payout 0, tokens burned
#55/56 void RJTT: 100 YES -> 50 AUSD, 100 NO -> 50 AUSD
#57 anyone (taker1) voidIfStale ZGSZ after 24h                             used   67668   then 10 sets -> 10 AUSD
    vault AUSD 0.344069 == sum(series collateral) 0.344069 (remaining claims = Kuru's taker-fee YES)
TOTAL 59 txs: gas used 25,616,419, gas limit (billed) 28,748,689, 2.9324 MON at 102 gwei
E2E OK (fork)
```
- **CRE report shape.** The report goes through the real MockKeystoneForwarder bytecode, sent from an ordinary EOA. Its shape is byte-for-byte what `cre workflow simulate --broadcast` sends, as captured by the CRE spike: a 109-byte header (`0x01|execId|ts=100|don 1|cfg 1|workflowId 0x11…|name "7721568293"|owner 0xaa…|reportId 0x0001`), a 96-byte context and 4 signatures.
- **Why not impersonate the forwarder.** Impersonating it would skip its code. Going through the real mock is strictly more faithful, and it works on live too, because the mock is permissionless.
- **Attestation.** The attestation is an EIP-712 signature made by viem, independently of the Solidity code. It is cross-checked against `Resolver.settlementDigest` before sending.

### 1b. `make forge-e2e`: the same loop in-process with exact asserts (`test/integration/IsothermE2EFork.t.sol`)
`MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz FORK_BLOCK=68700516 forge test --match-path 'test/integration/*'` →
`[PASS] test_e2e_fullLoop()`, `[PASS] test_e2e_zapThinBook()`.

**`test_e2e_fullLoop` asserts:**
- The taker fill: 50 AUSD at the 0.57 ask gives 87,631,578 YES units.
- `buyNo` returns exactly 11,188,800 AUSD (40 YES into the 0.28 bid, minus the 0.1% fee).
- A market that is not the series' own book is refused (`MarketMismatch`).
- Both books are empty after close; 3 ladders are due.
- Settle = true, replay = false, void = true.
- Every payout is exact: winners 1, loser 0, void 0.5/0.5, stale void 1 per set.
- Vault AUSD == Σ collateral ≥ every outstanding claim. The Zap is left empty.

**`test_e2e_zapThinBook`** uses a book only 10 YES deep:
- `buyNo(40)` sells 10, merges the 30 unsold YES with 30 NO back into AUSD, and returns 10 NO + 32.997 AUSD. The user never holds YES.
- `buyYes(10 AUSD)` fills 4 AUSD and refunds 6.
- `sellYes(9.99)` sells 5 and refunds 4.99.
- Both slippage bounds revert.
- No allowance is left standing.

**Whole suite:** `MONAD_TESTNET_RPC=… FORK_BLOCK=68693965 forge test` → **84 tests passed, 0 failed, 0 skipped** (the 82 existing tests + 2 new). The integration tests pass at two different fork blocks (68,693,965 and 68,700,516).

**Mutation check on the Zap.** I injected 5 bugs one at a time, then restored the file and checked its hash:
- 4 were **caught**: series↔market binding removed, unsold YES not merged, refund dropped, buyNo slippage check removed.
- 1 was **equivalent** (not detectable): removing the post-trade approval reset. Kuru v1 pulls the *full* input amount and refunds the unfilled part, so the allowance is consumed either way (checked on both buy and sell). The reset stays as a defensive measure.

### 1c. Rehearsal of the live code path: see §3.

### 1d. `make testnet-preflight` (read-only, live testnet)
```
chain 10143 block 68702642; dependencies have code: AUSD, faucet, MockKeystoneForwarder, KuruRouter, KuruMarginAccount
requirement per run: deployer 2.14, maker 1.08, taker1 0.17, taker2 0.3 = 3.69 MON
deployer 0xb855…5c11  3.6526 MON  need 2.14
maker    0xd572…448a  0.3528 MON  need 1.08  top-up 0.7272 from deployer
taker1   0x636D…d4b5  0.1366 MON  need 0.17  top-up 0.0334 from deployer
taker2   0x0290…e727  0.0000 MON  need 0.30  top-up 0.3000 from deployer
deployer needs 3.2081 MON (own 2.14 + top-ups 1.0681), has 3.6526 -> READY
```

## 2. User flow and the Zap (decision)
Only YES has a book (one Kuru v1 YES/AUSD market per strike). NO is never listed. That gives these flows:

| User intent | Path | Gas (used / billed MON) |
|---|---|---|
| Buy YES ≥k | `Zap.buyYes(seriesId, market, ausdIn, minYesOut, to)`: book buy, unspent AUSD refunded. Direct `placeAndExecuteMarketBuy` also works but needs a new approval per market per day. | 493,583 / 0.063 |
| **Buy NO ≥k** | `Zap.buyNo(...)`: mint a complete set, sell the YES leg on the book, keep the NO. Net price = 1 − bid − fee. Any unsold YES is merged back into AUSD (`redeemSet`). This flow genuinely needs a contract. | 653,179 / 0.083 |
| Sell YES | `Zap.sellYes(...)`, unsold YES refunded | tested on the fork |
| Exit with a YES+NO pair | `vault.redeemSet` (never paused) | ~160k |
| After settlement | `vault.redeem(id, yes, no)` | 146,595 / 0.016 |
| Sell NO before settlement | **Not built.** It needs an exact-output YES buy, then a merge. Kuru v1 market buys take a quote amount, not an exact output. The UI should offer "hold to settlement" or merge with YES. | n/a |

**What the Zap guarantees:**
- **Approve once, forever.** Kuru books are new contracts every day, so the Zap saves users one approval per market per day.
- **The market must be the series' own book.** It must be `Router.verifiedMarket(market)` with base == `vault.getSeries(id).yes` and quote == AUSD. A UI therefore cannot route funds into a lookalike book.
- **Funds come only from `msg.sender`.** The Zap holds nothing between transactions.
- **Bounded and contained trades.** It uses exact approvals, a reentrancy guard and SafeCast. Every flow has a min-out bound.

Source: `src/IsothermZap.sol` (~170 lines, MIT). It imports the core contracts unchanged; **I did not modify any core contract.**

## 3. Rehearsal of `make testnet-e2e`: the live code path, no cheats (`run-rehearsal.sh`)
This is the `MODE=live` code path, unchanged.
- **Command:** `./run-rehearsal.sh`. It runs `ts/preflight.ts`, then `MODE=live REHEARSAL=1 ts/e2e.ts`.
- **Target:** an anvil fork of the *current* live testnet (block 68,702,688), with `--block-time 1` so blocks keep coming as they do on a live chain.
- **No cheats:** no `setBalance`, no time travel. The four wallets keep their real live balances.

**Result: `E2E OK (live)`, 56 of 56 transactions with status success, 18 min 49 s wall clock (13:56:37 → 14:15:26 UTC).** Evidence: `logs/rehearsal-stdout.txt` and `logs/rehearsal-2026-10-06T13-56-37/ (anvil rehearsal, not the real chain)`.
```
REHEARSAL: live code path (no cheats) against an anvil fork; nothing reaches the real chain
# 1 MON 0.7273 deployer -> maker        # 2 MON 0.0335 deployer -> taker1      # 3 MON 0.3 deployer -> taker2
  (each transfer waits 4 blocks first: Monad "emptying tx" rule for accounts under 10 MON)
live fast mode: test stations ZZZZ/ZZZY at UTC+9.75h, local day ends in 18.1 min
faucet: global 60 s cooldown (MaxFrequencyExceeded), waiting 15 s   (x2, then claimed)
taker1 got 178.392856 YES>=29 ...   Zap balance after both flows: 0 AUSD, 0 YES, 0 NO
waiting for the ZZZZ local day to end: 17 min left ... 1 min left
#44 CRE report ZZZZ tmax=29 via MockKeystoneForwarder   used 152505 limit 220000 -> ReportProcessed.result=true resultOf=(1, 29)
#45 CRE replay -> ReportProcessed.result=false          #46 CRE void report ZZZY -> accepted
#47 taker1 redeem YES>=29 x178.392856 ...  #51 maker redeem losing NO>=29 x500 -> pays 0 ... void: 100 YES -> 50, 100 NO -> 50
vault AUSD 0.353069 == sum(series collateral) 0.353069
TOTAL 56 txs: gas used 23,201,036, gas limit (billed) 26,091,823, 2.6614 MON at 102 gwei
per wallet: deployer 1.6011, maker 0.7880, taker1 0.0852, taker2 0.1871   (requirement file: 2.14 / 1.08 / 0.17 / 0.30)
E2E OK (live)
```
**What this proves:**
- With *today's* balances, the one command funds the other wallets from the deployer, deploys, trades, waits for the day to end, settles and redeems without manual steps.
- Every wallet stays inside its requirement, with about 30% headroom.

**What it does not prove:**
- Monad's reserve-balance and "emptying transaction" enforcement (anvil doesn't implement it).
- Real network latency (anvil's 1 s block time dominates the 1.06 s median).
- The MON figures are computed as gas limit × 102 gwei, which is how Monad bills. Anvil's own balance deltas are lower, because its fork base fee decays on empty blocks.

## 4. Gas and the daily testnet-MON budget
Billed on the **gas limit** at 102 gwei. All figures were measured on the fork. Monad gas rules are active there (the Kuru spike showed cold-access costs match the live chain exactly).

**One-time costs:**
- Core contracts: Resolver 0.284 + Vault 0.489 + 2 stations 0.014 + Zap 0.155 = **0.94 MON**.
- Running one live e2e: **3.69 MON** across the 4 wallets (fork-measured × 1.3 + 0.05; `logs/live-requirements.json`).

**Per city-day, 1 city × 6 strikes, hourly re-quotes, from measured per-operation limits:**

| Item | Count | Gas limit | MON |
|---|---|---|---|
| createLadder, 6 strikes (12 clones), measured | 1 | 1,695,391 | 0.173 |
| Kuru `deployProxy` (one book per strike) | 6 | 1,463,712 | 0.896 |
| Maker mintSet / approve YES→margin / deposit YES | 6 each | 294,697 / 69,349 / 166,575 | 0.325 |
| Maker AUSD top-up deposit | 1 | 126,927 | 0.013 |
| Initial quote, 1 bid + 1 ask | 6 | 589,509 | 0.361 |
| **Hourly re-quote (cancel 2 + place 2), 24 × 6** | **144** | **522,756** | **7.678** |
| Pull quotes at close | 6 | 277,331 | 0.170 |
| CRE settle report (we pay in sim mode; fixed limit) | 1 | 220,000 | 0.022 |
| Maker withdraw + redeem | 1 + 6 | 298,373 / 187,113 | 0.145 |
| **Total** | | | **9.78 MON/day** (fixed 2.10 + re-quotes 7.68) |

- **Variants:** re-quoting only the strikes that moved ≥1 tick (about half) costs **5.9 MON/day**; every 30 min (the METAR cadence) costs **17.5 MON/day**.
- **Per user trade** (paid by the user or a relayer): book buy 0.040, `Zap.buyNo` 0.083, `Zap.buyYes` 0.063, redeem 0.016 MON.
- **Against the faucet:** at 50 MON/24h, one city with hourly re-quotes uses about 20% of a daily claim. Re-quotes are 78% of the daily cost, so re-quote cadence is the lever. Lowering the maker gas multiplier from 1.10 to 1.05 saves another ~4.5%.
- **Latency:** about 300 ms per tx locally on the fork. On live, the Kuru spike measured a median of 1.9 s from send to receipt over the public RPC. I did not measure it here (no live transactions).

## 5. Findings that would have broken production
1. **A fixed-size re-quote after a fill reverts.** Kuru returns `InsufficientBalance()` (`0xf4d678b8`). My first fork run died this way after taker2's Zap took 167 YES from the maker's 200 ask: `logs/fork-2026-10-06T13-52-20-FAILED-naive-requote/`. The maker bot must size each quote from free margin + what the cancelled orders free. `sizesFor()` in `ts/e2e.ts` does this, which is why re-quote #38 posts a 132-YES ask.
2. **The mock forwarder swallows `onReport` failures.** The transaction succeeds and only `ReportProcessed.result` tells you the outcome. That is how the replay showed up (`result=false`). The workflow and dashboards must read the event or `resultOf`.
   - `eth_estimateGas` gave 154,069 against 152,505 used, so estimation is *safe here*: after a failed inner call, the mock still needs more than 1/64 of the gas for its own SSTORE and event.
   - I still use a fixed limit of 220k. About 170k is the floor.
3. **Pick strikes from the forecast.** Open-Meteo says Taipei 2026-10-07 is about 26 °C, so the plan's 28/29/30 strikes are all tails (fair values 0.16/0.05/0.01). The bid on ≥30 sat at the 0.001 floor, so "buy NO ≥30" cost 0.999. The daily roll job should centre the ladder on the forecast (for example μ−2 … μ+3). Strikes are per-ladder parameters, so no contract change is needed.
4. **Kuru takes its 0.1% taker fee in the output token.** The fee collector ends up holding winning YES that nobody redeems (0.34 AUSD in this run). This is harmless: solvency holds with equality.
5. **The AUSD faucet has a global 60 s cooldown.** The live run claims twice (maker, taker1) and waits it out; taker2 is funded by transfer.
6. **Monad reserve balance.** The deployer is under 10 MON, so each MON top-up must be an "emptying" transaction (no other transaction from the deployer in the previous 3 blocks). The live `fund` phase waits 4 blocks before each transfer. Anvil does not enforce this rule, so it is only proven by the Kuru spike's live transfers.

## 6. Live testnet status and the one command
- **Not run on live.** The rule is the deployer must have ≥5 MON; it has 3.6526. No transaction was sent to the live testnet or to mainnet from this workstream.
- **The command, from the repo root:** `script/testnet-e2e.sh`. It is equivalent to `make -C spikes/e2e testnet-e2e`.
  1. Runs the read-only preflight. It refuses any chain other than 10143 and stops with instructions if MON is short.
  2. Tops up maker/taker1/taker2 from the deployer, if needed.
  3. Runs the whole loop live.
- **Test station.** The live run uses a throwaway station `ZZZZ` (ICAO "no code") whose local day ends 12–27 min after launch. Settlement and redemption therefore finish in one sitting of about 20–30 min. It also registers `ZZZY` for the void ladder.
- **Real Taipei day:** `STATION=RCSS script/testnet-e2e.sh` waits for 00:00 Taipei (16:00 UTC). It is resumable with `RESUME=<logs/live-…/state.json>`.
- **MON needed:** 3.69 in total (deployer 2.14, maker 1.08, taker1 0.17, taker2 0.30). With today's balances, the deployer alone needs 3.21, including top-ups.
- **Evidence it writes:** `spikes/e2e/logs/live-<timestamp>/` with every tx hash.

## 7. Human actions
1. **Run live:** either claim MON at https://faucet.monad.xyz for `0xb855f2bCA7C12Db2aA9D70740c6cF40808325c11` to get ≥5 MON, or accept running at today's 3.65. Then run `script/testnet-e2e.sh` while **no other agent is sending from the deployer** (nonce races; the key is shared by several spikes).
2. **Before production, use a dedicated attester key.** The e2e uses attester = deployer, as the task specified.
3. **Kuru:** get a written answer on whether v1 testnet markets count for "New Assets" (unchanged from the Kuru spike).
4. **Budget:** about 10 MON/day per city with hourly re-quotes (about 6 if only moved strikes are re-quoted), plus 0.15 MON per new strike book. Plan faucet claims and a devrel top-up accordingly.

## 8. Next steps
- **Maker bot:**
  - Take `sizesFor` (inventory-aware) and the quote, re-quote and pull-at-close logic from `ts/e2e.ts`.
  - Re-quote only on a fair-value move of ≥1 tick.
  - Track order ids from `OrderCreated`.
  - Use gas multiplier 1.05 for maker transactions.
- **Daily roll job:** centre strikes on the forecast; `createLadder` (0.17 MON for 6 strikes); `deployProxy` per strike; set `closeTime` = dayEnd − 1 h and pull quotes at close.
- **CRE:** take the report shape from `creRawReport()` / `_creReport()`. Treat `ReportProcessed.result=false` as a failure. Use a gas limit of about 200k.
- **Zap:** to add "sell NO", size an exact-output YES buy from `getL2Book`, then merge. Consider an ERC-2612 permit entry point for gasless first use (AUSD supports permit).
- **PWA / mm plugin:** call the Zap. Approve AUSD (and YES/NO) to the Zap once. Pass `seriesId` and the strike's market.

## 9. Files
- **`spikes/e2e/src/IsothermZap.sol`:** the Zap contract (compiled by the root Foundry project through the integration test).
- **`spikes/e2e/ts/e2e.ts`:** the scenario runner (`MODE=fork|live`, `REHEARSAL=1`, `RESUME=`), with the step/gas table and budget.
- **`spikes/e2e/ts/lib.ts`:**
  - ABIs, the gas-recording sender and the CRE raw-report builder;
  - EIP-712 types, station-local dates and the forecast fair value.
- **`spikes/e2e/ts/preflight.ts`:** read-only live readiness and funding plan.
- **`spikes/e2e/run-fork.sh`, `spikes/e2e/run-rehearsal.sh`, `spikes/e2e/Makefile`, `script/testnet-e2e.sh`.**
- **`test/integration/IsothermE2EFork.t.sol`:** `test_e2e_fullLoop`, `test_e2e_zapThinBook`.
- **Logs:**
  - `logs/fork-2026-10-06T13-54-06/` (passing run);
  - `logs/fork-…-FAILED-naive-requote/` (finding 1);
  - `logs/live-requirements.json`;
  - `logs/fork_block.txt` (68700516);
  - `logs/rehearsal-stdout.txt` and `logs/rehearsal-2026-10-06T13-56-37/`.
- **Known gaps:**
  - The TS files run under `tsx` and are not strict-type-checked (`tsc` reports viem generic-typing nits only).
  - Anvil does not enforce Monad's reserve-balance rule.
  - Live latency was not measured here.
