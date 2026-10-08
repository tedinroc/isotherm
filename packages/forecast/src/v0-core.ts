// Live v0 model ladder (the GUARDRAIL / FALLBACK, not the quote source). Runtime-agnostic core: the HTTP GET and the
// seed daily maxima are injected (io), so the Node maker (v0.ts) and the Cloudflare Worker share one implementation.
// Backtest (spikes/weather): v0 lead-1 Brier 0.0656 vs Polymarket D-1 23:00 0.0594, 95% CI of the difference
// [+0.0030, +0.0092] -> Polymarket is better. We use v0 only to (a) flag a Polymarket ladder that is far from any
// sane forecast, and (b) quote, with wider spreads, when Polymarket has no market or its data is broken.
import type { TextGetter } from "./fetch-types.ts";
import { ladder, pointForecast, walkForward, type Cfg, type Obs as DailyObs } from "./forecast.ts";
import { dailyMaxima, iemObsWith } from "./obs-core.ts";
import { liveDetTmaxWith, previousRunsTmaxWith } from "./openmeteo-core.ts";
import { addDays, dateRange, localDateOf, station } from "./stations.ts";

/** Frozen config, selected on 2024-06-01..2026-03-09 by RPS (spikes/weather/results/backtest.json). */
export const V0_CFG: Cfg = { biasWindow: 60, weighting: "invmse", dist: "empirical", bandwidth: 0.6, residWindow: 90, spreadScale: true, minTrain: 20 };
export const HISTORY_FROM = "2024-01-01";

export interface V0Ladder {
  station: string;
  date: string;
  lead: number; // days ahead of the station's local today (0 = today)
  calibLead: 1 | 2;
  mu: number;
  modelSpread: number;
  nModels: number;
  residSd: number;
  nResid: number;
  ladder: Record<string, number>; // k -> P(Tmax >= k) for k in mu-8 .. mu+8
  fetchedAt: string;
  source: string;
}

/** I/O for the v0 ladder: a text GET (with TTL hints) and the seed daily maxima per station (null when absent). */
export interface V0Io {
  get: TextGetter;
  seedDaily(icao: string): { date: string; tmaxC: number | null; complete: boolean }[] | null;
}

/** Daily settlement maxima: seeded from io.seedDaily(icao) (data/daily_<ICAO>.json), refreshed with the last ~3 weeks
 *  from IEM through io.get. */
export async function dailyHistoryWith(io: V0Io, icao: string, nowMs = Date.now()): Promise<DailyObs> {
  const st = station(icao);
  const today = localDateOf(nowMs, st.utcOffsetMin);
  const obs: DailyObs = new Map();
  const seed = io.seedDaily(icao);
  if (seed) for (const d of seed) if (d.complete && d.tmaxC !== null && d.date < today) obs.set(d.date, d.tmaxC);
  try {
    const recent = await iemObsWith(io.get, icao, addDays(today, -21), addDays(today, 1));
    for (const [d, s] of dailyMaxima(st, recent)) if (s.complete && s.tmaxC !== null && d < today) obs.set(d, s.tmaxC);
  } catch {
    // stale history only widens the residual window slightly; keep going with the seed
  }
  return obs;
}

const memo = new Map<string, { at: number; v: V0Ladder }>();

/** v0 ladder for a station-local date. Cached in memory for `maxAgeSec`. */
export async function v0LadderWith(io: V0Io, icao: string, date: string, nowMs = Date.now(), maxAgeSec = 3600): Promise<V0Ladder | null> {
  const key = `${icao}:${date}`;
  const hit = memo.get(key);
  if (hit && (nowMs - hit.at) / 1000 < maxAgeSec) return hit.v;
  const st = station(icao);
  const today = localDateOf(nowMs, st.utcOffsetMin);
  const lead = Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
  if (lead < 0 || lead > 6) return null;
  const calibLead: 1 | 2 = lead >= 2 ? 2 : 1;
  const yesterday = addDays(today, -1);
  const obs = await dailyHistoryWith(io, icao, nowMs);
  const hist = await previousRunsTmaxWith(io.get, st, calibLead, HISTORY_FROM, yesterday);
  const det = await liveDetTmaxWith(io.get, st, Math.min(16, lead + 2));
  const todayF = new Map<string, number>();
  for (const [m, s] of det.tmax) if (s.get(date) !== undefined) todayF.set(m, s.get(date)!);
  const p = pointForecast(date, todayF, obs, hist, V0_CFG);
  if (!p) return null;
  const wf = walkForward(dateRange(HISTORY_FROM, yesterday), obs, hist, V0_CFG);
  const pts = new Map(wf.map((r) => [r.date, r.point]));
  const resid: number[] = [], spreads: number[] = [];
  for (let d = yesterday; resid.length < V0_CFG.residWindow && d > HISTORY_FROM; d = addDays(d, -1)) {
    const q = pts.get(d), y = obs.get(d);
    if (q && y !== undefined) (resid.push(y - q.mu), spreads.push(q.spread));
  }
  if (resid.length < 10) return null;
  const c = Math.round(p.mu);
  const ks = Array.from({ length: 17 }, (_, i) => c - 8 + i);
  const lad = ladder(p, { resid, spreads }, ks, V0_CFG);
  const v: V0Ladder = {
    station: icao,
    date,
    lead,
    calibLead,
    mu: +p.mu.toFixed(2),
    modelSpread: +p.spread.toFixed(2),
    nModels: p.nModels,
    residSd: +Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / resid.length).toFixed(2),
    nResid: resid.length,
    ladder: Object.fromEntries(ks.map((k) => [k, +lad[k].toFixed(4)])),
    fetchedAt: new Date(nowMs).toISOString(),
    source: det.url,
  };
  memo.set(key, { at: nowMs, v });
  return v;
}

/** P(>=k) from a v0 ladder; outside its range it is 1 (below) or 0 (above). */
export function v0At(v: Pick<V0Ladder, "ladder">, k: number): number {
  if (v.ladder[k] !== undefined) return v.ladder[k];
  const ks = Object.keys(v.ladder).map(Number);
  return k < Math.min(...ks) ? 1 : 0;
}
