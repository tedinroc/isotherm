# apps/api: fixes from the verifier rounds (2026-10-07)

**Live now:** Worker `isotherm-api`, version `60f3a919-9a31-4ed5-ab14-89f855846d2f`, build `24f390e-dirty.7af37257dba5`, deployed 2026-10-07T16:24:51Z (wrangler 3.114.17; the public route was switched off at 16:05:56Z by version `3e822652`), served at https://isotherm.pages.dev/api/* through the Pages Function's service binding; the Worker has no public hostname of its own (`workers_dev = false`, `preview_urls = false`). Its source is the same as version `0c112836-34d6-49ce-a719-f29bfa511479` (build `dfd0c41-dirty.045f16cadb36`, 13:27:31Z): only `wrangler.toml` changed. `/api/health` `version` says so itself.

## Round 3: stats classification at publish time (2026-10-07)

**No MON was spent.** The relayer's balance (4.570345078 MON) and nonce (13) were the same before and after the deploy, as were `dripsTotal` 3 and `relayedTotal` 1. The cron did the publish; no admin tick was called (`evidence/stats-reclassify-2026-10-07.txt`).

| # | Change | Evidence |
|---|---|---|
| R3-1 | **Maker / team / external is decided at publish time, from the current lists.**<br>Before: the scanner classified each fill when it scanned it and kept per-class counters and maps, so adding a wallet to `TEAM_ADDRESSES` did not move its earlier fills.<br>Now: the scan keeps raw per-`tx.origin` fills and volume for every origin (`scan:origins`). `publicStats` classifies them on each publish (maker, then team, then external) and also recomputes `recentTrades[].kind`. Each origin lands in exactly one class, so `fills` = `nonMakerFills` + `teamFills` + `makerTakerFills`. New fields: `makerTakerFills`, `classification {appliedAt, makerAddresses, teamAddresses, v1Migration}`. | Unit tests (9 new): reclassification, maker precedence, removal, no double count. Fork test asserts `classification` and the fills identity through the real Durable Object. |
| R3-2 | **One-time v1 migration.**<br>A v1 store is migrated on first load and the result is written to storage. v1's own keys are kept unchanged and never read again.<br>• Exact: when the v1 trade list held every fill and the rebuilt per-origin fills and volume match all of v1's counters and maps.<br>• Approximate otherwise: per-origin fills still come from v1's maps, so they reclassify, and volume / maker fills stay in their v1 class.<br>Totals are unchanged either way. | Live: `v1Migration: "exact"`. Unit tests cover the exact path, a reconciliation mismatch, the fallback, an origin present in both v1 maps (counted once), and migrate-once followed by a new fill. |
| R3-3 | **`TEAM_ADDRESSES` += `0xF4a3377D1200584D8Ab7d7e64c6B17dc6c792427`**, the team's Dynamic embedded wallet (email login on the live site). Its relayed mint `0xca08d015…` and Zap buy `0x361668d8…` (RCSS 2026-10-08 ≥28, 5.050505 YES @ 0.99) are our own testing. README "Who counts as traction" documents this. | Unit test parses `wrangler.toml` through `configFrom`. Live `/api/stats`:<br>• before: `nonMakerWallets` 1, `nonMakerVolumeAusd` 4.999999, that trade `external`<br>• after: `nonMakerWallets` 0, `nonMakerFills` 0, `teamFills` 2, `teamWallets` 2, `nonMakerVolumeAusd` 0, the trade `team`, `relayedMints` 1<br>Three consecutive publishes gave the same numbers. |

Tests: unit **57/57**, `tsc` 0, fork **6/6** on anvil :19660 and wrangler dev :19661/:19662, all exited afterwards (`evidence/stats-reclassify-2026-10-07-tests.txt`). Mutation: **15/15** mutants caught. They covered:
- the stored kind published;
- the team list ignored;
- re-migration on every load;
- the fallback dropping team wallets, or overwriting instead of summing;
- each of the five reconciliation checks skipped (total volume, external volume, maker fills, external map, team map);
- the legacy remainder ignored;
- team volume counted as external;
- the wallet missing from `wrangler.toml`;
- v1 keys overwritten on save;
- the raw per-origin map not saved.

The tests were tightened after two mutants survived the first pass (the total-volume check skipped, v1 keys overwritten on save), and a third survived the second pass (the map checks skipped).

## Round 2 (verifier issue 1)

**No MON was spent.** The relayer held 4.599171502 MON before and after the deploy and the live checks, with `dripsTotal` 3 and `relayedTotal` 0 unchanged (`evidence/live-verify-2026-10-07-r2.txt`).

| # | Change | Evidence |
|---|---|---|
| R2-1 | **Caps cover a horizon, not one day.** `scripts/size-caps.mjs --days N` (default 7, whole days 1–365) divides the spendable balance by N before sizing: one worst-case UTC day spends at most 1/N of it, so the relayer lasts N days of maximum use without a top-up. Before, a single day could take it all (at 4.6 MON that was 18 drips + 47 relays, 99.8 % of spendable in one day). Unknown flags such as `--day` are now errors, not a silent fallback to the default. Formula: `README.md` "MON budget", `wrangler.toml`, script header. | Unit tests `size-caps.test.ts` (8), including 2,000 random balance / gas / horizon cases: worst day ≤ spendable / N and N days ≤ spendable. |
| R2-2 | **Re-sized against the live relayer and redeployed** (read-only: balance, gas price, block).<br>Inputs at 07:59Z: 4.599 MON, 102 gwei, reserve 0.1 → 4.499 spendable → 0.643 MON per day over 7 days.<br>Result:<br>• `DRIP_DAILY_CAP` 2 (unchanged)<br>• `RELAY_DAILY_CAP` 9 (was 5)<br>• `DRIP_PER_IP_PER_DAY` 1 (unchanged)<br>• `RELAY_PER_IP_PER_DAY` and `RELAY_PER_ADDRESS_PER_DAY` 4 (were 2)<br>Worst-case day 0.628 MON; 7 such days 4.395 MON, inside the 4.499 spendable. Covers UTC days Oct 7–13 at maximum use. | `evidence/size-caps-2026-10-07-r2.txt`. Live `/api/health` `limits`. |
| R2-3 | **`fairSource` and `guardSource` pass through `normalizeSnapshot`** for every strike. Each one is a short lowercase label (`polymarket`, `fallback-v0`, `v0-truncated`, …). Anything missing or in another shape becomes null; it is never passed through raw. | Unit test against `packages/maker/examples/snapshot.example.json` and junk labels. Live `/api/snapshot` after the maker's 08:02:54Z post: `fairSource:"polymarket"`, `guardSource:"v0"` on all 4 strikes. |
| R2-4 | **`/api/health` (and `/api`) `version` names the build and the deploy:**<br>`{app, build, commit, dirty, builtAt, workerVersionId, deployedAt}`.<br>• `build` = git short commit (+`-dirty`) + SHA-256 of the bundle inputs, written by the new `scripts/build-info.mjs` during `prepare-data`.<br>• `workerVersionId` / `deployedAt` come from the new `[version_metadata]` binding (Cloudflare's upload time). Both are null under `wrangler dev`, which has no upload time. | Unit tests (3). Fork test checks `version.build` against `src/generated/build.json`. Live: `workerVersionId` `ea73ccfa…`, `deployedAt` 2026-10-07T08:02:18.233Z. |

Tests: unit **48/48**, `tsc` 0, fork **6/6** (anvil :19650, wrangler dev :19651/:19652, all exited afterwards). The fork run used the same build hash as the deploy (`evidence/fixes-2026-10-07-r2-unit-and-fork.txt`). Mutation: **8/8** mutants caught, each reverting one change. They covered: no horizon, default 1 day, unknown flags accepted, fairSource dropped, guardSource dropped, no label check, made-up deploy time, no build id.

Live refusals (`evidence/live-verify-2026-10-07-r2.txt`), each rejected before anything is signed or sent:
- a malformed drip address → 400;
- a precompile-range address → 400;
- a dust relay → 400;
- a permit relay → 400;
- an unknown series → 400;
- the wrong chain → 400.

CORS: the Pages origin is allowed; a look-alike origin gets no allow-origin header.

## Round 1

**No MON was spent.** The relayer held 0.599171502 MON before and after every deploy and live check, with `dripsTotal` 3 and `relayedTotal` 0 unchanged. The full record is in `evidence/live-verify-2026-10-07.txt`.

| # | Change | Evidence |
|---|---|---|
| 1 | **The verifier's fixes are kept and now deployed:**<br>• relay caps re-checked inside the single-sender queue (N4)<br>• IPv6 limited per /64 (N5)<br>• `/api/health` memoised for 5 s (N8)<br>• Polymarket URLs restricted to https polymarket.com (N9) | Their 4 tests still pass. Live since round 1 (version `ce5bfc02`). |
| 2 | **Caps sized to what the relayer can pay.** `scripts/size-caps.mjs` (read-only: one balance read and one gas-price read) prints the vars from the live balance; the formula is in `README.md` and `wrangler.toml`.<br>Inputs at 07:00Z: 0.599 MON, 102 gwei, reserve `RELAYER_MIN_MON` 0.1 → 0.499 MON spendable.<br>Result:<br>• `DRIP_DAILY_CAP` 2 (was 40)<br>• `RELAY_DAILY_CAP` 5 (was 60)<br>• `DRIP_PER_IP_PER_DAY` 1 (was 3)<br>• `RELAY_PER_ADDRESS_PER_DAY` 2 (was 10)<br>Worst-case UTC day is 0.491 MON, inside the 0.499 spendable. | `evidence/size-caps-2026-10-07.txt`. Superseded by R2-2 (7-day horizon at 4.6 MON). |
| 3 | **Drips and relays never spend the reserve.**<br>• A drip needs MON leg + `DRIP_GAS_MON` + reserve.<br>• A relay needs `RELAY_COST_MON` + reserve (it used to need only 0.15).<br>• `dripReady` / `relayReady` also turn false once the day's cap is used. | Unit tests "never relays into the reserve", "refuses a drip that would dip into the reserve", "ready flags respect the daily caps". |
| 4 | **Relay limit per network (new)**, `RELAY_PER_IP_PER_DAY` 2, keyed by IPv4 or IPv6 /64.<br>All relay caps are now checked **before any RPC read** and again inside the queue. | Unit test: 8 parallel requests from 8 holders on one network → 2 broadcast. Fork test: the 3rd holder on one network gets 429 with `retryAfterSec`. |
| 5 | **Minimum relay amount** `RELAY_MIN_AUSD` = 1 AUSD (1-unit mints were accepted before). | Unit test (refused before any RPC). Fork test. Live: `amount 1` → 400 "amount must be between 1 and 500 AUSD". |
| 6 | **Permit relays are off for the v1 vault.** `relayModes` returns `["authorization"]` whenever the vault has `mintSetWithAuthorization`. Permit is offered only for a vault without it **and** with `RELAY_ALLOW_PERMIT=1`. | Unit and fork tests. Live: health `relayModes: ["authorization"]`; a permit request → 400 "permit-mode relays are disabled…". |
| 7 | **Drips and relays count when they are broadcast, not when they succeed.** Monad bills the gas limit even when a tx reverts, so a holder who makes their own relay revert, or a drip whose receipt times out, still uses up quota.<br>• A drip whose AUSD leg failed or is unconfirmed is marked AUSD-pending, so a retry sends AUSD only.<br>• Before this, a relay that reverted was never counted, so a holder could repeat it without limit. | Unit tests "a relay that reverts on chain still uses up quota" and "a drip whose receipt never arrives still counts". |
| 8 | **Request limit per network**, `POST_LIMIT_PER_MIN` 30, held in the Durable Object's memory. It covers drip and relay POSTs, applies before any storage or RPC work, and is exact.<br>I tried a Workers Rate Limiting binding first. It deployed but never limited, even at 150 requests in a few seconds, so I removed it. | Unit and fork tests. Live: 35 junk POSTs → 26 × 400, then 9 × 429 "too many requests from this network". The first 4 checks in the same minute count toward the 30. |
| 9 | **Snapshot fields fixed:**<br>• `reason` now carries **this tick's** decision, with `action` next to it. The maker's stale "last re-quote / pull" text has moved to `lastChangeReason`, with `lastQuoteAt`.<br>• `bidSize` / `askSize` are passed through, and `bidRemaining` / `askRemaining` added; they were null before. | Unit tests, including against `packages/maker/examples/snapshot.example.json`. Live `/api/snapshot`: e.g. ≥30 `action:"none"`, `reason:"quote still good"`, `lastChangeReason:"bid 0.36 -> 0.34; …"`, `bidSize:100`, `bidRemaining:100`. |
| 10 | Small fixes:<br>• `POST /api/drip` with a `null` body gives 400, not 500.<br>• The fork test ports can be overridden (`ISO_ANVIL_PORT`, `ISO_API_PORT`, `ISO_INSPECTOR_PORT`). | Live check. README. |

## Tests

| Run | Result |
|---|---|
| Unit tests | **36/36** (20 existing + 16 in `relay-abuse.test.ts`) |
| Typecheck | `tsc` exit 0 |
| Fork integration | **6/6**: anvil on :19500, wrangler dev on :19501/:19502, all exited afterwards (`evidence/fixes-2026-10-07-unit-and-fork.txt`). On the fork, a first-time holder's relayed mint has a gas limit of 334,228 (estimate 309,470 × 1.08). That figure sets `relayCost`. |
| Mutation | **10/10** mutants caught, each reverting one fix (`evidence/mutation-2026-10-07.txt`) |
| Secret scan | 0 hits for the 11 key and token files in `~/.config/isotherm` across `apps/api` (excluding `node_modules`). |

## Live checks (`evidence/live-verify-2026-10-07.txt`)

- `/api/health` returns 200, with `access-control-allow-origin: https://isotherm.pages.dev`.
- The preflight from the Pages origin returns 204 with the allow headers. A look-alike origin gets no allow-origin header.
- `/api/snapshot` carries the new fields.
- Rejection responses:
  - drip for an address already funded today → 429 `retryAfterSec`;
  - dust relay → 400;
  - permit relay → 400;
  - forged signature → 400;
  - request flood → 429.

## For the other workstreams

- **Drips stay closed until 00:00 UTC (08:00 Taipei, Oct 8).** Today already had 3 drips against the cap of 2. Relays are open (0 of 9 used, round 2). `/api/health` says so: `dripReady:false`, `limits.dripsToday:3`.
- **Web:** `relayModes` is now only `authorization`, which v1 already uses. The minimum for a gasless pair, and for any relayed mint behind Buy No, is `relayMinAusd` (1 AUSD). Show it, or keep the input at 1 or more.
- **Web / mm plugin:** a 429 body carries `retryAfterSec`. The snapshot gives `fair` (the Polymarket-implied value) and `model` (the guardrail) per strike, plus sizes.
- **Web (round 2):** each snapshot strike now also carries `fairSource` and `guardSource`, as short lowercase labels or null. With them the UI can say when `fair` is a fallback (`fallback-v0` / `fallback-intraday`) rather than Polymarket, and which guardrail `model` is (`v0`, `v0-truncated`, `intraday`, `certain`). `apps/web/src/lib/api.ts` `SnapshotStrike` does not declare them yet.
- **Docs (round 2):** live caps are now 2 drips + 9 relays per UTC day, 1 drip + 4 relays per network, 4 relays per address. They were sized from 4.599 MON at 07:59Z over 7 days. `/api/health` `version` shows the build and the deploy time.

## Human actions

1. **Before 2026-10-14 (judging runs Oct 14–27):** top up the relayer, run `node apps/api/scripts/size-caps.mjs --days N` with N reaching past the next top-up (from Oct 14 to past Oct 27 is about 14–21 days), paste its vars into `wrangler.toml` and redeploy (`cd apps/api && npm run deploy`). Roughly 0.64 MON per day keeps 2 drips + 9 relays a day. At today's 4.6 MON with `--days 21`, the script gives 0 drips and 6 relays a day.
2. Optional: Turnstile on `/api/drip`. Requests from many IPs can still use up a day's caps, but no longer the reserve, and never more than one day at a time.
