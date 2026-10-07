# Go-live: RESULT (2026-10-07, 13:50–14:20 Taipei)

**Verdict: live.** The first real Taipei ladder is open and quoted on Monad testnet:
- **Ladder:** RCSS, Thu 2026-10-08, strikes ≥28/29/30/31 °C, each on its own canonical Kuru YES/AUSD book.
- **Maker:** runs under launchd, re-quotes on ticks, and posts its snapshot to the live API.
- **Phone smoke test** at https://isotherm.pages.dev passed: dev wallet → test funds → Buy Yes → position shown. It found one live API bug (the drip's AUSD leg), which I fixed, redeployed and re-verified live.

All 43 live transactions are re-checked from their receipts in `live-txs.tsv`; every one has status `success`.

## What was done (with evidence)

1. **Funding** (`fund.mjs`, `fund-log.tsv`). Transfers went from the deployer, one at a time, ≥5 blocks apart for Monad's reserve-balance rule; each receipt and balance delta was checked.

   | Recipient | Amount (MON) | Tx |
   |---|---|---|
   | operator | 0.75 | `0x67d6595e…f938c9` |
   | maker | 1.65 | `0x66b4bd4e…950120` |
   | relayer | 0.90 | `0xce1ee902…f9479a` |
   | guardian | 0.05 | `0x1d7488c6…83b98`; done so `pause`/`challenge` work in an emergency |
   | maker (later) | 0.45 | `0xf1da7040…83fb98`; so the daily cap + reserve + close-time kill switch always fit in its balance |

   The deployer kept **0.8496 MON** (≥0.8 as required).
2. **Live roll** (`roll-2026-10-08.json`, `roll-2026-10-08.stderr.log`). Run as `packages/maker` `roll --station RCSS --date 2026-10-08`: 27 txs in 64 s, ok=true.
   - **Operator** (0.776 MON): `createLadder` `0x84e46894…`; 4 × Kuru `deployProxy`; 4 × `Zap.setCanonicalMarket`.
   - **Maker** (0.480 MON): approve; 4 × `mintSet` ×300; AUSD margin 400; YES margin 300 per strike; 4 × initial quotes.
   - **Initial quotes:** ≥28 0.92/0.99, ≥29 0.80/0.87, ≥30 0.43/0.50, ≥31 0.06/0.13, 100 YES each side.
   - These were centred on Polymarket-implied P(≥k) of 0.950/0.840/0.461/0.092 from the CLOB of `highest-temperature-in-taipei-on-october-8-2026`.
3. **Books checked independently on chain** (`books-verify-20261007T055705Z.txt`, plain `cast call`):
   - `vault.ladderSeries` returns the 4 seriesIds, and `getSeries` gives closeTime 1791451800 (17:30 Taipei), gated=false, collateral 300.
   - `zap.canonicalMarket(seriesId)` equals the market in maker state for all 4.
   - Each book's `bestBidAsk` equals the quotes above. `s_orders(1,2)` are owned by the maker, 100 YES each.
   - Maker free margin is 179 AUSD (400 − 221 locked in bids).
4. **Maker under launchd** (`launchd-status.txt`, `xyz.isotherm.*.plist`, `snapshot-after-requote.json`).
   - The first attempt failed with exit 126: launchd jobs cannot read `~/Documents` (macOS TCC).
   - The fix: `packages/maker/scripts/deploy-runtime.sh` copies the maker into `~/isotherm-live`, and `config/local.json` points both copies at one shared state, lock and heartbeat. The loop, hourly roll and 5-min watchdog now run (`launchctl list`: maker pid alive, last exit 0).
   - **Re-quote seen live:** tick 7 at 06:07:53Z re-quoted ≥29 (fair moved), ≥30 (fair 0.4278 crossed the resting bid 0.43; guard-wide) and ≥31 (`ask partly filled (23.08 left)` after the smoke-test buy).
   - **Snapshot POSTs reach the API:** `/api/health` `snapshotReceivedAt` updates every tick, and `/api/snapshot` shows the 4 strikes with fair, Polymarket, model, bid and ask.
   - **The hourly roll path** queued `roll RCSS 2026-10-08` to the loop and re-rolled with **0 txs** (idempotent).
5. **API/web.** Both were already deployed by the web workstream and pointed at v1; secrets `RELAYER_KEY`, `SNAPSHOT_TOKEN` and `ADMIN_TOKEN` were present. My changes:
   - **Bug fix** in `apps/api/src/relayer.ts`, drip.
     - *Cause:* Monad's RPC returns a stale `eth_getTransactionCount('pending')` right after a send. I confirmed this live with taker2: pending stayed 5 after sending nonce 5. The AUSD leg therefore reused the MON tx's nonce and was rejected, and the web showed "Missing or invalid parameters" (`screens/03-…`). Because nothing was recorded, a retry would also send MON again: a drain vector.
     - *Fix:* count nonces locally, and record MON-sent / AUSD-failed as AUSD-pending so a retry sends AUSD only.
     - *Tests:* API unit 20/20; fork integration 6/6 (`api-fork-tests-after-nonce-fix.txt`).
     - *Live:* Worker version `ed0ab137`. A two-leg drip to a throwaway took 1.3 s with both txs succeeding (`drip-two-leg-after-fix.json`). The throwaway's MON went back to the relayer.
   - **Stats exclusion.** `TEAM_ADDRESSES` += the smoke-test dev wallet `0xd42A…D79c`, so our own fill is classified `team` and the public "trading wallets" counter stays 0 (`api-stats-after-smoke.json`).
6. **Live phone smoke test** (in-app browser, 375×812; `screens/01…07`; dev wallet `0xd42A0b394F09df88BB2120D0973569b845f2D79c`).
   - The wallet was already in the browser (created earlier by the web workstream), with nonce 0 and 0 balance. The app's "Forget" uses `window.confirm`, which the test browser did not show, so I kept that wallet.
   - **Get test funds.** The first try sent 0.15 MON (`0x7f60cdc2…644d`) but the AUSD leg hit the bug. After the fix, 1,000 AUSD arrived in 0.7 s (`0x32117783…a105`).
   - **Buy Yes ≥31 °C, 10 AUSD → 76.85 YES at 0.13**, filled in 1.5 s: approve `0x42a7a130…7063`, `Zap.buyYes` `0x065660cc…125f`.
   - **Portfolio** shows "Taipei ≥ 31°C · Oct 8 · Open · Yes 76.85", with the value marked at the bid.
7. **Operations doc:** `docs/OPERATIONS.md` covers what is live, the keys, launchd jobs, caps, status/stop/restart/pull commands, the emergency pause, the funding routine, API/web deploy, settlement, and limits.

## Balances after (`balances-after.txt`, block 68,896,188)

| Wallet | MON | AUSD |
|---|---|---|
| deployer | 0.8496 | 0 |
| operator | 0.1237 | 0 |
| maker | 1.7345 | 18,102.89 (+400 AUSD and 4 × 300 YES in Kuru margin) |
| relayer | 0.7506 | 58,000 float |
| guardian | 0.05 | 0 |
| attester | 0.10 | 0 |
| smoke dev wallet | 0.0892 | 990 (+76.85 YES ≥31) |

Maker meter for Taipei day 2026-10-07: maker 0.651 / cap 0.8, operator 0.178 / 0.5, marketCreator 0.599 / 0.8.

## Not done / caveats

- **Tomorrow's roll (Oct 9 ladder) needs MON.** The operator holds 0.12 and needs ≈0.85 before 12:00 Taipei on Oct 8. Until then the hourly roll is refused before broadcasting anything and retries every hour.
- **Settlement of the Oct 8 ladder is not running from this step.** It is the CRE workstream's launchd job (`packages/cre-workflow`). That job will hit the same `~/Documents` TCC block unless it runs from a copy outside `~/Documents` or `/bin/bash` gets Full Disk Access. If nothing settles, `voidIfStale` pays 0.5/0.5 after 2026-10-11 00:00 Taipei.
- **The relayer can fund only about 2 more new users** at 0.15 MON per drip; it holds 0.75 and needs 0.45 headroom to drip. Gasless relayed mints cost ≈0.03 each.
- **Login was not exercised fresh.** The smoke test reused an existing, empty dev wallet. Dynamic login is still unconfigured.
- **Maker fork tests were not re-run.** `config/local.json` (lower caps, absolute var paths) is merged into every `loadConfig`. The fork tests override paths and adjust caps themselves; the maker unit tests pass 24/24 with it.
- **Code edits outside my folder, for go-live:**
  - `apps/api/src/relayer.ts` (nonce fix) and `apps/api/wrangler.toml` (`TEAM_ADDRESSES`);
  - `packages/maker/config/local.json` and `packages/maker/scripts/deploy-runtime.sh`;
  - `packages/maker/var/` emptied (live state moved to `~/isotherm-live`; README.txt left there).

## Human actions

1. Claim testnet MON daily and fund from the deployer with `cd docs/evidence/golive && node fund.mjs operator=0.8 maker=0.8 relayer=1.0`. The operator must have ≥0.85 before 12:00 Taipei on Oct 8 for the automatic Oct 9 ladder.
2. Keep the Mac awake and logged in; the launchd agents live in the GUI session.
3. Get settlement running for 2026-10-08 (first attempt 02:35 Taipei on Oct 9) via the CRE workstream, from a non-`~/Documents` path or with Full Disk Access for `/bin/bash`.
4. Optional: Dynamic environment ID for email/Google login. Give the guardian key a home off this Mac.
