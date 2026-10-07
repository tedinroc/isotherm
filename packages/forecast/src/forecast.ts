// Forecast engine v0: rolling per-model bias correction -> weighted multi-model mean (mu) ->
// out-of-sample residual "dressing" -> P(Tmax_int >= k). Tmax_int is the settlement integer (METAR max).
// Everything is strictly causal: forecasting date D only uses observations of days <= D - 2.
import { addDays } from "./stations.ts";

export interface Cfg {
  biasWindow: number; // days of history for per-model bias / weights
  weighting: "equal" | "invmse";
  dist: "empirical" | "gaussian";
  bandwidth: number; // kernel width (°C) for the empirical residual distribution
  residWindow: number; // days of out-of-sample residuals used for the spread
  spreadScale: boolean; // scale spread by today's inter-model spread vs its recent average
  minTrain: number;
}

export const DEFAULT_CFG: Cfg = {
  biasWindow: 60,
  weighting: "invmse",
  dist: "empirical",
  bandwidth: 0.5,
  residWindow: 90,
  spreadScale: false,
  minTrain: 20,
};

export const CUTOFF_LAG_DAYS = 2; // obs of D-2 is the newest complete day at any forecast time we use

export interface Point {
  date: string;
  mu: number;
  spread: number; // inter-model std of corrected forecasts
  nModels: number;
  corrected: Record<string, number>;
  bias: Record<string, number>;
  weight: Record<string, number>;
}

export type Obs = Map<string, number>; // date -> settlement Tmax (integer)
export type Fc = Map<string, Map<string, number>>; // model -> date -> forecast Tmax

export function Phi(x: number): number {
  // Abramowitz-Stegun 7.1.26 via erf; |err| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Point forecast for `date` from models' raw forecasts `today` (model -> Tmax) using history up to cutoff. */
export function pointForecast(date: string, today: Map<string, number>, obs: Obs, fc: Fc, cfg: Cfg): Point | null {
  const cutoff = addDays(date, -CUTOFF_LAG_DAYS);
  const corrected: Record<string, number> = {}, bias: Record<string, number> = {}, weight: Record<string, number> = {};
  for (const [m, f] of today) {
    const hist = fc.get(m);
    if (!hist || !Number.isFinite(f)) continue;
    const errs: number[] = [];
    for (let i = 0, d = cutoff; i < cfg.biasWindow * 2 && errs.length < cfg.biasWindow; i++, d = addDays(d, -1)) {
      const y = obs.get(d), x = hist.get(d);
      if (y !== undefined && x !== undefined) errs.push(x - y);
    }
    if (errs.length < cfg.minTrain) continue;
    const b = errs.reduce((s, e) => s + e, 0) / errs.length;
    const mse = errs.reduce((s, e) => s + (e - b) ** 2, 0) / errs.length;
    bias[m] = b;
    corrected[m] = f - b;
    weight[m] = cfg.weighting === "equal" ? 1 : 1 / Math.max(mse, 0.05);
  }
  const ms = Object.keys(corrected);
  if (ms.length < 2) return null;
  const W = ms.reduce((s, m) => s + weight[m], 0);
  const mu = ms.reduce((s, m) => s + weight[m] * corrected[m], 0) / W;
  const spread = Math.sqrt(ms.reduce((s, m) => s + (corrected[m] - mu) ** 2, 0) / ms.length);
  for (const m of ms) weight[m] /= W;
  return { date, mu, spread, nModels: ms.length, corrected, bias, weight };
}

export interface Dressing {
  resid: number[]; // out-of-sample residuals obs - mu (recent first)
  spreads: number[]; // the inter-model spreads on those days
}

/** P(Tmax_int >= k) for the integer outcome. Y >= k  <=>  continuous proxy >= k - 0.5. */
export function probGE(p: Point, dr: Dressing, k: number, cfg: Cfg): number {
  const n = dr.resid.length;
  if (n < 10) return NaN;
  let scale = 1;
  if (cfg.spreadScale) {
    const c = 0.25;
    const avg = dr.spreads.reduce((s, x) => s + x * x, 0) / dr.spreads.length;
    scale = Math.min(2, Math.max(0.6, Math.sqrt((p.spread ** 2 + c) / (avg + c))));
  }
  const thr = k - 0.5;
  if (cfg.dist === "gaussian") {
    const mean = dr.resid.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(dr.resid.reduce((s, x) => s + (x - mean) ** 2, 0) / n) * scale;
    return 1 - Phi((thr - (p.mu + mean)) / Math.max(sd, 0.3));
  }
  let acc = 0;
  for (const e of dr.resid) acc += 1 - Phi((thr - (p.mu + e * scale)) / cfg.bandwidth);
  return acc / n;
}

export function ladder(p: Point, dr: Dressing, ks: number[], cfg: Cfg): Record<number, number> {
  return Object.fromEntries(ks.map((k) => [k, probGE(p, dr, k, cfg)]));
}

/**
 * Walk forward over `dates` (ascending), producing causal forecasts. Residuals for the dressing of day D
 * come only from days <= D-2 whose own mu was itself produced causally.
 */
export function walkForward(dates: string[], obs: Obs, fc: Fc, cfg: Cfg) {
  const points = new Map<string, Point>();
  const out: { date: string; point: Point; dressing: Dressing }[] = [];
  for (const D of dates) {
    const today = new Map<string, number>();
    for (const [m, s] of fc) {
      const x = s.get(D);
      if (x !== undefined) today.set(m, x);
    }
    const p = pointForecast(D, today, obs, fc, cfg);
    if (!p) continue;
    points.set(D, p);
    const cutoff = addDays(D, -CUTOFF_LAG_DAYS);
    const resid: number[] = [], spreads: number[] = [];
    for (let i = 0, d = cutoff; i < cfg.residWindow * 2 && resid.length < cfg.residWindow; i++, d = addDays(d, -1)) {
      const q = points.get(d), y = obs.get(d);
      if (q && y !== undefined) {
        resid.push(y - q.mu);
        spreads.push(q.spread);
      }
    }
    out.push({ date: D, point: p, dressing: { resid, spreads } });
  }
  return out;
}
