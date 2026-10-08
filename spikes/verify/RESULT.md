# Isotherm: independent verification (2026-10-06)

Verifier: separate agent. I re-ran the builders' evidence from a clean shell, in scratch copies and on fresh anvil forks on my own ports (19347–19352). I did not change any builder source file. I sent nothing to Monad testnet or mainnet: the deployer holds **3.6526 MON (nonce 9)**, under the 5 MON rule. Every log mentioned below is in `spikes/verify/logs/`.

## Verdict

**Yes, it can be built.** I re-ran every critical claim and got the same result. The full loop ran as real transactions on fresh anvil forks of today's live testnet (with Monad gas rules): deploy, ladder, AUSD faucet, minting sets, one Kuru v1 book per strike, maker quotes, a taker fill, Zap trades, CRE settlement through the real MockKeystoneForwarder, redeem, a void ladder and a stale-void ladder. On the live chain I confirmed the builders' 16 Kuru transactions and 4 CRE transactions. Four points are still open:

1. Our own Isotherm outcome tokens have never traded on a live Kuru book. The live Kuru market uses a stand-in "SpikeToken".
2. Nothing in the official CRE, MetaMask or Dynamic accounts has been exercised. Each needs a human sign-in.
3. The CRE workflow does not implement the weather team's settlement rule (finding A).
4. Testnet MON is the binding constraint. One live end-to-end run needs 3.21 of the 3.65 MON we have; daily operation needs about 6–10 MON per city.

## Claims checked

| # | Claim (builder) | Reproduced | Evidence (my run) |
|---|---|---|---|
| 1 | `forge build` + 82 tests pass (contracts) / 84 with integration (e2e) | **yes** (84) | Compiling 78 files with Solc 0.8.37, success. `MONAD_TESTNET_RPC=… FORK_BLOCK=68693965 forge test` → `9 test suites: 84 tests passed, 0 failed, 0 skipped`. Fuzz tests ran 1,000 runs each; the invariant suite made 32,768 calls with 0 reverts (`forge-test-fork68693965.txt`). The fork and integration tests also pass at the latest block 68707311 (4/4). |
| 2 | The tests catch injected bugs (7/7) | **yes** (my own 7 mutants, in a scratch copy) | Each mutant made tests fail: no double-settle guard, attester signature ignored, `>=` changed to `>` in the payout, mint allowed after close, settle before day end, payout not debited, forwarder sender check removed. The restored tree passes 80/80 non-fork tests and matches the repo byte for byte. |
| 3 | `script/e2e.sh` works on an anvil fork (forged report rejected, attested accepted, replay rejected, vault left at 0) | **yes** | Fresh fork at 68707417; anvil reported `network=monad hardFork=MonadTen` without a flag. The script printed `cast typed-data signature == signature over contract settlementDigest`, then 7a REJECTED, 7b success `(1, 31, …)`, 7c REJECTED, `vault AUSD left=0`, and strike-32 payoutHalves `0 2` (`core-e2e-anvil.txt`, `core-e2e-anvil-gas.tsv`). |
| 4 | Anvil in Monad mode bills the gas **limit** | **yes** | A 21,000-gas transfer sent with limit 100,000 cost exactly 100,000 × effective gas price. |
| 5 | Kuru: 16/16 live transactions, 0.541 MON | **yes, with a caveat** | `cast receipt` on all 16 hashes: status 1, and gasUsed equals the gas limit on every one (`kuru-live-receipts-verified.txt`). taker1 holds `45409090` YES; the book is empty, `(2^256-1, 0)`; `s_orderIdCounter=7`. **Caveat:** the base token 0x0322…06ab is named "YES RCSS Tmax>=30C 2026-10-08 (**Isotherm spike**)" and has no `seriesInfo()`. It is a plain ERC-20, not our OutcomeToken clone. |
| 6 | Kuru liveprobe (eth_call, 0 MON) | **yes** | At live block 68707922: 179.284642 YES for 100 AUSD and 10.8891 AUSD for 20 YES. Identical to the builder's numbers. |
| 7 | Kuru 24-transaction lifecycle on a fork | **yes** (21 transactions) | Fork at 68707993: every step succeeded, 0.8344 MON billed. There were 21 transactions instead of 24 because the wallets already hold AUSD on the current fork, so three funding steps were skipped (`kuru-lifecycle-anvil-stdout.txt`). |
| 8 | Kuru Zap paths, forge fork 4/4 | **yes** | Identical numbers: buyYes 50 → 121.829267, sellYes → 24.341434, buyNo 40 → 40 NO, anyToAnySwap 30 → 73.09756 (`kuru-forge-fork.txt`). |
| 9 | Market creation is permissionless on testnet and owner-gated on mainnet | **yes** | The mainnet Router `deployProxy` call from the deployer reverts with `0x82b42900 Unauthorized()` (read-only eth_call). Mainnet owner 0x8B73…788b, testnet owner 0x07bB…C1D1. |
| 10 | The e2e spike's 59-transaction full loop on a fork | **yes** | Fresh fork at 68708328: `TOTAL 59 txs: gas used 25616407, gas limit (billed) 28748689, 2.9324 MON`, `E2E OK (fork)`, `vault AUSD 0.344069 == sum(series collateral) 0.344069`, and the Zap ended holding 0/0/0 (`e2e-spike-fork-stdout.txt`, `e2e-spike-fork-steps.tsv`). Our OutcomeToken clones traded on Kuru here (on the fork). |
| 11 | No-cheat rehearsal of the live code path: 56/56 transactions, about 19 minutes | **yes** | `MODE=live REHEARSAL=1` on anvil `--block-time 1`, fork 68712111, with real wallet balances → `E2E OK (live)`, 56 transactions, 15 min 46 s. Details in the **Rehearsal** section (`rehearsal-stdout.txt`, `rehearsal-steps.tsv`). |
| 12 | Live preflight says READY | **yes** | `deployer needs 3.2081 MON (own 2.14 + top-ups 1.0681), has 3.6526 -> READY` (`e2e-live-preflight.txt`) |
| 13 | Weather: our rule matches Polymarket on 183/184 RCSS days and 209/209 RJTT days | **yes** | My own stdlib script (`weather_spotcheck.py`) checked 22 randomly chosen station-sourced days from Polymarket's gamma API against IEM: **21/22 match**. The one miss is 2026-05-04: Polymarket resolved 24 °C, but IEM and Ogimet both show `040530Z … 25/18`. All 23 of my rows equal the builder's table. A rerun of `fidelity.ts` from a copy gives 183/184, 209/209, UTC-day 171/184 and hourly-only 155/184. |
| 14 | Forecast v0 is worse than Polymarket (Brier 0.0656 vs 0.0594, CI [+0.0030, +0.0092]) | **yes** | Rerun of `backtest.ts`: identical pooled numbers. `npm test` passes 8/8. |
| 15 | CRE CLI v1.37.0 is genuine; the workflow builds to WASM without login | **yes** | The zip's sha256 `b72d94ca…a0a7a0` equals the GitHub release asset digest, and the installed binary equals the binary inside the zip. `cre workflow build` → `✓ Workflow compiled successfully` (2,781,426 B). |
| 16 | The official `cre workflow simulate` needs a login | **yes** | `✗ authentication required: no credentials found` |
| 17 | CRE `bun test` 8/8; settlement through the forwarder with live IEM/AWC data | **yes** | 8 pass (1 of them is the e2e file, which does nothing without its env var). Anvil e2e at 68710560 using the **current** Resolver source: `IEM tmax=29 obs=50 \| AWC tmax=29 obs=50`, `ReportProcessed.result=[true]`, resultOf `(1,29)`, the second run printed `already-resolved`, report gasUsed 149,429 (`cre-e2e-anvil.txt`). Forge forwarder tests 7/7. |
| 18 | CRE live txs (Resolver 0xb7b9…, reports 0x482d… and 0x999c…) | **yes** | Deploy at block 68693800, register, and two reports: each has status 1, `ReportProcessed=1` and `LadderResolved`. resultOf(RCSS,20261005)=(1,29) and (RCSS,20261004)=(1,35). The 0x999c… input carries the simulator header (ts 100, workflowId 0x11…, name `7721568293`, owner 0xaa…), but it came from the **patched** login-free CLI, which is a one-line change to `LoginExemptCommands`. The live Resolver's bytecode equals the builder's 07:18 source once immutables are masked (see finding E). |
| 19 | mm plugin: the read command works with no sign-in | **yes** | I installed into a **fresh** HOME from a tarball I packed myself. `weather quote taipei --json` returned `ok:true`, chainId 10143, block 68711009, `rpcSource direct-rpc`, `gatewayError "A project id is required…"`. |
| 20 | mm submit path through `ctx.walletExecutor` (stub backend plus anvil) | **yes (harness only)** | With my own stub on :19788 and anvil :19350: 3 of 3 `weather memo` runs returned `CONFIRMED` (submitMs 245–253). The transaction is type 2, chainId 10143, gas 30,000, used 22,400, input `isotherm:v0:RCSS:2026-10-07:tmax=26`. This never touched MetaMask's real servers. |
| 21 | MetaMask's gateway rejects 10143; Mimir lists it | **yes** | `infura-service/v1/10143` → HTTP 400 `{"error":"Invalid chainId"}`, while `/143` → 200 `0x8f`. Mimir lists `{10143, guardSupported:true, shieldSupported:false}`. |
| 22 | mm `setup-mm-monad.sh` works from a fresh home | **partially** | The plugin install works. On a truly fresh home the chain step crashes (`FileNotFoundError …/.metamask/wallets.json`) because `mm init` has not run yet; it is listed as a prerequisite. A bare tarball **path** is misread as a GitHub ref, so it needs a `file:` prefix. |
| 23 | Dynamic PWA builds | **yes** | `vite v5.4.21 … ✓ 13312 modules transformed … ✓ built in 14.00s`, dist 7.1 MB |
| 24 | Dynamic relayer e2e 22/22; live eth_simulateV1 passes | **yes** | Fork at 68711460: `22 passed, 0 failed`, and the user spent 0 MON. `live-simulate.ts` → `LIVE SIMULATION PASS` (`userAusdAfter 9975000000`). |
| 25 | Dynamic's 7702 gas sponsorship is absent on Monad | **yes** | Code length at delegate 0x0000Fb77…b16b: 0 bytes on 10143, 0 on 143, 7,314 on Sepolia. |
| 26 | Mainnet ForecastCommit deploy simulated only | **yes** | `forge script … --rpc-url https://rpc.monad.xyz --sender 0xb855…` with no key and no `--broadcast` → `SIMULATION COMPLETE`, 1,982,093 gas. Mainnet deployer nonce 0, balance 0. |
| 27 | AUSD EIP-712 domain is "Agora Dollar" v1 with 6 decimals | **yes** | `eip712Domain()` → `0x0f "Agora Dollar" "1" 10143`. `name()` returns "AUSD", which must not be used for signing. |
| 28 | Monad facts: eth_getLogs ≤100-block range, about 0.3 s blocks, 102 gwei | **yes** | A 1,000-block query → `413 … eth_getLogs is limited to a 100 range`. Average block time over 1,000 blocks: 0.305 s. `cast gas-price` = 102000000000. |
| 28a | The AUSD faucet has one 60 s cooldown shared by all callers | **yes** | In my runs: `faucet busy (MaxFrequencyExceeded), retry 1` (core e2e), the Dynamic e2e's `second drip within 60 s -> clean 429`, and the rehearsal's `global 60 s cooldown … waiting 15 s`. |
| 28b | Foundry's Monad gas model is within about 1% of the live node | **yes** | Live `eth_estimateGas` for the Resolver deploy: 2,555,383, against 2,534,104 used on the fork (0.84% apart). |
| 29 | No private keys leaked | **yes** | `find … \| xargs grep -F` for the 4 wallet keys, the attester key and the mnemonic: the wallet keys appear nowhere in the repo. The attester key appears only in `spikes/cre/.secrets/`. The mnemonic appears only in `spikes/mm/.secrets/` and in two harness homes (`.mmhome-harness`, `.mmhome-setuptest`) as `mnemonic.json`. All of these are gitignored (checked with `git check-ignore`). Note: macOS `grep -r --exclude-dir` returned **false negatives** in this tree, so use `find \| xargs grep` for leak checks. |
| — | Not attempted | — | Live send→receipt latency (needs ≥5 MON); the Kuru gas-schedule probe (cold SLOAD 8115); the Zap 4-of-5 mutation claim. |

## Overstated or needing correction

- **Kuru "live YES/AUSD market"**: the live base token is a stand-in SpikeToken, not our OutcomeToken. Our clones trading on Kuru is proven on forks only (rows 10–11).
- **"Not run on the live chain"** (contracts) versus the CRE spike: the **Resolver alone** is live at 0xb7b9…. The Vault and OutcomeTokens have never been deployed live.
- **CRE "official simulator broadcast"**: this came from a patched CLI build. The unpatched binary refuses without a login. (Since 2026-10-07 the official, unpatched CLI runs after `cre login`; see `packages/cre-workflow`.)
- **mm "setup works from a fresh home"**: it does so only after `mm init` or a seeded session has run (row 22).
- **Test count**: there are now 84 tests in the snapshot I tested, and 115 in the current tree (finding E). `test/security/` was being added in parallel, and `src/Resolver.sol` changed at 07:25:59, during this verification.

## New findings

**A. (medium) The CRE workflow does not implement the weather spec it is meant to run.** The differences are in `spikes/cre/project/settle/metar.ts` (`decide`) and `config.testnet.json`:
- There is no Ogimet fallback. IEM had a 158-day outage for RCSS in 2025-26, and during such an outage every ladder would stale-void.
- "Complete" means only `obs ≥ 40`. The spec requires reports in at least 20 hours and a last report at or after 23:00 local.
- When IEM and AWC disagree, the workflow **immediately** sends a permanent VOID. The spec says to stay PENDING until the 36 h deadline.
- The cron runs at `0 30 16 * * *`, which is 00:30 Taipei. The spec says 02:00 local, because IEM lags 1–2 h.

Settlement is write-once, so a lagging or patchy source can void a ladder permanently.

**B. (medium) The stale-void window does not match the spec.** `Resolver.STALE_WINDOW = 24 hours`: anyone may void from dayEnd + 24 h. `settlement.ts` voids only at dayEnd + 36 h. Between 24 h and 36 h, anyone can void a ladder that the workflow is still waiting to settle. Pick one deadline.

**C. (medium) The maker's fair value disagrees with the market.** Both the e2e maker and the mm plugin price from N(Open-Meteo point forecast, σ):

| Source | Taipei Oct 7, P(Tmax ≥ 28) |
|---|---|
| e2e maker | 0.159 |
| mm plugin | 0.174 |
| Polymarket (live) | **0.495** |
| Weather engine | 0.561 |

The e2e maker quoted 0.138/0.179 on a strike that Polymarket prices near 0.5, so any informed taker would pick those quotes off. The weather builder's recommendation, to quote around the Polymarket-implied ladder, is not wired into the e2e maker or the plugin.

**D. (low) `script/e2e.sh` deploys with forge's default 130% gas multiplier.** The Resolver deploy had a limit of 3,294,335 against 2,534,104 used, and Monad bills the limit. Pass `--gas-estimate-multiplier 105`–`110`, as the deploy interface notes already say.

**E. (low) Source drift.** `src/Resolver.sol` changed during verification: the runtime grew from 11,035 to 11,170 B with the same ABI. The current tree passes 115/115 tests (14 suites, fork block 68693965, `forge-test-snapshot2.txt`), and the CRE e2e and forwarder tests pass against it. The live spike Resolver 0xb7b9… is the **older** bytecode. Freeze the source, then redeploy before the demo or the live run.

**F. (low)** The testnet mnemonic sits unencrypted in two gitignored harness homes. Delete them before sharing the folder.

## Gas and latency (my runs, billed on the gas limit at 102 gwei)

| Item | Gas | MON |
|---|---|---|
| One-time core deploy (Resolver + Vault + 3 stations + Zap, e2e spike) | used 8,461,853, limit 9,308,042 | ≈0.95 |
| createLadder, 6 strikes | 1.54–1.55M used, limit 1,695,391 | ≈0.17 |
| Kuru deployProxy per strike | used 1,310,536, limit 1,463,712 | 0.149 |
| mintSet, first / repeat | 282,367 / 180,367 | — |
| mintSetWithPermit | 284,019 | — |
| redeem | 146–182k | — |
| CRE report, accepted / rejected | 148,697 / 89,011 | — |
| CRE report from the bun harness | 149,429 | — |
| Taker market buy | 306,037 used, limit 392,945 | 0.040 |
| Zap.buyNo | 653,179 | 0.083 |
| Maker re-quote (cancel 2 + place 2) | about 487k | 0.055 |

- **Per 6-strike city-day, hourly re-quotes:** 9.78 MON, of which 2.10 is fixed and 7.68 is re-quoting.
- **Live latency:** not measured (no live sends). The fork shows about 300 ms, which reflects local anvil, not the network.
- **External fetches:** IEM 5,279 B in 1.7 s; AWC 4,458 B in 1.1 s; full Polymarket spot-check of 23 dates took 125 s.

## Rehearsal

This ran the live code path (`MODE=live REHEARSAL=1`) against an anvil fork of the current testnet, mining a block every 1 s, with the wallets' real balances.

- **Setup:** the deployer topped up the other wallets (0.7273 MON to maker, 0.0335 to taker1, 0.3 to taker2). The test stations ZZZZ/ZZZY are UTC+9 days whose local day ended about 15 minutes after launch, and the script actually waited for that.
- **Settlement:** the CRE report went through the MockKeystoneForwarder: `ReportProcessed.result=true`, resultOf `(1, 29)`. The replay was rejected.
- **Payouts:** void pays 0.5/0.5, and `vault AUSD 0.353069 == sum(series collateral)`.
- **Result:** `TOTAL 56 txs: gas used 23201060, gas limit (billed) 26091823, 2.6614 MON`, then `E2E OK (live)`.
- **Spend per wallet:** deployer 1.6011, maker 0.7880, taker1 0.0852, taker2 0.1871 MON.
- **Latency on anvil with 1 s blocks:** median 1,047 ms, range 288–2,079 ms. This reflects anvil's block time, not Monad's.
- **Not tested:** anvil does not enforce Monad's reserve-balance rule for accounts under 10 MON, so the MON top-ups are proven only by the Kuru spike's live transfers.

## Human actions needed

1. **Testnet MON.** Claim at https://faucet.monad.xyz (it has a browser checkpoint) until the deployer holds ≥5 MON, and ask Monad devrel for more. Then run `script/testnet-e2e.sh` from the repo root while **no other agent is using these keys**. It takes about 20–30 min and about 3.7 MON. Daily operation needs about 6–10 MON per city.
2. **CRE.** Create an account at app.chain.link/cre, run `cre login` and `cre account access`, then rerun the **unpatched** `cre workflow simulate … --broadcast` for bounty evidence.
3. **MetaMask.** Run `mm login` and `mm init` (keep one sign-in method), fund the agent address, then run `mm weather memo taipei --wait --json` live. This is the only hop that has never been exercised.
4. **Dynamic.** Create a Sandbox environment and get its Environment ID and API token (keep them in `~/.config/isotherm/dynamic.env`, chmod 600). Set CORS origins and enable Monad 10143. Real login and embedded-wallet signing on 10143 are still unverified.
5. **Kuru.** Ask in Kuru's Discord, in writing, whether a v1 testnet market counts toward "New Assets".
6. **npm.** Log in and publish `mm-plugin-isotherm`. Optionally, the team broadcasts the mainnet ForecastCommit (about 0.40 MON at a 202 gwei max fee).

## Next steps (engineering)

1. Make the CRE `decide()` match `settle-core.ts`:
   - add the Ogimet fallback;
   - use the hour-and-last-report completeness rule;
   - return PENDING (not VOID) on disagreement before the deadline;
   - move the cron to 02:00 local.

   Then align `STALE_WINDOW` with the workflow deadline (findings A and B).
2. Feed the maker and the plugin from the Polymarket-implied ladder, with the v0 model only as a guardrail (finding C).
3. Freeze `src/`, create a dedicated attester key, and redeploy. Run the live e2e with `STATION=RCSS` so our own clones trade on live Kuru (findings E and the caveat on row 5).
4. Set the gas multiplier to 1.05–1.10 everywhere (finding D). Persist maker order ids from `OrderCreated` events, because `eth_getLogs` is limited to 100 blocks.
