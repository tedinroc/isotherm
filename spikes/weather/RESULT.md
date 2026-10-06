# Isotherm weather spike: settlement fidelity, forecast engine v0, calibration

Run on 2026-10-06 (~13:20Z) from `spikes/weather/`. The code has zero npm dependencies; Node 22.22 runs the `.ts` files directly. Every number below comes from a command in this folder, and the data is cached so it can be re-run.

## Verdict

| Question | Answer |
|---|---|
| Can we settle on the same thing Polymarket resolves on, keylessly? | **Yes.** RCSS: **183/184** station-sourced days match. RJTT: **209/209**. |
| Do the keyless sources agree with each other? | **Yes, exactly.** IEM vs Ogimet: 272/272 (RCSS) and 218/218 (RJTT) complete days. IEM vs aviationweather: 19/19 per station. Every time-matched report has the same temperature (885 RCSS, 960 RJTT). |
| Is a single source safe? | **No.** IEM's RCSS archive had a 158-day hole (2025-09-17..2026-02-21). Use 2 primary sources plus a fallback. |
| Was the earlier "100/100 Taipei days" claim right? | **No, not as stated.** It sampled every 3rd day (34 dates). The full re-check gives 183/184. 19 more early events resolved on *other* stations and must not be counted. |
| Can we backtest the ensemble? | **No.** Open-Meteo keeps only ~3 days of ensemble history. The deterministic previous-runs archive (7 models, since Jan/Feb 2024) does support a real lead-1 and lead-2 backtest. |
| Does forecast v0 beat Polymarket? | **No.** Pooled Brier is 0.0656 for us vs 0.0594 for Polymarket at 23:00 the night before. The 95% CI of the difference excludes 0. It does beat climatology by a wide margin (0.187). No causal blend or stack beat Polymarket with confidence. |

**Implication for the maker:** quote around the Polymarket-implied ladder when a market exists. Use our model as a guardrail, and as the primary quote only before Polymarket lists (it lists about 2 days ahead) or where it has no market.

## 1. Settlement fidelity: our rule vs Polymarket's winning bucket

The rule (`src/settle-core.ts`):

```
Tmax(station, D) = the maximum integer °C from the METAR temperature group "TT/DD" (M = minus)
                   over all METAR and SPECI reports with obsTime in [D 00:00 local, D+1 00:00 local)
                   (fixed offset: RCSS UTC+8, RJTT UTC+9; neither observes DST)
```

Command: `node scripts/fidelity.ts`. Output: `results/fidelity_RCSS.json`, `results/fidelity_RJTT.json`, `results/fidelity_table.csv` (412 rows, one per event, including the Ogimet value).

| Station | Events (resolved, 1 winner) | Station-sourced | **Local day, all reports** | On-cycle only (:00/:30) | Hourly only (:00) | UTC day |
|---|---|---|---|---|---|---|
| RCSS Taipei | 203 (2026-03-16..10-05) | 184 (from 04-05) | **183 / 184** | 180 / 184 | 155 / 184 | 171 / 184 |
| RJTT Tokyo | 209 (2026-03-10..10-05) | 209 | **209 / 209** | 209 / 209 | 182 / 209 | 185 / 209 |

What the table shows:
- **SPECIs must be included.** On 3 RCSS days only an off-cycle SPECI held the max (2026-04-21: 30, 04-22: 33, 07-13: 34), and Polymarket followed the SPECI each time.
- **The :30 half-hourly reports must be included.** On 28 days per station the :30 report alone held the max. Hourly-only scores 2/28 and 1/28 on those days.
- **The local day is required.** The UTC day fails 13 and 24 times.
- Caveat: IEM's `report_type=4` bucket also contains the routine :30 METARs, so it is *not* the real SPECI flag. We classify reports by observation minute instead (`src/obs.ts`).

**Taipei's settlement source changed.** Events 03-16..04-04 resolved on CWA station 46692 (central Taipei, 0.1 °C precision; 7 events) and on NOAA RCTP (Taoyuan; 12 events). They are excluded, since a different station was expected to differ (16/19 differ). From 04-05 onward Taipei resolves on Wunderground RCSS (183 events), plus NOAA `timeseries?site=rcss` once (08-24). Tokyo resolved on Wunderground RJTT until 08-23 and on NOAA `timeseries?site=rjtt` from 08-24. Our rule matches both regimes 100%.

**The one mismatch, 2026-05-04 RCSS** (Polymarket resolved "24°C"; $338K volume): the routine METAR `RCSS 040530Z 09013KT 040V110 9999 FEW015 SCT030 BKN100 25/18 Q1016` exists in both IEM and Ogimet (two independent archives, fetched with `curl` here). The official record says 25 °C, so this is a resolver-side miss, most likely a gap in Wunderground's table. **Claim for the pitch: "183 of 184 Taipei days (99.5%); on the remaining day three METAR archives agree Polymarket's resolver missed a report."**

## 2. Source agreement and outages

| Check | RCSS | RJTT | Command / file |
|---|---|---|---|
| aviationweather vs IEM, complete local days (last ~19) | 19/19 agree | 19/19 agree | `node scripts/sources.ts` → `results/source_agreement.json` |
| Time-matched reports with the same temperature | 885/885 | 960/960 | same |
| Ogimet vs IEM, days both complete | 272/272 | 218/218 | `node scripts/ogimet_check.ts` → `results/ogimet_check.json` |
| Ogimet vs Polymarket winners | 183/184 (same 05-04 miss) | 209/209 | same |
| IEM outage (complete in Ogimet, not in IEM) | **157 days**, 2025-09-17..2026-02-21 (about 1 report/day) | 0 | same |

- **AWC retention is short and uneven.** It served 2026-09-10 with 50 reports, returned an empty body for 09-05, and only 2 reports for 08-20. Treat it as a recent-days source only.
- **IEM lags AWC by about 1–2 h.** AWC had 4 newer RCSS reports that IEM didn't yet.

Settlement CLI, run here:

```
$ node scripts/settle.ts RCSS 2026-10-04 2026-10-05 2026-05-04 2025-11-15 2026-10-06
RCSS 2026-10-04 SETTLED tmaxC=35  iem=35(n=45,complete=true,last=23:30) awc=35(n=45,...)  [primary sources agree]
RCSS 2026-10-05 SETTLED tmaxC=29  iem=29(n=50,...) awc=29(n=50,...)  [primary sources agree]
RCSS 2026-05-04 SETTLED tmaxC=25  iem=25(n=54) awc=null(n=0) ogimet=25(n=54)  [2-of-3 fallback agree]
RCSS 2025-11-15 VOID tmaxC=null  iem=20(n=1,complete=false) awc=null(n=0) ogimet=26(n=42,complete=true)  [insufficient complete sources]
RCSS 2026-10-06 PENDING tmaxC=null  [local day not over]
```

2025-11-15 shows why the completeness rule is needed: IEM held one report saying 20 °C, while the true max was 26 °C.

Tests: `npm test` → **8/8 pass**. They are golden tests on real captured responses in `test/fixtures/`: the URLs, the parser edge cases (RVR, remarks, minus, `NIL`), the 10-05 settle, the 05-04 fallback, and the 11-15 refusal.

## 3. Polymarket prices → implied P(Tmax ≥ k)

`node scripts/prices.ts` reads the hourly YES-price history of every bucket from `clob.polymarket.com/prices-history?market=<yesToken>&startTs&endTs&fidelity=60`. That is ~4,300 calls, cached; resolved markets still return history. At each snapshot it takes the last print at or before the snapshot time. It then normalises the bucket prices to sum 1 (median raw sum is 1.04) and computes P(≥k) as the sum of buckets with lower bound ≥ k, for the strikes the bucket grid defines (~10 per day). Output: `data/pm_ladders_{RCSS,RJTT}.json`.

| Snapshot | RCSS available | RJTT available | RCSS mean P(winning bucket) | RCSS implied-mean MAE | RJTT implied-mean MAE |
|---|---|---|---|---|---|
| D-1 12:00 local | 179/184 | 202/209 | 0.236 | 1.15 °C | 0.88 °C |
| D-1 23:00 local | 182/184 | 205/209 | 0.264 | 1.03 °C | 0.81 °C |
| D 08:00 local | 183/184 | 208/209 | 0.276 | 0.93 °C | 0.76 °C |

Volume: the median Taipei event traded $68K, and the last 30 events $39K, which confirms the downtrend.

## 4. Forecast engine v0 (`src/forecast.ts`, `src/openmeteo.ts`)

What Open-Meteo actually provides (each probed here):
- **Previous-runs API.** `temperature_2m_previous_day{1,2}` is "the value predicted 24/48 h before valid time". There are 7 usable models at ≥90% coverage since Jan/Feb 2024: `ecmwf_ifs025, gfs_seamless, icon_seamless, jma_seamless, cma_grapes_global, meteofrance_seamless, gem_seamless`. UKMO, KMA and AIFS were too sparse.
- **Ensemble API.** Live works: 122 members (ECMWF 51, GEFS 31, ICON-EPS 40). But `past_days=92` has members only from the last ~3 days, `start_date` before 07-05 is rejected, and the `previous_day1` ensemble variables are all null. **So the ensemble cannot be backtested.**
- The single-runs API works for deterministic runs. `run=` on the ensemble API answers "requested model run is not available".

The method is strictly causal: forecasting day D uses only observations of days ≤ D-2.
1. **Bias.** Per-model rolling bias over 60 days.
2. **Mean.** Inverse-MSE-weighted mean of the bias-corrected model Tmax gives μ.
3. **Spread.** P(Y ≥ k) = mean over the last 90 out-of-sample residuals eᵢ of Φ((μ + s·eᵢ − (k − ½)) / 0.6). Here s scales the spread by today's inter-model spread relative to its recent average.
4. **Selection.** The config was chosen from 36 candidates by RPS on **2024-06-01..2026-03-09** (before any Polymarket market), then frozen.

Accuracy on the Polymarket days: μ MAE is 1.06 °C (RCSS, lead 1) and 0.90 °C (RJTT). The best raw single model has MAE 1.51 (Météo-France) for RCSS and 1.14 (ICON) for RJTT. The exact integer hits 34–36% of the time.

## 5. Calibration backtest (`node scripts/backtest.ts` → `results/backtest.json`)

The scoring set is 381 station-days (RCSS 179, RJTT 202) × each day's Polymarket strike grid, 3,800 strike-evaluations in all. Strikes within a day are correlated, so the effective sample is about 381 days. CIs use a paired day-block bootstrap (4,000 resamples, seed 42). Log loss clips at 0.01 for every forecaster.

| Forecaster (pooled) | Brier | Log loss |
|---|---|---|
| Polymarket D 08:00 (morning-of, for reference) | **0.0546** | 0.183 |
| Polymarket D-1 23:00 | 0.0594 | 0.198 |
| Polymarket D-1 12:00 | 0.0650 | 0.215 |
| **Isotherm v0, lead 1** (vs D-1 23:00) | 0.0656 | 0.216 |
| **Isotherm v0, lead 2** (vs D-1 12:00) | 0.0746 | 0.243 |
| 50/50 blend, lead 1 + PM 23:00 | 0.0606 | 0.201 |
| Climatology (trailing 30 days) | 0.1866 | 0.571 |

| Paired comparison, Brier (A − B; negative means A better) | RCSS | RJTT | Pooled |
|---|---|---|---|
| v0 lead 1 vs PM D-1 23:00 | +0.0048 [−0.0001, +0.0097] | +0.0075 [+0.0036, +0.0112] | **+0.0062 [+0.0030, +0.0092]** |
| v0 lead 2 vs PM D-1 12:00 ¹ | +0.0052 [−0.0013, +0.0117] | +0.0135 [+0.0092, +0.0178] | +0.0096 [+0.0055, +0.0133] |
| Blend vs PM D-1 23:00 | −0.0001 [−0.0025, +0.0023] | +0.0022 [+0.0003, +0.0040] | +0.0011 [−0.0004, +0.0026] |
| Causal logistic recalibration of PM 23:00 (60-day trailing fit) | −0.0003 [−0.0038, +0.0030] | +0.0013 [+0.0003, +0.0023] | n/a |
| Causal stack PM 23:00 + v0 lead 1 | −0.0001 [−0.0035, +0.0034] | +0.0031 [+0.0012, +0.0050] | n/a |

¹ Lead 2 is handicapped against the 12:00 snapshot: it uses runs about 12 h older than the market can see. The lead-1 vs 23:00 comparison is the fair one.

**Reliability, the honest nuance.** Polymarket Taipei is cold-biased in hindsight. Its 0.45 bin hit 0.60, its 0.35 bin hit 0.41, and its 0.24 bin hit 0.33. Our v0 is better calibrated (0.45→0.51, 0.75→0.77) but less sharp. A causal recalibration does not monetise the bias at this sample size, as the row above shows. Error autocorrelation at lag 1 is 0.16–0.30, so adding yesterday's error is worth ≤9% of error variance; that's a v1 item.

## 6. Live ladder, 2026-10-06 13:20Z (`node scripts/live.ts` → `results/live_latest.json`)

Taipei RCSS (today's observed max so far: 25 °C, matching Polymarket's 25 °C for 10-06):

| k | **Oct 7** model | ens (raw) | Polymarket | | **Oct 8** model | ens (raw) | Polymarket |
|---|---|---|---|---|---|---|---|
| 26 | 0.956 | 0.797 | 0.988 | | 0.992 | 0.980 | 0.977 |
| 27 | 0.851 | 0.640 | 0.883 | | 0.985 | 0.918 | 0.946 |
| 28 | 0.561 | 0.401 | 0.489 | | 0.965 | 0.800 | 0.895 |
| 29 | 0.206 | 0.123 | 0.127 | | 0.875 | 0.613 | 0.806 |
| 30 | 0.040 | 0.013 | 0.021 | | 0.631 | 0.292 | 0.500 |
| 31 | 0.007 | 0.000 | 0.006 | | 0.269 | 0.070 | 0.139 |
| 32 | 0.000 | 0.000 | 0.003 | | 0.051 | 0.006 | 0.067 |

- Oct 7: μ = 27.7 °C, Polymarket volume $5.4K so far. Oct 8: μ = 29.8 °C, volume $356.
- The raw 122-member ensemble is bias-shifted with the sibling deterministic model's bias but is otherwise uncalibrated, and it runs cooler.
- Tokyo (also in the JSON) shows a larger disagreement: Oct 7 P(≥24) is 0.56 for us vs 0.80 on Polymarket. Given section 5, the market is more likely right.

## 7. Exact HTTP for the CRE settlement workflow

All URLs are produced by `src/settle-core.ts`, which is pure (no imports, no Node APIs) and portable into a CRE TypeScript workflow. Example: RCSS, D = 2026-10-05, offset +480 min, so the local day is [2026-10-04T16:00Z, 2026-10-05T16:00Z).

1. **IEM (primary A)**
   - URL: `GET https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=RCSS&data=metar&year1=2026&month1=10&day1=5&year2=2026&month2=10&day2=6&tz=Asia/Taipei&format=onlycomma&latlon=no&elev=no&missing=M&trace=T&direct=no&report_type=3&report_type=4`
   - Response: CSV `station,valid,metar`, with `valid` in *local* time. IEM selects exactly the local day; the end is exclusive.
   - Measured: 5.3 KB, 1.3–3.7 s, 50 rows.
2. **aviationweather.gov (primary B)**
   - URL: `GET https://aviationweather.gov/api/data/metar?ids=RCSS&format=json&date=2026-10-05T16:00:00Z&hours=24`
   - Response: JSON array; use `obsTime` (unix s) and `rawOb`. **The window includes `date`**, so drop `obsTime*1000 >= end` (it returned 51 rows, 50 after the filter). An **empty body means no data**.
   - Do **not** use the JSON `temp` field, which can carry T-group tenths; parse the integer group from `rawOb`.
   - Measured: 26.6 KB (RCSS) or 22 KB (RJTT), 1.1–3.3 s.
3. **Ogimet (fallback C, only when A or B is incomplete)**
   - URL: `GET https://www.ogimet.com/cgi-bin/getmetar?icao=RCSS&begin=202610041600&end=202610051559` (UTC, inclusive end).
   - Response: lines `RCSS,YYYY,MM,DD,HH,mm,METAR|SPECI <raw>=`; skip `NIL`.
   - Measured: 5.9 KB, 1.7–7.1 s.
   - It is a free service that throttles, so don't let every DON node hit it on every run.

**Parsing.**
- Regex `\s(M?\d{2})\/(M?\d{2}|\/\/)?(?=\s)` on the text before ` RMK `; `M` means minus.
- Keep reports with start ≤ t < start + 24 h.
- Tmax = the max of those integers. No further rounding: METAR is already integer °C, and Wunderground and NOAA display that integer.

**Completeness.** At least 20 distinct local hours with a report, and the last report at or after 23:00 local.

**Decision.**
- A and B both complete and equal → SETTLED.
- A and B both complete but different → never settle (VOID after the deadline).
- Otherwise fetch C; if two or more complete sources agree → SETTLED.
- Otherwise PENDING, then VOID (refund at par) after D+1 local midnight + 36 h.

**Schedule.** Run the cron at D+1 02:00 local (RCSS 18:00Z, RJTT 17:00Z); IEM lags about 1–2 h. Retry hourly. AWC retention is short, so settle within days, not weeks.

**Consensus payload.** `{station, date, tmaxC, nObsA, nObsB, sourcesMask}`, a few bytes, far under CRE's 25 KB observation limit. HTTP use is 2–3 of the 15 calls allowed per run, and responses are ≤27 KB vs the 250 KB limit.

## 8. Not done / caveats

- No ensemble backtest (data not archived). The live ensemble ladder is shown only for reference. Start logging ensemble runs daily now if we want this later.
- Intraday conditioning (the observed max so far as a floor for day D) is not built. Polymarket at D 08:00 is much sharper (Brier 0.0546), so the maker must re-quote or pull on each METAR on day D.
- Polymarket `prices-history` points are hourly last prints, not a full order book; tail buckets can be stale. Normalisation hides small book inconsistencies.
- Licences:
  - Open-Meteo's free API is for non-commercial use (CC-BY 4.0 data); a commercial product needs their paid plan.
  - IEM, NOAA and AWC data are public.
  - Ogimet asks for gentle use.
- Nothing in this task touches the chain. The deployer holds 3.67 MON on testnet (`cast balance 0xb855…5c11` = 3670981182000000000 wei), below the 5 MON threshold, and nothing was sent.

## 9. Human actions

- **None required for this workstream.** Every source is keyless, and no account or login was used.
- Pitch and README copy must change from "100 out of 100 Taipei days" to **"183/184 (99.5%) Taipei, 209/209 Tokyo"**, with the 05-04 explanation.
- If Isotherm ever goes commercial, buy an Open-Meteo API plan.

## 10. Next steps

1. **CRE (spikes/cre).** Import `src/settle-core.ts` as is: 2 HTTP calls plus a conditional third, with median/identical aggregation of `tmaxC`. Golden fixtures are in `test/fixtures/`.
2. **Maker.** Set fair value = the Polymarket-implied ladder when the book exists. Use the v0 model as a sanity bound (flag a strike when |model − PM| > 0.15) and as the primary quote before Polymarket lists, which is about 2 days ahead.
3. **Engine v1.**
   - Intraday floor (observed max so far) for day D.
   - Lag-1 error term.
   - Seasonal/regression MOS.
   - Log the live ensemble daily so it can be calibrated later.
   - Re-run `npm run backtest` and keep the numbers honest.
4. **Daily ForecastCommit.** Hash `results/live_latest.json` ladders (μ and P(≥k) per strike) before the ladder opens.

## Files

- `src/` (library)
  - `settle-core.ts`: pure rule, URLs, parsers, decision; the CRE-portable piece.
  - `settlement.ts`: `tmaxC(station, localDate)` runner.
  - `obs.ts`: IEM / AWC / Ogimet bulk fetchers and daily maxima.
  - `polymarket.ts`: gamma events, bucket parsing, CLOB history, implied ladder.
  - `openmeteo.ts`: previous-runs, live deterministic, live ensemble.
  - `forecast.ts`: the engine.
  - `score.ts`: Brier, log loss, reliability, bootstrap, stacking.
  - `http.ts`: cached, polite fetch.
  - `stations.ts`
- `scripts/`: `fidelity`, `sources`, `ogimet_check`, `prices`, `backtest`, `live`, `settle` (`npm run recompute`), `report`. `npm run all` re-runs everything.
- `data/`: daily maxima (IEM and Ogimet) and Polymarket ladders. `data/cache/` holds the raw HTTP cache (72 MB, 4,408 responses) and is git-ignored by the repo's `cache/` rule.
- `results/`: `fidelity_*.json`, `fidelity_table.csv`, `source_agreement.json`, `ogimet_check.json`, `backtest.json`, `live_latest.json`, `summary.json`.
