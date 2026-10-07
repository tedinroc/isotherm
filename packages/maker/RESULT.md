# packages/maker: RESULT (2026-10-07)

**Verdict: ready for go-live. Only MON funding is missing.**

The maker has three parts:
- a long-running quoter;
- a one-shot `tick`;
- an idempotent, resumable daily `roll`.

It also has an independent kill switch, a daily MON meter and a snapshot feed. All of it runs end to end against the **live v1 deployment**, on anvil forks of today's testnet (deployments/testnet.json, vault `0xae36…7B39`, Zap `0x1ACa…CFb0`).

**Nothing was broadcast to the live chain.** Live was touched read-only only:
- `preflight` (reads and `eth_call`);
- `roll --dry-run` (eth_call simulation of `createLadder` from the operator).

## Go-live runbook (for the step that broadcasts)

```bash
cd packages/maker                                   # npm install already done (viem 2.57.3)
node src/cli.ts preflight --station RCSS --date tomorrow     # read-only; expect "ready": true
ISOTHERM_ALLOW_LIVE=1 node src/cli.ts roll --station RCSS --date tomorrow   # JSON report on stdout, logs on stderr
ISOTHERM_ALLOW_LIVE=1 ISOTHERM_API_URL=https://<api> ISOTHERM_SNAPSHOT_TOKEN=<SNAPSHOT_TOKEN> node src/cli.ts loop
# or as launchd agents: put those 3 env vars in ~/.config/isotherm/maker.env (chmod 600), then
launchd/install.sh --load       # maker loop (KeepAlive) + hourly roll (--not-before 12:00 Taipei) + 5-min watchdog
```

- **Live guard.** Every write refuses a non-anvil RPC unless `ISOTHERM_ALLOW_LIVE=1`. Any chain other than 10143 is refused outright, so mainnet is never touched.
- **One writer.** A lock file allows a single writer. While the loop runs, `roll` queues its request (`var/requests/`) and the loop executes it.
- **Live preflight now** (block 68,886,679):
  - v1 is deployed and RCSS is registered (dayEnd 1791475200).
  - The operator `0x602d…bd51` is authorised.
  - `Router.deployProxy` from the operator succeeds as an eth_call. **Market creation is permissionless on testnet**; mainnet is owner-gated, per the Kuru spike.
  - The plan is strikes **28/29/30/31**, from the Polymarket median of 29.
  - Close is **17:30** local and the maker stops at **17:20**.
  - **Blocking:** operator has 0.15 MON and needs about 0.77; maker has 0.29 MON and needs about 0.48 plus the quoting cap.

## What it does

| Part | Behaviour |
|---|---|
| **fair** | `packages/forecast` `computeFairs`: the Polymarket-implied P(Tmax ≥ k) from the live CLOB, conditioned on the observed METAR max. v0 (or, on day D after 11:00, the 2-year intraday increment table) is the guard: a gap above 0.15 doubles the spread and above 0.40 pulls the strike. With no usable Polymarket it uses the v0 fallback with a doubled spread. With nothing usable it pulls. **No forecasting-edge claim anywhere.** |
| **quote** (`pricing.ts`, pure) | Half-spread is 3 ticks of 0.01 (configurable); Kuru's tick is 0.001. Prices round outward. **bid < fair < ask always.** Prices stay in [0.01, 0.99]. It pulls at fair ≤ 0.03 or ≥ 0.97. Inventory skew is up to 2 ticks at the cap. The position cap is ±300 YES per strike: no bid at +cap, no ask at −cap, and a fill can never push it past the cap. **Post-only, and it never crosses anybody else's quote.** The maker never sends a taker order, so it never self-trades. Sizes come from free margin plus what the cancels free. A property test checks 5,000 random inputs. |
| **when to re-quote** (`policy.ts`, pure) | It re-quotes only when one of these happens: no resting quote; a side filled, or less than 50% of it is left; the desired price moved **≥ 2 ticks**; the quote is **older than 6 h**; or fair crossed a resting quote, which is **urgent**. The observed max ≥ k pulls the strike as "certain". At stopAt − 90 s it closes. |
| **MON budget** (`budget.ts`) | A meter per role per Taipei day; Monad bills the gas limit. Caps: maker 1.5, operator 1.5, market creator 1.5. Quotes beyond the cap are **refused**. An urgent re-quote that is refused becomes a pull paid from a reserve (maker 0.4). The **kill switch is never refused**; it is flagged when over budget. A roll that is over cap blocks. |
| **kill switch** (`tick.ts killLadder` + `runWatchdog`) | At closeTime − 10 min it cancels every maker order on every strike. It cancels the tracked ids **plus a scan of the last 300 order ids**, so it works even if state is lost, and retries 3 times. It then withdraws the YES margin. It uses only time, state and the chain, with no market data. It runs at the top of every tick, on a 15 s timer in the loop, and as a **separate launchd job every 5 min** that steps in when the loop's heartbeat is more than 3 min old. |
| **roll** (`roll.ts`) | 1. preflight; 2. plan strikes and **persist them before any tx**; 3. `createLadder` (operator), or `createSeries` for only the missing strikes; 4. faucet if short (global 60 s cooldown handled); 5. `mintSet` up to 300 NO per strike; 6. `Router.deployProxy` per strike (market creator; **the tx hash is persisted before the receipt is awaited**); 7. `Zap.setCanonicalMarket` (operator, write-once); 8. AUSD margin once per ladder and YES margin per strike; 9. initial quotes. Every step re-checks the chain first. |
| **snapshot** (`snapshot.ts`) | `var/snapshot.json`, plus `POST <ISOTHERM_API_URL>/api/snapshot` with `Authorization: Bearer $ISOTHERM_SNAPSHOT_TOKEN` every tick. Schema `isotherm.snapshot/v1`; example in `examples/snapshot.example.json`. |
| **launchd** | `launchd/*.plist.template`, `launchd/install.sh` (renders and lints with `plutil` by default; `--load` bootstraps) and `scripts/run.sh` (loads `~/.config/isotherm/maker.env`). |

## Evidence (all commands were run here)

1. **Unit tests: 24/24.** Command: `npm test`.
   - pricing: 8, including the 5,000-input property test (never crossed, off-grid, out of band, or negative edge);
   - policy: 9;
   - budget: 2;
   - deployment / lock / Kuru L2 decode / state / config: 5.

   `packages/forecast`: 26/26. `tsc --strict` is clean over both packages (45 files).

2. **Fork integration test: pass.** Command: `npm run test:fork`. Evidence: `evidence/fork-2026-10-07T05-27-33/` (summary, `txs.tsv`, state, snapshots). It ran against **v1** on anvil :19150 with the real Kuru Router, MarginAccount and AUSD.
   - **dry-run roll**: plans and estimates, 0 txs.
   - **roll**: 27 txs. ladder [28,29,30,31] → mint 4×300 → 4 Kuru markets → 4 canonical in the Zap → margin → quotes. ≥30 quoted 0.44/0.51 around Polymarket 0.473.
   - **re-roll**: 0 txs, same markets (idempotent).
   - **tick 1**: 4× none, 0 txs.
   - **taker1 buys 56 AUSD on ≥30** → 99.9 YES, filling our whole ask.
   - **tick 2**: ≥30 re-quote (`ask side empty (filled)`); net YES −100.
   - **tick 3**: Polymarket moves ≥29 to 0.70 and a METAR shows 28. ≥28 is **pulled (certain)**; ≥29 re-centres on 0.7376 = 0.70/P(≥28) → 0.70/0.77.
   - **kill switch** after a jump to stopAt +6 s: cancelled 6, **0 open maker orders and empty books on all 4 markets**, YES margin withdrawn; a later tick sends 0 txs.
   - The meter equals the sum of billed costs.
3. **Fork failure-path test: pass.** Evidence: `evidence/fork-resume-2026-10-07T05-26-58/`.
   - A crash injected right after broadcasting `deployProxy ≥30` → the resume **recovered that market from the persisted hash**: 4 broadcasts for 4 strikes, **no duplicate market**, all canonical.
   - The MON cap refused a non-urgent re-quote; the quotes stayed.
   - With fair crossing the resting ask (urgent) and no budget → **pulled from the reserve**.
   - Manual pull → 6 cancelled, ladder paused, 0 txs on the next tick.
4. **The real CLI with LIVE market data on a fork.** Command: `scripts/fork-cli-demo.sh`. Evidence: `evidence/cli-fork-2026-10-07T05-21-51/`.
   - Inputs: Polymarket CLOB, aviationweather and IEM, Open-Meteo.
   - Sequence: preflight → roll (Polymarket median 29; P 0.949/0.848/0.468/0.092) → `loop --max-ticks 3` → time jump → `watchdog --verify` (cancelled 8, all strikes closed).
   - **3 snapshot POSTs were received** by a stand-in API with the right bearer token.
   - The real `apps/api` `normalizeSnapshot()` parses the posted body: 1 ladder and 4 strikes with market, marketBlock, fair, pmImplied, model, bid and ask.
5. **Live, read-only.** `preflight` is above. `roll --dry-run` → `createLadder RCSS 20261008 [28,29,30,31]` simulates from the operator: est 1,081,749 gas, ~0.105 MON.

## MON per Taipei day (fork gas × live 102 gwei; Monad bills the limit)

| | MON |
|---|---|
| roll, operator key: `createLadder`(4) 0.121 + 4 × `deployProxy` 0.149 + 4 × `setCanonicalMarket` 0.014 | **~0.77** |
| roll, maker: approve, 4 × mint 0.030, 4 × approve+deposit YES 0.024, AUSD deposit 0.015, 4 × quote 0.059 | **~0.48** |
| each re-quote (cancel 2 + place 2) / pull / kill per strike / YES withdraw | 0.052–0.058 / 0.028 / 0.028 / 0.037 |
| quoting cap (config) | ≤ 1.5 (about 26 re-quotes) |
| **day total** | **≤ ~2.9** |

Anvil's fork base fee decays, so its receipts under-bill by about 3×. The table re-prices gasLimit × 102 gwei.

## Snapshot schema `isotherm.snapshot/v1` (for apps/api and apps/web)

```
{ schema, generatedAt, chainId:10143, network, block, blockTime, rpcKind, honesty[4],
  maker{address, mon, ausdWallet, ausdMargin}, deployment{variant, vault, resolver, zap, kuruRouter, source},
  budget{day, note, byRole{maker|operator|marketCreator: {key, address, spentMon, capMon, txs}}},
  ladders[{ key, station, city, date "YYYY-MM-DD", status planned|rolling|active|closed, paused, strikeList[],
            strikeSource, closeTime, stopAt, dayEnd, closeLocal, stopLocal, result{status none|settled|void, tmaxC},
            observedMaxC, observedAt, forecast{mu, role}, observed{...},
            polymarket{url, slug, volume, sumRaw, fetchedAt, quoteSource, ok, warnings[], median, ladder{k:p}, buckets[]},
            v0{mu, lead, residSd, ladder},
            strikes[{ strike, seriesId, yes, no, market, marketBlock, canonical, mode pending|quoting|pulled|certain|closed,
                      reason, fair, fairSource, pm, pmImplied, pmCond, guard, model, guardSource, divergence, flags[],
                      bid, bidSize, ask, askSize, quote{...}, resting, book{bestBid, bestAsk, bids[[p,s]], asks[[p,s]]},
                      inventory{walletYes, walletNo, marginYes, lockedYes, netYes}, lastAction{kind, reasons, tx, error} }] }],
  events[last 30] }
```

- `marketBlock` is the `deployProxy` block. Log scanners should start there, because eth_getLogs is capped at 100 blocks.
- The `honesty` strings state that everything is testnet / faucet AUSD only, that we have no forecasting edge (v0 does not beat Polymarket), that fidelity is 183/184 RCSS and 209/209 RJTT, and that maker fills are the house bot's.

## Not done / limits (honest)

- **Nothing has traded live yet.** The first live ladder is the go-live step's `roll`.
- The meter only counts a tx once its receipt is seen. A crash between broadcast and receipt (the tested case) under-counts that one tx.
- No automatic redemption or merging after settlement. AUSD comes from the faucet (10k per 0.013 MON claim), so the maker leaves NO/YES in the wallet. `vault.redeem` works manually.
- One bid level and one ask level per strike (no depth ladder), to keep re-quotes at about 0.055 MON.
- Tokyo (RJTT) works in code and in the close-time config. It is not scheduled: the roll plist rolls RCSS only. Add a second plist, or a second `roll --station RJTT` request, when the MON budget allows.
- The quote tick is 0.01 (cents) by design. Kuru supports 0.001 if tighter quoting is wanted (`quote.tick`).

## Human actions

1. **Fund the role keys** with testnet MON. From the deployer, wait at least 4 blocks between value transfers, because of Monad's emptying-tx rule for accounts under 10 MON.
   - **operator** `0x602dbf3937558B1d18d76315635fD5410089bd51`: ≥ 0.9 MON per daily roll.
   - **maker** `0xd572638F07829D1c3636400FB73CF34Ca6c7448a`: ≥ 2.5 MON per day (roll 0.48 + quoting cap 1.5 + kill/withdraw ~0.15).
2. Create `~/.config/isotherm/maker.env` (chmod 600) with:
   - `ISOTHERM_ALLOW_LIVE=1`
   - `ISOTHERM_API_URL=<deployed apps/api origin>`
   - `ISOTHERM_SNAPSHOT_TOKEN=<the Worker's SNAPSHOT_TOKEN secret>`

   Then run `launchd/install.sh --load`. The Mac must stay awake; the watchdog job is the safety net if the loop dies.
3. Keep claiming testnet MON daily. A Taipei day needs about 2.9 MON in the worst case.
