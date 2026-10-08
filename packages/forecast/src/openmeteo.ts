// Open-Meteo (keyless, free tier 10k calls/day): previous-runs archive (backtest) + live deterministic + live ensembles.
// The pure parts and the injected-GET fetchers live in openmeteo-core.ts (re-exported here); this file binds them to
// the Node file-cached fetchText and keeps the ensemble fetcher.
import { fetchJson, fetchText } from "./http.ts";
import { dailyMaxFromHourly, ENS_MODELS, liveDetTmaxWith, previousRunsTmaxWith, type LeadTmax } from "./openmeteo-core.ts";
import type { Station } from "./stations.ts";

export * from "./openmeteo-core.ts";

const ENS_SUFFIX: Record<string, string> = {
  ecmwf_ifs025: "ecmwf_ifs025_ensemble", // 51 members (control + 50)
  gfs025: "ncep_gefs025", // 31
  icon_seamless: "icon_seamless_eps", // 40
};

/**
 * Archived forecasts of local-day Tmax at lead L days (Open-Meteo "temperature_2m_previous_dayL":
 * the value predicted 24*L hours before valid time). Returns model -> date -> Tmax.
 */
export async function previousRunsTmax(st: Station, lead: 1 | 2, from: string, to: string): Promise<LeadTmax> {
  return previousRunsTmaxWith(fetchText, st, lead, from, to);
}

/** Live deterministic forecasts: model -> date -> Tmax for the next `days` local days. */
export async function liveDetTmax(st: Station, days = 4): Promise<{ tmax: LeadTmax; fetchedAt: string; url: string }> {
  return liveDetTmaxWith(fetchText, st, days);
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
