# apps/maker-worker — the Isotherm market maker on Cloudflare

The same market maker that runs on the Mac under launchd (`packages/maker`), moved to a Cloudflare Worker so
that judging does not depend on one laptop staying awake. It quotes the Kuru v1 YES/AUSD books, rolls the next
day's ladder, runs the close-time kill switch and watches settlements. Monad **testnet** (10143) only.

**It starts in SHADOW mode and sends nothing.** Going live takes two separate switches. The cutover runbook
(docs/OPERATIONS.md §8) flips them after the shadow results have been reviewed.

## How it runs

```
cron "* * * * *" ──► Worker.scheduled ──► MakerDO /kick   (re-arms the alarm if it is missing or overdue)
                                             │
                     MakerDO.alarm() every TICK_SEC (sooner when a ladder's kill-switch time comes first)
                                             │
  control (KV) ─► mode ─► kill switch ─► roll ─► reconcile orders ─► quote ─► settlement watcher ─► snapshot ─► outbox (KV)
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
| Watcher | recomputes and alerts; a challenge is simulated and recorded | challenges a reproduced mismatch with `GUARDIAN_KEY` |

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
     (`lastQuoteAt` from its published snapshot), so it predicts the policy's "fair moved" and "quote older than
     6 h" re-quotes too.
   - Live adopts open orders it lost track of after a cutover or an interrupted tick, and cancels any extra ones.
6. **Quote** (`tickLadder`).
   - Fair = the Polymarket-implied P(Tmax ≥ k), conditioned on the observed METAR max.
   - The v0 / intraday guardrail widens or pulls.
   - Post-only, one bid and one ask per strike, re-quoted only when the policy says so.
7. **Watcher** (every `WATCH_EVERY_SEC`). This is the Mac's `challenge-watch.ts` logic.
   - Resolver events are read with `eth_getLogs` in pages of ≤ 100 blocks, plus a backstop over the newest 64
     ladders.
   - Each result is recomputed with the CRE workflow's own `sources.ts` and `settle-core.ts` `decide()`.
   - A reproduced mismatch inside the 900 s window is challenged, but only in live mode, only with a guardian key
     that matches `Resolver.guardian()`, and with gas = estimate × 1.1. The live guardian key is refused on a fork.
8. **Snapshot** (live only). Then the outbox is written to KV: `status`, `tick:last`, `ticks:recent` (the last 90
   ticks, one line per strike: `scripts/control.mjs ticks`), `shadow:summary`, `alerts`.

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

**Budgets.** The meters are per role and per Taipei day. The roll now has its **own** meter (`rollCapMon`: maker
0.8, operator 0.5, market creator 0.8). It is separate from quoting (`dailyCapMon`: maker 2.2). A day of re-quotes
can no longer block the next day's roll (the 2026-10-08 incident). The opening quotes of a new ladder count as
roll. The Mac's Node runner keeps its single shared meter: `rollCapMon` is only set in `config/worker.json`.

## Files

| Path | What |
|---|---|
| `src/index.ts` | cron → `/kick`, `fetch()` → 404 |
| `src/maker-do.ts` | the Durable Object: alarm loop, `/kick`, internal `/tick` `/status` `/log` |
| `src/engine.ts` | the tick: control, mode, interlock, kill, roll, reconcile, quote, watcher, snapshot, outbox, schedule |
| `src/watcher.ts` | settlement watcher (port of `packages/cre-workflow/settle/ops/challenge-watch.ts`) |
| `src/reconcile.ts` | order-id reconciliation against the books |
| `src/nonces.ts` | per-key nonce tracker |
| `src/market-data.ts`, `src/fetcher.ts` | live Polymarket / METAR / Open-Meteo through the forecast cores; HTTP cache in the DO |
| `src/config.ts`, `config/worker.json` | the Mac's `config/default.json` + the Worker overlay (split roll budget) |
| `src/store.ts` | SQL-backed key/value + bounded logs + HTTP cache (MemStore for tests) |
| `scripts/deploy.mjs` | deploy with the KV id substituted, refusing any public hostname and any live `MAKER_MODE` without `--live` |
| `scripts/put-secrets.mjs` | `wrangler secret put` from stdin for the 4 secrets |
| `scripts/control.mjs` | operator console over the control KV |
| `scripts/shadow-compare.mjs` | cutover review: shadow vs the live maker tick by tick (`control.mjs compare`) |
| `scripts/import-budget.mjs` | cutover: the Mac's `state.json` → the Worker's live state (today's MON re-booked onto the split meters from `txs.jsonl`) |

## Commands

```bash
npm ci
npm run typecheck
npm test                     # unit: the Durable Object logic against a fake chain, the cutover scripts (29 tests)
npm run test:fork            # anvil fork (ports 19800-19802) + the bundled Worker in Miniflare, LIVE on the fork only
MW_LIVE_SMOKE=1 npx vitest run test/integration/live-readonly.smoke.test.ts   # read-only: live RPC + live data, watch-only shadow, no keys
MW_REHEARSAL=1 npx vitest run test/integration/cutover-rehearsal.fork.test.ts  # the cutover on a fork: the Mac's REAL state.json and ladder (ports 19810-19812)
npm run build                # the bundle wrangler would upload (one viem copy, about 235 KiB gzip)

# deploy (Workers Paid; same Cloudflare account as isotherm-api; set XDG_CONFIG_HOME to your wrangler config dir if you use several)
npx wrangler kv namespace create MAKER_KV      # once; store the id in ~/.config/isotherm/maker-kv-namespace-id (chmod 600)
npm run deploy                                 # MAKER_MODE stays "shadow"
node scripts/put-secrets.mjs                   # MAKER_KEY, OPERATOR_KEY, GUARDIAN_KEY, SNAPSHOT_TOKEN from ~/.config/isotherm (stdin only)
node scripts/control.mjs status | summary | tick | ticks 30 | compare | alerts | result
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
  - a wrong attested settlement challenged to Void, and a correct one a MATCH.

  `txs.tsv` lists every tx.
- `evidence/live-readonly-*`: the same bundle in workerd against the live RPC and live data.
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

## Not done / limits

- **CRE settlement stays on the Mac.** The official CRE CLI cannot run in a Worker. The attester key is not in
  Cloudflare.
- **No automatic redeem** after settlement (same as the Mac).
- **Shadow-only artifacts.** Adopting a ladder the live maker rolled reports its margin top-up as a would-send (live
  with imported state has it done), and the quotes of that tick are metered as roll. The shadow mirrors the live
  maker's `lastQuote` time from its snapshot, but its fair only from when the shadow first saw the orders.
- **The v0 guard is refreshed hourly at the Worker's own minute.** Near a guard threshold the shadow and the Mac
  can disagree on `guard-wide` for up to an hour (timing, not logic; section 8.6 of the operations doc).
- **Ticks are I/O-bound.** About 3–20 s per warm tick on the public RPC (sequential reads; 4–8 s typical on 2026-10-08); the first tick of an
  isolate fetches about 1.3 MB of Open-Meteo history for the v0 guard (cached in the DO afterwards).
