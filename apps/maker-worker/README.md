# apps/maker-worker — the Isotherm market maker on Cloudflare

The same market maker that runs on the Mac under launchd (`packages/maker`), moved to a Cloudflare Worker so
that judging does not depend on one laptop staying awake. It quotes the Kuru v1 YES/AUSD books, rolls the next
day's ladder, runs the close-time kill switch and watches settlements. It also guards settlement liveness: a
ladder with no result 3 h after its day end raises `SETTLEMENT OVERDUE` (optionally pushed to a phone), and one
still unresolved when the Resolver's 48 h stale window opens is voided by the Worker itself. Monad **testnet**
(10143) only.

**It is the live market maker since 2026-10-08 23:06 UTC.** A fresh deployment starts in SHADOW mode and sends
nothing; going live takes two separate switches, which the cutover runbook (docs/OPERATIONS.md §8) flipped after the
shadow results had been reviewed. The 2026-10-09 release (its deployment status is in docs/OPERATIONS.md §8.9) also
makes it spend testnet MON frugally (lazy re-quoting, a quoting budget with tiers, a 4-strike roll; "MON budget"
below), read Monad through several RPCs with a throttle and a fallback ("RPC" below), and keep the role keys funded
from a dedicated treasury key ("Treasury top-up" below).

## How it runs

```
cron "* * * * *" ──► Worker.scheduled ──► MakerDO /kick   (re-arms the alarm if it is missing or overdue)
                                             │
                     MakerDO.alarm() every TICK_SEC (sooner when a ladder's kill-switch time comes first)
                                             │
  control (KV) ─► mode ─► kill switch ─► roll ─► reconcile orders ─► quote ─► settlement watcher ─► treasury ─► snapshot ─► outbox (KV)
                                                                              (+ overdue alert,       (every 10 min,          (+ optional
                                                                               stale void)             top-ups)                alert push)
```

- **One writer.** A single Durable Object, `MakerDO` (`idFromName("maker")`, SQLite-backed), holds all of this:
  - the state (ladders, series, Kuru order ids);
  - the MON meters;
  - a nonce tracker per key;
  - the live flag.

  Ticks never overlap: the runtime runs one alarm at a time, and the internal `/tick` route waits for a running
  tick. State writes are synchronous SQL. The runtime's output gate holds every outgoing request until those
  writes are durable, so a planned ladder or an in-flight tx hash is stored before the tx that depends on it is sent.
- **No public surface.** `workers_dev = false`, `preview_urls = false` and no routes. `fetch()` answers 404. The
  Durable Object is reachable only from the Worker's own code. Operators use the control KV through
  `scripts/control.mjs`. The API is reached through the **service binding** `API` → `isotherm-api`, never by URL.
- **Shared logic, unchanged.** The trading logic is imported from `packages/maker` and `packages/forecast`:
  - `tick.ts`, `roll.ts`, the `send()` path in `chain.ts`, `policy.ts`, `pricing.ts`, `budget.ts`, `kuru.ts`;
  - `fair.ts` and the Polymarket, observation, v0 and close-time cores.

  Those packages were split minimally so that this core has no Node APIs. The Node pieces (files, launchd, the
  lock) stay in `config.ts`, `state.ts`, `deployment.ts`, `data.ts`, `snapshot.ts`, `node-io.ts`, `context.ts` and
  the CLI. `packages/maker/test/core-purity.test.ts` checks the import graph. The Mac's Node runner behaves as
  before: 27/27 unit tests, and both fork tests pass again after the split.

## Modes and the two switches

| | SHADOW (default) | LIVE |
|---|---|---|
| Needs | nothing | `MAKER_MODE = "live"` (wrangler.toml var) **and** the Durable Object flag (`scripts/control.mjs arm`, which confirms with the maker address) **and** the `MAKER_KEY`/`OPERATOR_KEY` secrets |
| Txs | every decision is computed with the shared dry-run path (eth_call simulation, gas estimate, budget check) and recorded as an *intent*; nothing is signed | sent, with a last guard right before each broadcast |
| State | its own (`state:shadow:*`), mirrors the live maker's orders found on the books | `state:live:*` (import the Mac's `state.json` at cutover) |
| Snapshot | **not** published: it would replace the Mac's and show quotes that are not on the books. The binding is still read (`GET /api/snapshot`) to compare decisions with the live maker. | `POST /api/snapshot` through the binding (Bearer `SNAPSHOT_TOKEN`), `source: "isotherm-maker-worker"` |
| Watcher | recomputes and alerts; a challenge or a due stale void is simulated and recorded | challenges a reproduced mismatch with `GUARDIAN_KEY`; sends a due `voidIfStale` from `OPERATOR_KEY` |

- **Interlock.** In live mode, each tick reads `GET /api/snapshot`. If the latest snapshot is younger than
  `INTERLOCK_FRESH_SEC` (300 s) and comes from another source (the Mac maker still running), the tick falls back
  to shadow and raises an alert. Two writers therefore never race one key. The close-time kill switch is the one
  thing that still runs live during an interlock, because cancels are idempotent.
- **Watch-only shadow.** If the vars `MAKER_ADDRESS` / `OPERATOR_ADDRESS` are set and there are no key secrets, the
  shadow mirrors those public addresses and can never be armed.

## Tick (every minute)

Ticks run every `TICK_SEC` measured from tick start to tick start (no drift by the tick's own duration, like the
Mac's loop), and earlier when a ladder's kill-switch time comes first.

1. **Control.** Apply a new control document from KV: `arm` / `disarm` / `importState` / `pull` / `resume` /
   `roll` / `resetShadow`. Each document is applied once per `seq`.
2. **Mode.** Decide shadow or live (both switches, the keys, the interlock).
3. **Kill switch** (`runWatchdog`). At `stopAt − 90 s` it cancels every maker order on every strike. It cancels the
   tracked ids plus a scan of the last 300 ids, then withdraws the YES margin. The alarm is scheduled for that
   moment, so the kill switch does not wait for the next minute. In shadow the cancels and the margin withdraw are
   intents, and the shadow ladder is then closed. Every `WATCHDOG_VERIFY_SEC` (300 s) it also re-scans the books of
   ladders closed in the last 2 days and cancels any maker order still open, like the Mac's `watchdog --verify` job.
4. **Roll.**
   - Queued requests run first.
   - Then, from `ROLL_NOT_BEFORE_LOCAL` (12:00 station time), tomorrow's ladder is rolled. The roll is idempotent
     and resumable: every step re-checks the chain, and the deployProxy hash is persisted before the receipt.
   - Today's on-chain ladder is adopted if state lacks it. It is never created from scratch.
   - Live retries every 5 min until the ladder is active. Shadow re-plans at most every `SHADOW_ROLL_EVERY_SEC`.
   - Shadow does **not** keep a dry-run plan (it would freeze the strikes of that minute's Polymarket data). The plan
     is kept for comparison in `shadow:plan:<key>`. Once the live maker's real ladder is on chain, the shadow adopts
     it, with its strikes, within 2 minutes.
5. **Reconcile.** Per strike, read the book's order counter. When it moved, scan the new ids for open maker orders:
   - Shadow tracks the newest bid and ask, which are the live maker's. It also mirrors the live maker's `lastQuote`
     (`lastQuoteAt` from its published snapshot), so it predicts the policy's "fair moved" and "stale quote"
     re-quotes too.
   - Live adopts open orders it lost track of after a cutover or an interrupted tick, and cancels any extra ones.
6. **Quote** (`tickLadder`).
   - Fair = the Polymarket-implied P(Tmax ≥ k), conditioned on the observed METAR max.
   - The v0 / intraday guardrail widens or pulls. The wide spread has hysteresis: entered above |fair − guard| 0.15,
     kept while ≥ 0.13 if the resting quote was placed wide (`guard-wide-held` in the tick lines).
   - Post-only, one bid and one ask per strike, re-quoted only when the shared lazy policy says so
     (`packages/maker/src/policy.ts`, `policy.lazy`): (a) the fair is at or through a resting price (urgent, at once);
     (b) a side filled or needs a refill; (c) the fair moved ≥ `requoteFairMove` 0.04 since the quote; (d) the quote is
     older than `staleRefreshHours` 2 h and the fair moved ≥ `staleRefreshMinMove` 0.02; (e) the guard now wants the wide
     spread over a narrow resting quote. A drifting desired price is not a reason by itself.
   - A fill is refilled on its own side only (`policy.oneSided`): one `batchUpdate` that places the missing order and
     leaves the other one on the book (55 % of a full re-quote's gas; `evidence/one-side-gas-2026-10-09/`).
   - The quoting budget tier (below) can widen the spread ×2, hold back non-urgent re-quotes, or turn an urgent
     re-quote into a pull.
7. **Watcher** (every `WATCH_EVERY_SEC`). This is the Mac's `challenge-watch.ts` logic.
   - Resolver events are read with `eth_getLogs` in pages of ≤ 100 blocks, stopping 5 blocks behind the head (with
     several RPCs an endpoint can answer a page past its own head with a silently truncated result), plus a backstop
     over the newest 64 ladders.
   - Each result is recomputed with the CRE workflow's own `sources.ts` and `settle-core.ts` `decide()`.
   - A reproduced mismatch inside the 900 s window is challenged, but only in live mode, only with a guardian key
     that matches `Resolver.guardian()`, and with gas = estimate × 1.1. The live guardian key is refused on a fork.
   - **Settlement guardrails** for every vault ladder that has no result yet (see "Settlement guardrails" below).
8. **Treasury** (every `treasury.everySec`, 600 s): top up the role keys (below).
9. **Snapshot** (live only). Then the outbox is written to KV: `status`, `tick:last`, `ticks:recent` (the last 90
   ticks, one line per strike: `scripts/control.mjs ticks`), `shadow:summary`, `alerts`. Each alert is also pushed
   to `ALERT_WEBHOOK_URL` when that optional secret is set.

In shadow, a would-be tx that repeats tick after tick (same target and calldata, because the live maker did not do
it and the book did not change) is reported with `repeat: true` and metered once: live would have sent it once.

**Monad specifics.**

- Monad bills the gas **limit**. Limit = ceil(estimate × 1.08) for the maker and × 1.10 for the operator; the
  Worker refuses multipliers outside 1.05–1.10.
- `eth_getLogs` ≤ 100 blocks.
- "Now" is max(wall clock, latest block timestamp), because block timestamps have 1 s resolution and the vault
  enforces `closeTime` on them.
- The nonce tracker covers the RPC's lagging `pending` count. That lag is what made the API's go-live drip reuse
  a nonce.

## MON budget (2026-10-09)

Testnet MON is the bottleneck: on Oct 9 (Taipei) the maker spent 8.28 MON (quotes 7.03, roll 1.25), and the holdings
must last until Nov 3, about 2–2.5 MON a day. Three meters per role and Taipei day (`packages/maker/src/budget.ts`):

| Meter | What | Limit (`config/worker.json`) | Over the limit |
|---|---|---|---|
| `<role>` (quoting) | quotes, re-quotes, replenishing | `dailyCapMon.maker` **1.2** MON, tiers below | refused |
| `<role>:roll` | the next day's ladder and its opening quotes | `rollCapMon`: maker 0.8, operator 0.5, market creator 0.8 | refused (retried every 5 min) |
| `<role>:reserve` | pulls, the close-time kill switch, the YES-margin withdraw, orphan cancels, the stale void | `reserveMon` (maker 0.5) is an **alert line** only | **never refused**; flagged `overBudget`, alert `RESERVE METER OVER <role>` once a day |

Quoting tiers (`budget.softRatio` 0.6, `budget.softWidenMult` 2):
- **normal** below 0.72 MON;
- **soft** from 60 % of the cap: spreads ×2, only urgent strikes are re-quoted (a refill waits), new quotes on an empty
  strike still go out;
- **hard** at the cap: no new quotes and no re-quotes; an urgent strike is pulled (reserve meter). It resets at Taipei
  midnight.

Until 2026-10-09 pulls shared the quoting meter and were refused past cap + reserve, so a spent day could leave a
crossed quote on the book. The roll picks **at most 4 strikes nearest the Polymarket median** and skips any whose
implied P(≥k) is outside [0.05, 0.95] (`roll.strikePolicy` mode `nearest`). The Mac's Node runner gets the lazy policy
and the reserve meter from the shared core at its next `deploy-runtime.sh`; its caps (and so its tiers, which need
`budget.softRatio`) stay in its own `config/local.json`.

**Evidence** (`evidence/lazy-replay-2026-10-09/`, `node replay.ts`): the repo's own `computeFairs`, `makeQuote`,
`decide` and `quotingTier`, tick by tick, on the Oct 8, Oct 9 and Oct 10 ladders, with the fair re-built from the
Polymarket minute history and the observed METAR max. On the Oct 9 ladder the replay of the settings live until now
gives 118 full re-quotes against 122 actually sent on chain.

| per 24 h, all three ladders (57.9 h) | full re-quotes | pulls | quoting + pulls MON | all-in MON/day* | worst \|resting mid − fair\| (Oct 9 day) |
|---|---|---|---|---|---|
| settings live until now (requoteTicks 3 + hysteresis) | 88 | 12 | 5.58 + 0.32 | ~7.3 | 0.025 |
| lazy rules alone (0.04 / 2 h / 0.02) | 64 | 12 | 4.17 + 0.32 | ~5.9 | 0.041 |
| **lazy + tiers, cap 1.2 (the new default)** | **16** | **9** | **1.18 + 0.24** | **~2.8** | 0.123 (soft tier, ×2 spread) |
| lazy + tiers, cap 1.0 | 14 | 8 | 1.03 + 0.22 | ~2.6 | 0.124 |
| lazy + tiers, cap 1.5 | 19 | 10 | 1.42 + 0.26 | ~3.0 | 0.124 |

\* plus one 4-strike roll (1.26 MON measured at go-live, opening quotes included) and the kill switch (~0.10).
Most re-quotes on these days were urgent: the fair moved through a resting price, i.e. by about the 0.03 half-spread
within a minute or two. The re-quote rules alone cannot reach the target; the quoting budget does, at the cost of
wider and fewer quotes once 60 % of it is spent. `dailyCapMon.maker` is the one knob (config or `CONFIG_OVERRIDES`).

## RPC

`RPC_URLS` (comma list, default Ankr, thirdweb, then the official RPC; `RPC_URL` is a one-URL alias, used only when
`RPC_URLS` is unset; the API Worker is the other way round, its `RPC_URL` wins), each in the allowlist `LIVE_RPCS` in
`src/env.ts` or a loopback fork (never mixed). `src/rpc.ts`:
- every endpoint must answer `eth_chainId` 10143 before it is used (at startup, or lazily if it was down); one that
  answers another chain is excluded and alerted (`RPC ENDPOINT EXCLUDED`); none → the tick refuses to run;
- a token bucket per endpoint (`RPC_RPS`, 8 requests/s): the maker never bursts past a provider's per-IP limit;
- rate-limit and server errors (HTTP 408/429/5xx, JSON-RPC −32005/−32007, "limited to", "too many requests") are
  retried on the same endpoint with exponential backoff (`RPC_RETRIES` 2: 250 ms, 500 ms, + jitter), then the endpoint
  cools down (`RPC_COOLDOWN_SEC` 30) and reads go on to the next one, through viem's `fallback` with no ranking;
- a revert or another real answer is never retried or sent elsewhere;
- writes start at the first healthy endpoint and move on only past a rate-limit refusal (not processed); a timeout or
  5xx is never replayed on another endpoint.
`status.rpc.endpoints` shows each endpoint's verification, cool-down and counters (no URLs with credentials exist).

## Treasury top-up

`src/treasury.ts`, configured in `config/worker.json` `treasury` (addresses are public; nothing is hard-coded).
Funding flows deployer → treasury (by hand) → roles (here). Every 10 minutes:

| Role | Address | min / target / daily cap (MON) |
|---|---|---|
| maker | `0xd572638F07829D1c3636400FB73CF34Ca6c7448a` | 1.5 / 4 / 4 |
| operator (also market creator) | `0x602dbf3937558B1d18d76315635fD5410089bd51` | 1.2 / 2.5 / 1.5 |
| relayer | `0xb0b9F5E93C4D4Bb448eC96191393bf35C9E8429f` | 3 / 8 / 3 |
| attester | `0x63D2523dDC4BB055A19682Bf2d61fe94959D0Bb9` | 0.3 / 0.8 / 0.5 |
| guardian | `0x30C8E371719Ff00577284dd9c10587Fa89357d50` | 0.05 / 0.15 / 0.2 |

- A role below its minimum gets `target − balance`, capped by its daily cap, the global daily cap (6 MON) and the
  treasury floor (2 MON stay), as a plain transfer with gas limit 21,000 (0.0021 MON at 102 gwei) through the nonce
  tracker. Transfers of one pass are ≥ 5 blocks apart (Monad's reserve-balance rule for accounts under 10 MON). The
  daily meters are written before the broadcast, so a lost receipt can never cause a second top-up beyond the caps,
  and a top-up whose receipt is not confirmed ends that pass's sending (the floor holds; the next pass re-reads the
  balances).
- **LIVE mode only.** Shadow records the intent. The secret `TREASURY_KEY` (address
  `0x655dE7F5E6EdB42f26C422ED056F94BA9964BEed`) must match `treasury.address`, may not be the owner/deployer key or any
  role or maker key, and the live treasury key is refused on a fork. A recipient with code is refused.
- **Alerts:** every top-up (`TOPUP <ROLE>`), `TREASURY LOW` below 10 MON, `<ROLE> LOW` when a role is below its
  minimum and cannot be topped up (no key, shadow, a cap, the floor, a failed send); LOW alerts repeat at most hourly.
  **Without any `TREASURY_KEY` the balance checks and the LOW alerts still run.**
- `node scripts/control.mjs treasury` prints balances against min/target and today's top-ups; `status` has the
  `treasury` section.

## Settlement guardrails

Settlement itself is not run here: the CRE workflow settles through the official CRE CLI
(`packages/cre-workflow`, docs/OPERATIONS.md §6) until the DON cutover. The Worker makes a missed settlement
visible within hours and bounded at 48 h, with no new key: it reads the Resolver and, at most, pays gas for a
permissionless call.

| When (chain time, per vault ladder with no result) | What the watcher does |
|---|---|
| > `Resolver.dayEnd` + `SETTLE_OVERDUE_SEC` (3 h). For Taipei that is 19:00 UTC, about an hour after the first settlement attempt at 18:05; the backstop scan runs every 10 min, so the alert lands by about 19:12 | Alert `SETTLEMENT OVERDUE <ICAO>:<date>`, repeated at most every `SETTLE_OVERDUE_REPEAT_SEC` (1 h) per ladder. The body gives the hours late, the stage (the workflow's own VOID deadlines are day end + 36 h and + 46 h), what to check (the settlement job's evidence record and `cre whoami`, attester MON) and when a stale void becomes possible. From then on the ladder is re-read every pass. |
| A result lands | Alert `OVERDUE CLEARED <ICAO>:<date>` once; nothing more for that ladder. |
| ≥ `Resolver.staleAt` (day end + 48 h, read from the contract; later after an unpause) and the Resolver is **not** paused | `eth_call` simulation of `voidIfStale`, then gas = estimate × 1.10 (the operator multiplier; the Worker refuses anything outside 1.05–1.10 because Monad bills the limit). **Live mode only** (and `AUTO_STALE_VOID` on): sent from `OPERATOR_KEY` through the nonce tracker, then confirmed on chain (`resultOf` Void with `sourcesHash` 0). Alert `STALE VOIDED` or `STALE VOID FAILED`. Shadow records an intent and alerts `STALE VOID DUE … (shadow: not sent)`. |
| Same, but the Resolver is paused | Never voided here: `STALE VOID HELD` (an owner decision). While paused the contract itself blocks stale voids until day end + 7 d. |

Bounds: at most one void attempt per ladder per hour whatever the outcome, a void meter of 0.05 MON per Taipei day
(one void measured on the fork: 76,537 gas, limit 84,191, about 0.0086 MON at 102 gwei), a balance check, and the
live operator key is refused on a fork. A void pays every token 0.5 AUSD; it only fires after the workflow has
missed its own 36 h and 46 h deadlines. The tx is logged in `txs:live` and metered on the operator's reserve meter
(never refused by a budget; the void meter above is its own bound). `status` shows
`watcher.overdue` and `watcher.staleVoids`. `AUTO_STALE_VOID = "0"` keeps the alerts and turns the void into a
"call it by hand" alert.

### Alert push (optional)

Without `ALERT_WEBHOOK_URL`, alerts stay in the Durable Object and the KV outbox (`scripts/control.mjs alerts`).
With it, every alert is also POSTed there:

| URL | Request |
|---|---|
| `https://ntfy.sh/<topic>` (or another `*.ntfy.sh` host) | plain-text body, the title in the `Title` header |
| `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>` | JSON `{chat_id, text}` |
| any other `https://` URL | JSON `{title, body, text}` |

- Only the alert's title and body are sent. They carry public chain data only: station-dates, tx hashes, addresses,
  recomputed METAR figures.
- At most one push per title per `ALERT_PUSH_MIN_SEC` (1 h, with 5 % slack so the hourly overdue repeat is never
  skipped for tick jitter) and 5 per tick. Each POST has a 5 s timeout and runs
  in parallel with the others. A failure is logged in `alerts:push` and never breaks a tick.
- The URL is never logged or put in the KV outbox. A malformed one (not https, or a Telegram URL without
  `chat_id`) is ignored, and `status` says so without echoing it.
- The owner sets it, and only there. Write the URL to `~/.config/isotherm/alert-webhook.url` (chmod 600), then
  run `node scripts/put-secrets.mjs --only ALERT_WEBHOOK_URL --live`. The script pipes it on stdin.
  `status.push.channel` shows `ntfy`, `telegram` or `json` from the next tick, and
  `node scripts/control.mjs test-alert` sends one `TEST ALERT` through it. To remove it, run
  `npx wrangler secret delete ALERT_WEBHOOK_URL --name isotherm-maker`.
- An ntfy topic name works like a password: choose a long random one.
- **Shared IPs.** ntfy.sh limits anonymous publishers per IP, and Workers share egress IPs: it answered the Worker with
  HTTP 429 on 2026-10-09. An account's access token (`tk_...`) can be given as the optional secret
  `ALERT_WEBHOOK_TOKEN` (sent as `Authorization: Bearer`; ntfy and JSON hooks), or inside the URL with ntfy's own query
  parameter `?auth=` (the Authorization header value `Bearer tk_...`, base64 without the trailing `=`; docs.ntfy.sh,
  "Publishing", "Query param"), which the URL handling keeps as is. `status.push.auth` says which one is in use, never
  the value. Caveat from the ntfy server code: a publisher is keyed by its account instead of its IP only when the
  account has a **tier** (a paid ntfy.sh plan, which also gives reserved topics); a free account's token alone does not
  lift the per-IP limit. A Telegram bot is the free alternative that is not limited by the caller's IP.

## Files

| Path | What |
|---|---|
| `src/index.ts` | cron → `/kick`, `fetch()` → 404 |
| `src/maker-do.ts` | the Durable Object: alarm loop, `/kick`, internal `/tick` `/status` `/log` |
| `src/engine.ts` | the tick: control, mode, interlock, kill, roll, reconcile, quote, watcher, snapshot, outbox, schedule |
| `src/watcher.ts` | settlement watcher (port of `packages/cre-workflow/settle/ops/challenge-watch.ts`) and the settlement guardrails (overdue alert, automatic stale void) |
| `src/alert-push.ts` | the optional `ALERT_WEBHOOK_URL` push (ntfy, Telegram, JSON; optional `ALERT_WEBHOOK_TOKEN`; rate limit, 5 s timeout) |
| `src/rpc.ts` | `RPC_URLS`: per-endpoint chain-id check, token bucket, retry with backoff, ordered fallback, write endpoint |
| `src/treasury.ts` | the treasury top-up of the role keys (`TREASURY_KEY`, `config/worker.json` `treasury`) |
| `src/reconcile.ts` | order-id reconciliation against the books |
| `src/nonces.ts` | per-key nonce tracker |
| `src/market-data.ts`, `src/fetcher.ts` | live Polymarket / METAR / Open-Meteo through the forecast cores; HTTP cache in the DO |
| `src/config.ts`, `config/worker.json` | the Mac's `config/default.json` + the Worker overlay (quoting budget and tiers, split roll budget, 4-strike roll, treasury) |
| `src/store.ts` | SQL-backed key/value + bounded logs + HTTP cache (MemStore for tests) |
| `scripts/deploy.mjs` | deploy with the KV id substituted, refusing any public hostname and any live `MAKER_MODE` without `--live` |
| `scripts/put-secrets.mjs` | `wrangler secret put` from stdin for the 4 secrets and the optional `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_TOKEN` and `TREASURY_KEY` (`--live` once `MAKER_MODE` is live) |
| `scripts/control.mjs` | operator console over the control KV |
| `scripts/shadow-compare.mjs` | cutover review: shadow vs the live maker tick by tick (`control.mjs compare`) |
| `scripts/import-budget.mjs` | cutover: the Mac's `state.json` → the Worker's live state (today's MON re-booked onto the split meters from `txs.jsonl`) |

## Commands

```bash
npm ci
npm run typecheck
npm test                     # unit: the Durable Object logic against a fake chain, the guardrails, the push, the cutover scripts,
                             # the lazy policy / tiers / reserve meter, the RPC transport, the treasury (73 tests)
npm run test:fork            # anvil fork (ports 19800-19802, 19804) + the bundled Worker in Miniflare, LIVE on the fork only
MW_LIVE_SMOKE=1 npx vitest run test/integration/live-readonly.smoke.test.ts   # read-only: live RPC + live data, watch-only shadow, no keys
MW_REHEARSAL=1 npx vitest run test/integration/cutover-rehearsal.fork.test.ts  # the cutover on a fork: the Mac's REAL state.json and ladder (ports 19810-19812)
npm run build                # the bundle wrangler would upload (one viem copy, about 235 KiB gzip)

# deploy (Workers Paid; same Cloudflare account as isotherm-api; set XDG_CONFIG_HOME to your wrangler config dir if you use several)
npx wrangler kv namespace create MAKER_KV      # once; store the id in ~/.config/isotherm/maker-kv-namespace-id (chmod 600)
npm run deploy                                 # MAKER_MODE stays "shadow"
node scripts/put-secrets.mjs                   # MAKER_KEY, OPERATOR_KEY, GUARDIAN_KEY, SNAPSHOT_TOKEN (+ ALERT_WEBHOOK_URL,
                                               # ALERT_WEBHOOK_TOKEN, TREASURY_KEY if their files exist), from the local key
                                               # directory (stdin only); add --live once MAKER_MODE is "live"
node scripts/control.mjs status | summary | tick | ticks 30 | compare | alerts | result | test-alert | treasury
```

The KV namespace id, the account and every key stay out of the repo: `wrangler.toml` carries the placeholder
`<MAKER_KV_NAMESPACE_ID>`, and `scripts/deploy.mjs` substitutes the real id into a temporary file that it deletes
afterwards.

## Evidence

- `evidence/fork-*`: the bundled Worker in workerd **sent real transactions to an anvil fork** of live testnet.
  Throwaway keys; roles were granted by impersonating the owner on the fork only. The run covers:
  - shadow (0 txs);
  - the interlock;
  - the full roll (28 txs: createLadder, mint, 4 Kuru markets, canonical in the Zap, margin, opening quotes);
  - a re-quote on a Polymarket move;
  - a refill after a taker fill;
  - pulls on an observed max;
  - the kill switch (all books empty, YES margin withdrawn);
  - a wrong attested settlement challenged to Void, and a correct one a MATCH;
  - from `fork-2026-10-09T14-11-36`: the settlement guardrails. At day end + 3h01 with no result,
    `SETTLEMENT OVERDUE` is raised and pushed to a stand-in webhook, with 0 txs. At `Resolver.staleAt` (+ 48 h),
    the Worker sends `voidIfStale` from the operator secret and the fork accepts it (Void, `sourcesHash` 0,
    `LadderResolved`; 76,537 gas used of an 84,191 limit). The next pass reads it as `STALE-VOID`, with 0 txs.

  - from `fork-2026-10-09T16-30-15` (final code: `fork-2026-10-09T17-28-38`): the MON saving. At the hard quoting cap an urgent strike is pulled (sent,
    reserve meter) and not re-quoted; the treasury tops up a maker at 1 MON to 4 MON from a throwaway treasury key
    (21,000-gas transfer); with a rate-limited stand-in RPC (HTTP 429) first in `RPC_URLS`, every tick completes.

  `txs.tsv` lists every tx.
- `evidence/live-readonly-*`: the same bundle in workerd against the live RPC and live data (from
  `live-readonly-2026-10-09T16-33-37`, final code `live-readonly-2026-10-09T17-34-24`: the production `RPC_URLS`, all three endpoints chain 10143, 0 errors; the treasury
  pass reads the role balances without a key).
  - Watch-only, so no keys are involved.
  - Its fair values, v0 guard flags and decisions match the live Mac maker's published snapshot.
- `evidence/rehearsal-*`: the cutover runbook on an anvil fork with the Mac's **real** `state.json` and the real
  RCSS ladder it was quoting (throwaway keys; the Mac's own orders stay untouched on the fork):
  - import + arm while "the Mac" still publishes: the interlock holds (shadow, 0 txs);
  - the Mac stops: the first live tick quotes the real books and posts the snapshot through the binding;
  - chain warped to the next 12:00 Taipei: tomorrow's ladder is rolled live from the real Polymarket ladder
    (createLadder, 5 mints, 5 Kuru markets, canonical, margin, opening quotes);
  - warped to 17:18:35: the kill switch empties today's books and withdraws the YES margin; tomorrow keeps quoting;
    the verify pass 5 min later finds nothing;
  - rollback: `pull all`, `disarm`, 0 txs after.
- `evidence/shadow-compare-2026-10-08/`: the deployed shadow vs the live Mac maker, tick by tick (see
  `docs/OPERATIONS.md` section 8.6), with the recorder and the comparison script.
- `evidence/lazy-replay-2026-10-09/`: the MON-saving replay ("MON budget" above): `prepare.ts` fetches the Polymarket
  minute history, the METARs and the maker's own order events on the 13 books (public RPC, no keys); `replay.ts`
  runs the shared policy on them; `results.txt`.
- `evidence/one-side-gas-2026-10-09/`: the one-side Kuru update measured on an anvil fork (the live maker address
  impersonated on the fork only) and cross-checked with read-only gas estimates on live testnet: a full re-quote
  522k gas, one side 319–345k (61–66 %), a refill without cancel 287k (55 %), a pull 252k.

## Not done / limits

- **CRE settlement stays on the Mac** (a kit to move it to a small Linux VPS is prepared, not deployed:
  docs/SETTLEMENT-VPS.md). The official CRE CLI cannot run in a Worker. The attester key is not in Cloudflare. The guardrails above bound what a Mac outage can cost. A missed settlement is alerted after 3 h,
  and at 48 h the ladder is voided at 0.5/0.5 instead of waiting for a third party. They cannot settle a ladder at
  its real temperature.
- **No automatic redeem** after settlement (same as the Mac).
- **Shadow-only artifacts.** Adopting a ladder the live maker rolled reports its margin top-up as a would-send (live
  with imported state has it done), and the quotes of that tick are metered as roll. The shadow mirrors the live
  maker's `lastQuote` time from its snapshot, but its fair only from when the shadow first saw the orders.
- **The v0 guard is refreshed hourly at the Worker's own minute.** Near a guard threshold the shadow and the Mac
  can disagree on `guard-wide` for up to an hour (timing, not logic; section 8.6 of the operations doc).
- **Ticks are I/O-bound.** About 3–20 s per warm tick on the public RPC (sequential reads; 4–8 s typical on 2026-10-08); the first tick of an
  isolate fetches about 1.3 MB of Open-Meteo history for the v0 guard (cached in the DO afterwards).
