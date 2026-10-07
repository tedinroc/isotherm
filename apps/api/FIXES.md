# apps/api: fixes from the v1 verifier round (2026-10-07)

**Live now:** Worker `isotherm-api`, version `ce5bfc02-7145-4d8f-b9f0-501e2f9ddcdf` (wrangler 3.114.17), at <former API host>.

**No MON was spent.** The relayer held 0.599171502 MON before and after every deploy and live check, with `dripsTotal` 3 and `relayedTotal` 0 unchanged. The full record is in `evidence/live-verify-2026-10-07.txt`.

| # | Change | Evidence |
|---|---|---|
| 1 | **The verifier's fixes are kept and now deployed:**<br>• relay caps re-checked inside the single-sender queue (N4)<br>• IPv6 limited per /64 (N5)<br>• `/api/health` memoised for 5 s (N8)<br>• Polymarket URLs restricted to https polymarket.com (N9) | Their 4 tests still pass. Live: version above. |
| 2 | **Caps sized to what the relayer can pay.** `scripts/size-caps.mjs` (read-only: one balance read and one gas-price read) prints the vars from the live balance; the formula is in `README.md` and `wrangler.toml`.<br>Inputs at 07:00Z: 0.599 MON, 102 gwei, reserve `RELAYER_MIN_MON` 0.1 → 0.499 MON spendable.<br>Result:<br>• `DRIP_DAILY_CAP` 2 (was 40)<br>• `RELAY_DAILY_CAP` 5 (was 60)<br>• `DRIP_PER_IP_PER_DAY` 1 (was 3)<br>• `RELAY_PER_ADDRESS_PER_DAY` 2 (was 10)<br>Worst-case UTC day is 0.491 MON, inside the 0.499 spendable. | `evidence/size-caps-2026-10-07.txt`. Live `/api/health` `limits`. |
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

- **Drips stay closed until 00:00 UTC (08:00 Taipei, Oct 8).** Today already had 3 drips against the new cap of 2. Relays are open (0 of 5 used). `/api/health` says so: `dripReady:false`, `limits.dripsToday:3`.
- **Web:** `relayModes` is now only `authorization`, which v1 already uses. The minimum for a gasless pair, and for any relayed mint behind Buy No, is `relayMinAusd` (1 AUSD). Show it, or keep the input at 1 or more.
- **Web / mm plugin:** a 429 body carries `retryAfterSec`. The snapshot gives `fair` (the Polymarket-implied value) and `model` (the guardrail) per strike, plus sizes.

## Human actions

1. **Before judging (Oct 14–27):** top up the relayer, run `node apps/api/scripts/size-caps.mjs`, paste its vars into `wrangler.toml` and redeploy (`cd apps/api && XDG_CONFIG_HOME=<wrangler config dir> npm run deploy`). At the current 0.6 MON it serves 2 new wallets a day.
2. Optional: Turnstile on `/api/drip`. Requests from many IPs can still use up a day's caps, but no longer the reserve, and never more than one day at a time.
