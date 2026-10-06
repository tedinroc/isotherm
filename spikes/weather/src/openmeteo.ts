// Open-Meteo (keyless, free tier 10k calls/day): previous-runs archive (backtest) + live deterministic + live ensembles.
import { fetchJson } from "./http.ts";
import { addDays, localDateOf, type Station } from "./stations.ts";

// Deterministic models with >=90% previous-runs coverage at both stations since early 2024 (checked 2026-10-06).
export const DET_MODELS = [
  "ecmwf_ifs025",
  "gfs_seamless",
  "icon_seamless",
  "jma_seamless",
  "cma_grapes_global",
  "meteofrance_seamless",
  "gem_seamless",
] as const;
// Ensemble model -> deterministic sibling whose bias history we reuse (ensemble archive is only ~3 days deep).
export const ENS_MODELS: Record<string, string> = {
  ecmwf_ifs025: "ecmwf_ifs025",
  gfs025: "gfs_seamless",
  icon_seamless: "icon_seamless",
};
const ENS_SUFFIX: Record<string, string> = {
  ecmwf_ifs025: "ecmwf_ifs025_ensemble", // 51 members (control + 50)
  gfs025: "ncep_gefs025", // 31
  icon_seamless: "icon_seamless_eps", // 40
};

/** hourly series (UTC) -> local-day max per date, requiring >= minHours valid hours. */
export function dailyMaxFromHourly(times: string[], vals: (number | null)[], st: Station, minHours = 20): Map<string, number> {
  const acc = new Map<string, { mx: number; n: number }>();
  for (let i = 0; i < times.length; i++) {
    const v = vals[i];
    if (v === null || v === undefined) continue;
    const d = localDateOf(Date.parse(times[i] + "Z"), st.utcOffsetMin);
    const a = acc.get(d) ?? { mx: -Infinity, n: 0 };
    a.mx = Math.max(a.mx, v);
    a.n++;
    acc.set(d, a);
  }
  const out = new Map<string, number>();
  for (const [d, a] of acc) if (a.n >= minHours) out.set(d, a.mx);
  return out;
}

export type LeadTmax = Map<string, Map<string, number>>; // model -> date -> forecast Tmax

/**
 * Archived forecasts of local-day Tmax at lead L days (Open-Meteo "temperature_2m_previous_dayL":
 * the value predicted 24*L hours before valid time). Returns model -> date -> Tmax.
 */
export async function previousRunsTmax(st: Station, lead: 1 | 2, from: string, to: string): Promise<LeadTmax> {
  const today = new Date().toISOString().slice(0, 10);
  const chunks: [string, string][] = [];
  // immutable archive chunks by calendar year, plus a short-TTL recent chunk
  let a = from;
  while (a <= to) {
    const yEnd = `${a.slice(0, 4)}-12-31`;
    const b = yEnd < to ? yEnd : to;
    chunks.push([a, b]);
    a = addDays(b, 1);
  }
  const out: LeadTmax = new Map(DET_MODELS.map((m) => [m, new Map()]));
  const v = `temperature_2m_previous_day${lead}`;
  for (const [s, e] of chunks) {
    // pad by one day on each side so local days at the chunk edges are complete
    const url =
      `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}` +
      `&hourly=${v}&models=${DET_MODELS.join(",")}&timezone=GMT&start_date=${addDays(s, -1)}&end_date=${addDays(e, 1)}`;
    const ttlSec = e >= addDays(today, -3) ? 3 * 3600 : Infinity;
    const j = await fetchJson<any>(url, { ttlSec, timeoutMs: 180_000 });
    if (j.error) throw new Error(`open-meteo: ${j.reason}`);
    for (const m of DET_MODELS) {
      const series = j.hourly[`${v}_${m}`];
      if (!series) continue;
      for (const [d, x] of dailyMaxFromHourly(j.hourly.time, series, st)) if (d >= s && d <= e) out.get(m)!.set(d, x);
    }
  }
  return out;
}

/** Live deterministic forecasts: model -> date -> Tmax for the next `days` local days. */
export async function liveDetTmax(st: Station, days = 4): Promise<{ tmax: LeadTmax; fetchedAt: string; url: string }> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}` +
    `&hourly=temperature_2m&models=${DET_MODELS.join(",")}&timezone=GMT&past_days=1&forecast_days=${days}`;
  const j = await fetchJson<any>(url, { ttlSec: 1800 });
  const tmax: LeadTmax = new Map();
  for (const m of DET_MODELS) {
    const s = j.hourly[`temperature_2m_${m}`];
    tmax.set(m, s ? dailyMaxFromHourly(j.hourly.time, s, st) : new Map());
  }
  return { tmax, fetchedAt: new Date().toISOString(), url };
}

/** Live ensemble members: ensModel -> date -> member Tmax[] */
export async function liveEnsembleTmax(st: Station, days = 4): Promise<{ members: Map<string, Map<string, number[]>>; url: string }> {
  const models = Object.keys(ENS_MODELS);
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${st.lat}&longitude=${st.lon}` +
    `&hourly=temperature_2m&models=${models.join(",")}&timezone=GMT&past_days=1&forecast_days=${days}`;
  const j = await fetchJson<any>(url, { ttlSec: 1800 });
  const out = new Map<string, Map<string, number[]>>();
  for (const k of Object.keys(j.hourly)) {
    if (k === "time") continue;
    // response keys: temperature_2m[_memberNN]_{ecmwf_ifs025_ensemble | ncep_gefs025 | icon_seamless_eps}
    const model = Object.entries(ENS_SUFFIX).find(([, suf]) => k.endsWith(suf))?.[0];
    if (!model) continue;
    const dm = dailyMaxFromHourly(j.hourly.time, j.hourly[k], st);
    const byDate = out.get(model) ?? new Map<string, number[]>();
    for (const [d, x] of dm) (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(x);
    out.set(model, byDate);
  }
  return { members: out, url };
}
