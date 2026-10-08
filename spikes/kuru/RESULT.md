# Kuru spike: YES/AUSD order books on Monad testnet

**Verdict: GO.** Trigger T1 passed on live Monad testnet (chain 10143) on 2026-10-06, with real transactions:

- The deployer, which is not the Kuru owner, deployed a 6-decimal YES token.
- The deployer then created a YES/AUSD market through the Kuru v1 Router.
- The maker funded its margin account and posted one order, then a 3-bid/3-ask ladder.
- taker1 market-bought with 20 AUSD and received 45.409090 YES in its wallet.
- The maker cancelled every resting order, leaving the book empty.

All 16 transactions succeeded and cost 0.541 MON in total.

The same lifecycle also passes in three other places:
- A full 24-transaction run on an anvil fork.
- A single `eth_call` against live state that needs no MON.
- Four Foundry fork tests, including the Zap paths.

Every number below comes from a command I ran. Logs are in `logs/`.

## 1. Live testnet run (trigger T1)

Command: `cd ts && RPC_URL=https://testnet-rpc.monad.xyz npx tsx live-critical.ts`. Output is in `logs/live-critical-stdout.txt`; state and hashes are in `logs/live-state.json`.

- YES token `0x03222e19fda0fb305df95092edbb65f26e0806ab`
- **Market `0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A`**, which `router.verifiedMarket` reports with pricePrecision 10000.

| step | wallet | gas limit (billed) | MON @102 gwei | tx |
|---|---|---|---|---|
| MON 0.6 → maker / 0.2 → taker1 | deployer | 21,000 ×2 | 0.0021 ×2 | `0x52deace9…71acd`, `0x151b221a…96b6` |
| AUSD faucet (self) | maker, taker1 | 150,190 ×2 | 0.0153 ×2 | `0xab0bb5c6…a5677`, `0x5c068ad2…e519e` |
| (a) deploy YES (plain 6-dp ERC-20) | deployer | 650,403 | 0.0663 | `0xbc4b5432…73af7` |
| (a) mint 500 YES → maker | deployer | 93,069 | 0.0095 | `0x4d3c39f3…deca7` |
| **(b) Router.deployProxy (YES/AUSD)** | deployer | 1,473,065 | **0.1503** | `0x5c184afcf9fe6b1e96518cb286ac28822f59b9a177802c6ee42d108c03335fc7` |
| (c) approve + deposit 200 AUSD to MarginAccount | maker | 82,152 + 153,471 | 0.0241 | `0x7fcc67fd…`, `0x80d8582d…` |
| (c) approve + deposit 400 YES to MarginAccount | maker | 60,761 + 162,656 | 0.0228 | `0x94f7ed75…`, `0x626d93e4…` |
| (c) single `addSellOrder` 50 @ 0.45 | maker | 373,264 | 0.0381 | `0x93ce546b…07c92` |
| (c/e) `batchUpdate`: cancel 1, place 3 bids + 3 asks | maker | 987,702 | 0.1007 | `0xa6f28baf…4a73e` |
| (d) approve market + `placeAndExecuteMarketBuy` 20 AUSD | taker1 | 82,166 + 389,326 | 0.0481 | `0xe394e33b…`, **`0xb2b77c1377a549c4476ccd5e615780303392570ca54dcc9b24e10372413078da`** |
| (e) `batchCancelOrdersNoRevert` ×6 | maker | 453,680 | 0.0463 | `0x7883dec9a408c0bb02a2a9dbb2adf64f13c6a890fdfa244f577b051b0bef4c3b` |

Full hashes are in `logs/live-state.json`. Gas price was exactly 102 gwei on every receipt.

I checked the results independently with `cast`:
- taker1 holds **45,409,090** YES units, which is 20 / 0.44 = 45.4545 minus the 0.1% taker fee.
- The take transaction emitted a `Trade` event (topic `0xf16924fb…`) from the market.
- `s_orderIdCounter` = 7.
- After the cancel, `bestBidAsk` returns (max, 0), meaning the book is empty.
- The maker's margin account ends at 219.9999 AUSD and 354.545455 YES. That is 200 AUSD plus the 20 AUSD fill, less 0.0001 AUSD of round-down.
- L2 book after quoting: bids 0.42/0.41/0.40, asks 0.44/0.45/0.46. After the take, 4.545455 YES remain at 0.44. After the cancel it is empty.

Latency from send to receipt, as the client saw it over the public RPC: median 1.9 s, range 0.9–5.7 s. This includes viem's nonce and fee round-trips plus 250 ms receipt polling. The chain produced 414 blocks in 128 s, about 0.31 s per block.

Remaining MON: deployer 3.67, maker 0.35, taker1 0.137.

## 2. Same lifecycle with no MON: one eth_call against live state

`script/liveprobe.sh` injects `LiveProbe` with a state override. In one call it:
- deploys YES;
- calls `deployProxy` from a contract that is not the owner;
- takes AUSD from the real faucet;
- runs a maker and a taker as two separate Actor contracts through deposit, single bid and ask, `batchUpdate` (cancel 2, place 6), market buy, market sell, `getL2Book`, and cancel all.

It succeeded at live blocks 68691734 and 68697136 (`logs/liveprobe_eth_call.txt`, `logs/liveprobe-rerun.txt`). The taker received 179.284642 YES for 100 AUSD and 10.8891 AUSD for 20 YES. The decoded L2 book matched expectations. Anyone can re-run this at any time to check the v1 testnet still works.

## 3. Anvil fork: full 24-transaction lifecycle, gas, and Zap

Command: `anvil --fork-url https://testnet-rpc.monad.xyz --fork-block-number 68689869 --network monad --port 8546`, then `RPC_URL=http://127.0.0.1:8546 npx tsx ts/lifecycle.ts`. Output is in `logs/lifecycle-anvil-*`.

This run uses the four real wallet addresses. It adds what the live run left out: taker2 market-selling 30 YES (+12.8871 AUSD), a buy through `Router.anyToAnySwap` (20 AUSD → 43.434781 YES), a scan of open orders followed by a replace, cancel all, and `batchWithdrawMaxTokens`.

The forge fork tests (`forge test --fork-url http://127.0.0.1:8546`) give **4/4 PASS**:
- `test_nonOwnerCanCreateMarket`
- `test_liveProbeOnFork`
- `test_postOnlyAndInsufficientMargin`: the margin account must hold funds, post-only orders that would cross revert, and orders off the 0.001 tick revert.
- `test_zapPaths`:
  - `zap.buyYes`: 50 AUSD → 121.829267 YES.
  - `zap.sellYes`: 60.914633 YES → 24.341434 AUSD.
  - `zap.buyNo`: 40 AUSD → 40 NO plus 15.984 AUSD back, a net NO price of 0.6004.
  - `router.anyToAnySwap`: 30 AUSD → 73.09756 YES.
  - In every Zap path the Zap contract ends holding 0 tokens.

**The anvil gas numbers can be trusted for Monad.** I ran a gasleft probe through an `eth_call` override. Cold account access, cold SLOAD and same-page SLOAD cost **10115 / 8115 / 121** gas identically on live testnet, live mainnet and the anvil fork. Ethereum pricing would give 2615 / 2115 / 2115, so Monad's cold-access pricing and storage pages are active on all three.

The `deployProxy` gas estimate was 1,229,041 on live and 1,226,014 on anvil. The in-call gasleft deltas from the live `eth_call` probe matched forge exactly.

## 4. Gas and MON costs

Monad bills the gas **limit**, and a receipt's `gasUsed` equals the limit. Costs below are at 102 gwei. Execution gas comes from anvil; limits are 1.15× the estimate for maker transactions and 1.3× for taker transactions.

| action | gas used | MON billed |
|---|---|---|
| create market (`deployProxy`) | 1,258,600 | 0.150 |
| deploy plain ERC-20 YES | 585,497 | 0.066 (use EIP-1167 clones in StrikeFactory) |
| margin deposit (per token) | 131–139k | 0.016 |
| first single order at a new price level | 317–343k | 0.038–0.041 |
| per-strike re-quote, 1 bid/1 ask (cancel 2 + place 2), same prices | 403,710 | 0.048 |
| per-strike re-quote, 1 bid/1 ask, shifted | 459–487k | 0.055–0.058 |
| re-quote 3 bids/3 asks (cancel 6 + place 6) | 790–862k | 0.094–0.103 |
| taker market buy (1–2 levels) | 258–358k | 0.035–0.048 |
| taker market sell | 301,549 | 0.041 |
| `Router.anyToAnySwap` buy | 374,242 | 0.050 |
| cancel 2 orders / cancel 6 orders | 249k / 450k | 0.029 / 0.046 |
| Zap `buyYes` / `sellYes` / `buyNo` (forge, includes warm slots) | 426k / 434k / 565k | about 0.05–0.07 |

Source: `logs/bench-*.json`.

**Budget for one 6-strike Taipei ladder per day:**
- Creating the markets costs about 0.9 MON.
- Tokens cost about 0.1 MON with clones.
- One full ladder refresh (6 strikes × 1 bid/1 ask) costs about **0.29–0.35 MON**.
- Event-driven quoting on every METAR, 48 times a day, comes to roughly 15 MON/day. The 50 MON/day faucet covers this, but not continuous re-quoting.
- Tightening the maker gas multiplier to 1.05 saves about 9%. The estimate was within 1.5% of gas used.

## 5. What `deployProxy` needs, and why I chose these parameters

The full signature is `deployProxy(uint8 type, address base, address quote, uint96 sizePrecision, uint32 pricePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)`, selector `0xce186ec3`.

The contract checks:
- sizePrecision and pricePrecision are powers of 10;
- tick > 0;
- makerFee ≤ takerFee < 10000;
- spread is a multiple of 10, greater than 0 and less than 500;
- minSize > 0 and maxSize > minSize;
- the CREATE2 salt is unique, so the same token and parameters cannot be deployed twice.

Chosen values:

| parameter | value | why |
|---|---|---|
| `type` | `0` | Both legs are ERC-20 (NO_NATIVE). |
| `pricePrecision` | `1e4` | Price is stored in 0.0001 AUSD units, so 0.55 is 5500. This matches the SDK's `calculatePrecisions(0.5, max 1)`. |
| `tickSize` | `10` | A 0.001 tick, the same granularity Polymarket uses at the tails, so valid prices run 0.001–0.999. |
| `sizePrecision` | `1e6` | One size unit equals one YES base unit, so the Zap needs no rescaling. |
| `minSize` / `maxSize` | `1e6` / `1e12` | 1 YES to 1,000,000 YES per order. The minimum guards against order spam and rounding dust. |
| `takerFeeBps` / `makerFeeBps` | `10` / `0` | The 0.1% fee goes to Kuru's fee collector, not to Isotherm. Set both to 0 for a cleaner demo. |
| `kuruAmmSpread` | `100` | The backstop vault is left empty, but the contract requires a value. |

**Isotherm must enforce the price cap itself:** Kuru has no maximum price, so the bot, Zap and UI must keep prices at or below 0.999.

## 6. Other questions the task asked

**Is the v1 testnet still working?** Yes:
- The live transactions in section 1 and the eth_call probe in section 2 both succeeded.
- The Router proxy implementation `0xaaa0f0c4…e1ed` contains `deployProxy`.
- The OrderBook implementation `0x72caE0a9…9374` exposes all 19 selectors I use, matching the public source at commit `2060bb2`.
- The Router's nonce is 431 now and was 371 about 2 million blocks ago. That is about 30 new markets from other users in the last week.
- The official MON-USDC testnet market has no resting orders (`s_orderIdCounter` = 1).

**Is mainnet market creation owner-gated?** Yes. I checked with read-only `eth_call` on Router `0xd651346d…95CC`; no transaction was sent:
- From a non-owner it reverts with `Unauthorized()`, selector `0x82b42900`.
- The same call from owner `0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b` succeeds.

**Does Kuru Spot V2 testnet allow anyone to create a market?** No:
- The docs state that "Market creation and administration are permissioned".
- Calling SpotRouter `0xf75A7529…947E` deploy-shaped selector `0x62a813ec` from the deployer reverts with `Unauthorized()`.
- `whitelistedSpotTokens(AUSD)` = false, while USDC = true.
- The docs also say Spot V2 is not on mainnet.

**Can a contract trade on the book for a user (a Zap)?** Yes. With `_isMargin=false`, the OrderBook pulls the quote token from `msg.sender` via `transferFrom` straight into the MarginAccount. It credits the output, and any refund on a partial fill, by ERC-20 transfer to `msg.sender`, which is the Zap. The Zap then forwards balance deltas to the user.

Approvals:
- The user approves the Zap for AUSD or YES.
- The Zap approves the **market** (not the MarginAccount) for exact amounts.
- For `buyNo`, the Zap also approves the complete-set minter for AUSD.
- With no Zap at all, a user can approve the **Router** and call `anyToAnySwap`. That path is always fill-or-kill and pays the caller.

Only YES has a book, so:
- **buy NO** = mint a complete set, then market-sell the YES leg. Tested: 40 AUSD → 40 NO + 15.984 AUSD back.
- **sell NO** = market-buy YES, then merge. This is not implemented, because Kuru v1 market buys specify the quote amount, not an exact output size. The Zap would size the purchase from the L2 book, buy slightly more, and refund the leftover YES.

## 7. Problems and caveats

- **Monad reserve balance.** An account holding under 10 MON can only send value in an "emptying" transaction, meaning no other transaction from that account in the previous 3 blocks. The MON transfers are spaced out by design. The deployer key is **shared with the other spikes**: its nonce moved from 0 to 3 and its balance from 5.00 to 4.70 while I worked. `live-critical.ts` is resumable for that reason.
- **AUSD faucet.** Each call gives 10,000 AUSD to any address, with a **global** 60-second cooldown (`MaxFrequencyExceeded` `0x20e5bc67`) and a cap of 100k AUSD held. Anvil's clock trails the chain, so scripts call `evm_increaseTime` there.
- **Maker inventory sits in Kuru's MarginAccount.** Bids lock AUSD, asks lock YES, and fills are credited there. Withdraw with `batchWithdrawMaxTokens`.
- **Isotherm cannot pause a Kuru market.** Each OrderBook is owned by the Router, and the Router is owned by Kuru (`0x07bBBf2e…C1D1`). The maker bot must **cancel all quotes before the settlement window closes**, or stale bids will be picked off by traders who already know the result. The UI should then hide resolved books.
- **Rounding.** The maker's quote credit rounds down to 0.0001 AUSD per fill.
- **Order status.** A fully filled order can keep its struct. "Is this order open?" means: owner matches, price ≠ 0, and the price-point head ≤ the order id. This is implemented in `getOpenOrders`. Cancelling an id that has been deleted reverts, even with the NoRevert variant, so the bot should track ids from `OrderCreated` events.
- **Public RPC limits.** `eth_getLogs` is limited to 100 blocks, so the bot cannot rely on scanning history. There was one transient TLS failure, handled by viem retries.
- **Testing traps.**
  - Under `via_ir`, `block.timestamp` is cached in tests; use `vm.getBlockTimestamp()`.
  - Only target `evm_version=prague`, which is what Kuru deploys with.
- **A fork cleanup also stopped the CRE spike's anvil.** `pkill -f 'anvil --fork-url https://testnet-rpc.monad.xyz'` also stopped the CRE spike's anvil on :18845 at about 06:29 (its `sim-patched-broadcast.log` shows connection refused). It was restarted, and contracts on that fork had to be redeployed.

## 8. Things the team needs to do

1. **Ask Kuru in writing, in their Discord:** does a YES/AUSD market created through the v1 testnet Router (for example `0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A`) count for New Assets? Spot V2 cannot host it: market creation is permissioned there and AUSD is not whitelisted.
2. **Keep claiming testnet MON daily** at faucet.monad.xyz, and ask devrel for a top-up. A 6-strike ladder needs about 1 MON/day to create markets, plus about 0.3 MON per full refresh. The maker wallet has 0.35 MON.
3. **Optional:** ask Kuru whether a fee-free (0/0) market is preferred, and whether they would whitelist AUSD on V2.

## 9. Next steps

- StrikeFactory should create YES tokens as EIP-1167 clones and call `deployProxy` within the same transaction, which needs one approval.
- The maker bot should:
  - reuse `ts/kuru.ts`'s `placeQuotes`, which re-quotes with one `batchUpdate` per strike;
  - track order ids from receipts;
  - use gas multiplier 1.05 for maker transactions;
  - include a pre-settlement kill switch that cancels everything.
- Turn `src/KuruZap.sol` into the production Zap, adding sell-NO via buy-then-merge with a refund, and enforce price ≤ 0.999.

## Files

- `ts/kuru.ts` is the viem library:
  - `createMarket`
  - `depositMargin`
  - `placeLimit`
  - `placeQuotes` (batchUpdate)
  - `getOpenOrders`
  - `cancelAll`
  - `marketBuy`
  - `marketSell`
  - `routerBuy`
  - `getBook` / `decodeL2`
  - `withdrawAllMargin`
  - plus `TESTNET`, `PARAMS` and the ABIs
- `ts/cli.ts` is a command-line wrapper: `book`, `open`, `create`, `quote`, `cancel-all`, `buy`, `sell`.
- `ts/lifecycle.ts` runs the full flow on anvil, `ts/live-critical.ts` runs the resumable live T1 path, and `ts/bench.ts` runs the gas benchmark.
- Solidity in `src/`:
  - `interfaces/IKuru.sol`
  - `SpikeToken.sol` (YES token plus `SpikeCompleteSet`)
  - `KuruZap.sol`
  - `LiveProbe.sol`
- `test/KuruFork.t.sol` holds the fork tests and `script/liveprobe.sh` the no-MON live check.
- `abi/*.json` holds the ABIs, and `abi/testnet.json` the addresses and parameters.
- `logs/` holds every run's output.
