# packages/forecast: RESULT (2026-10-07)

**Verdict: done.** This package gives the maker everything it prices from:
- the live Polymarket-implied ladder;
- the observed max so far;
- the v0 guardrail;
- the validated settlement core, unchanged;
- a data-driven close time.

It has zero runtime dependencies (Node ≥ 22.18 runs the `.ts` files directly). Other packages import it by relative path.

Tests: `npm test` gives **26/26 pass**. Strict `tsc` is clean; it runs through `packages/maker`'s tsconfig, which includes this package.

## What is here

| File | What it does | Evidence |
|---|---|---|
| `src/polymarket.ts` | **Live Polymarket-implied P(Tmax ≥ k).** Gamma gives the event structure, slug and URL. One batched `POST clob.polymarket.com/prices` returns the live best bid and ask for every bucket. Gamma's bid/ask is the fallback (it lagged the book: on 10-07 Gamma showed 0.005/0.011 on "34 °C or higher" while the CLOB showed 0.001/0.004). Price per bucket: mid if spread ≤ 0.10; else last trade if it sits inside the book (else the wide mid); half the ask if there are no bids; then outcome price. Every wide or one-sided bucket is flagged `illiquid`. The bucket prices are normalised to sum to 1 (`sumRaw` is kept). P(≥k) is the sum of buckets with lower bound ≥ k, for every k the grid determines. "X or below" and "X or higher" are handled. Off-grid strikes get a bounded normal-fit extrapolation, flagged `determined:false`. **`ok=false`** when the grid has a gap, the sum is outside 0.85–1.25, the unit is not °C, the event is closed, or Polymarket settles on another station (Taipei used CWA and RCTP before 04-05). `pickStrikes()` picks the 4–6 consecutive strikes with the most uncertainty around the median, then trims edges outside [0.03, 0.97]. | `test/polymarket.test.ts` (7 tests on 2 captured live events). Live run: `node scripts/ladder.ts RCSS 2026-10-08` → `results/live_RCSS_2026-10-08.json` |
| `src/obs.ts` | `observedMaxSoFar(icao, date)`: running max of the local day from aviationweather (fresh) ∪ IEM (lags 1–2 h). It never throws and keeps per-source errors. It also keeps the spike's bulk IEM and Ogimet fetchers, with the same URLs, so the spike's 72 MB cache seeds ours. | 10-07 12:56 Taipei: `observed max so far: 28°C (20 reports, last 12:30)` (RCSS METAR 070430Z `28/20`) |
| `src/v0.ts` | v0 ensemble-of-models ladder (frozen config from the spike backtest), live, cached hourly. **Guardrail and fallback only.** | 10-08 RCSS: μ 29.84 °C. Polymarket 0.470 vs v0 0.608 on ≥30 |
| `src/fair.ts` | Fair per strike = Polymarket P(≥k), conditioned on the observed max m: P(≥k \| ≥m) = P(≥k)/P(≥m). k ≤ m means YES is **certain**. The guard is v0 (truncated at m on day D) or, on day D after 11:00, the 2-year intraday increment table. Divergence above 0.15 sets `guard-wide`; above 0.40 sets `guard-pull`. A stale (>20 min), degraded or missing Polymarket ladder, or a strike off its grid, falls back to the guard, flagged. With no data the source is `none`. | `test/fair.test.ts` (5 tests) |
| `src/settle-core.ts` | **The validated settlement core, byte-identical** to `spikes/weather/src/settle-core.ts` (sha256 `119832de…3d62`; a test enforces it). Includes the golden fixtures (10-05 settle, 05-04 2-of-3 fallback, 2025-11-15 refusal). `settlement.ts` is the Node runner. | `test/settle-core.test.ts` (8 + identity). `node scripts/settle.ts RCSS 2026-10-05 2026-10-06` → SETTLED 29 and SETTLED 25 (IEM = AWC) |
| `src/closetime.ts`, `src/close-config.ts`, `scripts/close-time.ts` | Close-time analysis and the per-date close used by the roll (below) | `test/closetime.test.ts` (5). `results/close_time.json` |

## Close time (the vault's closeTime and the maker's kill switch)

Method: 2 years of METAR+SPECI (including :30 reports), local days 2024-10-01..2026-09-30, complete days only (≥20 local hours and a report at or after 23:00). `tFirst` is the first local time a day's integer max is reached. After local time C the settlement value can still change iff `tFirst ≥ C`. RCSS's IEM outage (157 days) is filled from Ogimet (IEM vs Ogimet agreed 272/272).

Command: `node scripts/close-time.ts` → `results/close_time.json`. The data comes from the spike's HTTP cache, so 0 new requests were made.

| | RCSS Taipei (726/730 days) | RJTT Tokyo (730/730 days) |
|---|---|---|
| max first reached by: 50% / 90% / 95% / 99% / 99.5% | 12:00 / 14:00 / **15:00** / **17:30** / 22:00 | 13:00 / 15:30 / **17:00** / **21:30** / 23:30 |
| warm season May–Oct (368 days): 95% / 99% | 15:00 / **17:30** | 16:00 / **19:30** |
| cool season Nov–Apr: 95% / 99% | 15:30 / **18:00** | 17:30 / **23:30** |

P(the max still rises after local time T), RCSS (RJTT):

| T | 12:00 | 13:00 | 14:00 | 15:00 | 16:00 | 17:00 | 18:00 | 20:00 | 22:00 |
|---|---|---|---|---|---|---|---|---|---|
| any rise | 43.8% (67.1%) | 21.8% (47.4%) | 9.6% (28.6%) | 4.7% (13.6%) | 1.8% (6.2%) | 1.1% (4.0%) | 0.7% (3.0%) | 0.5% (1.6%) | 0.4% (0.8%) |
| rise ≥ 2 °C | 15.0% | 5.7% | 2.1% | 0.7% | 0.3% | 0.3% | 0.1% | 0.0% | 0.0% |

**Recommendation (implemented in `closeFor()`; the roll uses it):**
- vault `closeTime` = the season's t99, rounded to the half hour;
- the maker stops quoting 10 min earlier.

| | close | maker stops |
|---|---|---|
| Taipei, May–Oct | **17:30 local** | **17:20** |
| Taipei, Nov–Apr | 18:00 | 17:50 |
| Tokyo, May–Oct | 19:30 | 19:20 |
| Tokyo, Nov–Apr | 23:30 | 23:20 |

Honest caveats:
- After a 17:30 Taipei close, the max still rose on **7 of 726 days**: by 1 °C on six of them and by 2 °C on one.
- Two of those are October days: **2024-10-30 and 10-31, Typhoon Kong-rey**, with the max at 23:30.
- Monthly t99s are noisy (one day ≈ 1.6% of a month), so the seasonal value is used.
- Tokyo's cool-season t99 is late (night-time warm advection). That is a product choice for whoever opens Tokyo.

## Interfaces

- `livePolymarketLadder(icao, "YYYY-MM-DD") → LiveLadder | null` returns `{url, slug, volume, sumRaw, quoteSource, buckets[], ladder{k:p}, strikes[], median, mean, sd, ok, warnings}`.
- `observedMaxSoFar(icao, date, nowMs) → {tmaxC, nObs, lastLocal, atLocal, dayStarted, dayOver, sources[]}`
- `v0Ladder(icao, date) → {mu, lead, ladder{k:p}, residSd}`
- `computeFairs({strikes, pm, obs, v0, intraday, ...}) → StrikeFair[]`
- `closeFor(icao, date) → {closeLocal, stopQuotingLocal, closeUtcMs, stopUtcMs, massLeftAtClose, basis}`
- CRE workflow: port `src/settle-core.ts` **unchanged**. Its URLs, parsers and `decide()` are pure (no imports).

## Not done / limits

- Polymarket prices are top-of-book only (no depth weighting).
- v0 has no intraday model beyond truncation and the climatological increment table. It stays a guardrail, and **never claims edge**: Brier 0.0656 vs Polymarket 0.0594.
- ZGSZ and RKSI are listed but **not validated** against Polymarket. The maker refuses to roll them without `--force`.

## Human actions

None for this package: every source is keyless. For commercial use, Open-Meteo needs a paid plan.
