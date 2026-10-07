// Off-chain reference data, all keyless public APIs:
//   - Polymarket gamma API: the "Highest temperature in <city> on <date>?" event -> implied P(Tmax >= k)
//   - aviationweather.gov METAR API: observed max so far in the station-local day (METAR + SPECI, incl. :30)
//   - Open-Meteo: multi-model daily max -> the v0-lite guardrail
// Ported from spikes/weather (polymarket.ts, settle-core.ts metarTempC, scripts/live.ts). Honesty rule baked in:
// Isotherm's own v0 forecast LOSES to Polymarket in backtest (Brier 0.0656 vs 0.0594), so it is only a guardrail.
import type { City } from "./config.js";
import { Phi, shortErr, withTimeout } from "./util.js";

const UA = { "User-Agent": "mm-plugin-isotherm (+https://github.com/; hackathon testnet tool)" };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

async function getJson<T>(url: string, ms = 9000): Promise<T> {
  const res = await withTimeout(fetch(url, { headers: UA }), ms, new URL(url).host);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const text = await res.text();
  return (text.trim() ? JSON.parse(text) : null) as T;
}

// ------------------------------------------------------------------------------------------- dates
/** yyyymmdd (number) <-> YYYY-MM-DD */
export const isoOf = (d: number) => `${Math.floor(d / 10000)}-${String(Math.floor(d / 100) % 100).padStart(2, "0")}-${String(d % 100).padStart(2, "0")}`;
export const numOf = (iso: string) => Number(iso.replaceAll("-", ""));

/** Station-local calendar date (yyyymmdd) of an instant. */
export function localDate(epochMs: number, utcOffsetMin: number): number {
  return numOf(new Date(epochMs + utcOffsetMin * 60_000).toISOString().slice(0, 10));
}
/** [start, end) of a station-local day in epoch seconds. */
export function localDayRange(date: number, utcOffsetMin: number): [number, number] {
  const start = Date.parse(isoOf(date) + "T00:00:00Z") / 1000 - utcOffsetMin * 60;
  return [start, start + 86_400];
}
export function addDays(date: number, n: number): number {
  return numOf(new Date(Date.parse(isoOf(date) + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10));
}

/** "today" | "tomorrow" | YYYY-MM-DD | yyyymmdd -> yyyymmdd (station-local). */
export function parseDateArg(raw: string | undefined, city: Pick<City, "utcOffsetMin">, nowMs = Date.now()): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  const today = localDate(nowMs, city.utcOffsetMin);
  if (s === "today") return today;
  if (s === "tomorrow") return addDays(today, 1);
  if (s === "yesterday") return addDays(today, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return numOf(s);
  if (/^\d{8}$/.test(s)) return Number(s);
  throw new Error(`date '${raw}' must be today, tomorrow, YYYY-MM-DD or yyyymmdd`);
}

// ------------------------------------------------------------------------------------------- Polymarket
export type PmBucket = { label: string; lo: number; hi: number; bid: number | null; ask: number | null; mid: number };
export type PmLadder = {
  slug: string;
  url: string;
  closed: boolean;
  volumeUsd: number;
  sumMid: number; // raw sum of bucket mids before normalisation (overround)
  buckets: PmBucket[];
  /** P(Tmax >= k) for every k on Polymarket's bucket grid (normalised mids). */
  ladder: Record<number, number>;
};

export function pmSlug(city: City, date: number): string {
  const iso = isoOf(date);
  const [y, m, d] = iso.split("-").map(Number);
  return `highest-temperature-in-${city.polymarketCity}-on-${MONTHS[m - 1]}-${d}-${y}`;
}

/** "21°C or below" | "25°C" | "31°C or higher" | "24-25°C" -> integer range (°C only). */
export function parseBucket(label: string): { lo: number; hi: number } | null {
  if (/°?F\b/.test(label) && !/°C/.test(label)) return null;
  const s = label.replace(/\s+/g, " ").trim();
  let m = s.match(/^(-?\d+)\s*°?C? or (below|lower)$/i);
  if (m) return { lo: -Infinity, hi: Number(m[1]) };
  m = s.match(/^(-?\d+)\s*°?C? or (higher|above|more)$/i);
  if (m) return { lo: Number(m[1]), hi: Infinity };
  m = s.match(/^(-?\d+)\s*[-–]\s*(-?\d+)\s*°?C?$/);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]) };
  m = s.match(/^(-?\d+)\s*°?C?$/);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]) };
  return null;
}

/** Turn a gamma event into an implied P(>= k) ladder. Pure (unit-tested on a captured response). */
export function impliedFromEvent(e: any): PmLadder | null {
  const buckets: PmBucket[] = [];
  for (const m of e?.markets ?? []) {
    const pb = parseBucket(String(m.groupItemTitle ?? ""));
    if (!pb) return null; // Fahrenheit or an unknown grid: do not guess
    const bid = m.bestBid == null ? null : Number(m.bestBid);
    const ask = m.bestAsk == null ? null : Number(m.bestAsk);
    let mid: number;
    if (bid !== null && ask !== null && bid > 0 && ask >= bid) mid = (bid + ask) / 2;
    else {
      try {
        mid = Number(JSON.parse(m.outcomePrices ?? "[]")[0]);
      } catch {
        mid = NaN;
      }
    }
    if (!Number.isFinite(mid)) return null;
    buckets.push({ label: String(m.groupItemTitle), lo: pb.lo, hi: pb.hi, bid, ask, mid });
  }
  if (!buckets.length) return null;
  buckets.sort((a, b) => a.lo - b.lo);
  const sum = buckets.reduce((s, b) => s + b.mid, 0);
  if (!(sum > 0.5 && sum < 1.6)) return null; // broken snapshot
  const ladder: Record<number, number> = {};
  for (const b of buckets) if (Number.isFinite(b.lo)) ladder[b.lo] = buckets.filter((x) => x.lo >= b.lo).reduce((s, x) => s + x.mid, 0) / sum;
  return {
    slug: String(e.slug),
    url: `https://polymarket.com/event/${e.slug}`,
    closed: Boolean(e.closed),
    volumeUsd: Math.round(Number(e.volume ?? 0)),
    sumMid: Math.round(sum * 1000) / 1000,
    buckets,
    ladder,
  };
}

/** P(>= k) from the implied ladder; null when k is off Polymarket's bucket grid. */
export function impliedAt(pm: PmLadder | null, k: number): number | null {
  if (!pm) return null;
  if (pm.ladder[k] !== undefined) return pm.ladder[k];
  const los = Object.keys(pm.ladder).map(Number).sort((a, b) => a - b);
  if (los.length && k < los[0] && pm.buckets[0] && pm.buckets[0].lo === -Infinity && pm.buckets[0].hi < k) return 1; // entire grid is >= k
  return null;
}

export async function polymarketImplied(city: City, date: number): Promise<{ pm: PmLadder | null; error?: string }> {
  const slug = pmSlug(city, date);
  try {
    const r = await getJson<any[]>(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    if (!r || !r.length) return { pm: null, error: `no Polymarket event '${slug}' (it usually lists ~2 days ahead)` };
    const pm = impliedFromEvent(r[0]);
    return pm ? { pm } : { pm: null, error: `Polymarket event '${slug}' has an unparseable bucket grid` };
  } catch (e) {
    return { pm: null, error: `Polymarket unavailable: ${shortErr(e)}` };
  }
}

// ------------------------------------------------------------------------------------------- METAR observed max
/** Integer °C of the METAR temperature group "TT/DD" (M = minus), remarks ignored. From settle-core.ts. */
export function metarTempC(raw: string): number | null {
  const body = (" " + raw + " ").split(" RMK ")[0];
  const m = body.match(/\s(M?\d{2})\/(M?\d{2}|\/\/)?(?=\s)/);
  if (!m) return null;
  return m[1].charAt(0) === "M" ? -Number(m[1].slice(1)) : Number(m[1]);
}

export type Observed = {
  source: "aviationweather.gov";
  station: string;
  date: number;
  status: "future" | "in-progress" | "day-ended";
  maxC: number | null;
  nReports: number;
  lastReportUtc: string | null;
  note: string;
};

export function observedFromReports(reports: { obsTime: number; rawOb: string }[], station: string, date: number, utcOffsetMin: number, nowMs = Date.now()): Observed {
  const [start, end] = localDayRange(date, utcOffsetMin);
  const nowS = Math.floor(nowMs / 1000);
  const status = nowS < start ? "future" : nowS < end ? "in-progress" : "day-ended";
  const inDay = reports.filter((r) => r.obsTime >= start && r.obsTime < end);
  let max: number | null = null;
  let last = 0;
  for (const r of inDay) {
    const t = metarTempC(r.rawOb);
    if (t !== null && (max === null || t > max)) max = t;
    if (r.obsTime > last) last = r.obsTime;
  }
  return {
    source: "aviationweather.gov",
    station,
    date,
    status,
    maxC: max,
    nReports: inDay.length,
    lastReportUtc: last ? new Date(last * 1000).toISOString().replace(".000Z", "Z") : null,
    note:
      status === "future"
        ? "local day has not started"
        : "max over every METAR and SPECI (incl. :30 reports) so far; informational only, settlement uses the official rule after day end",
  };
}

export async function observedMax(city: City, date: number, nowMs = Date.now()): Promise<{ obs: Observed | null; error?: string }> {
  const [start] = localDayRange(date, city.utcOffsetMin);
  if (nowMs / 1000 < start) return { obs: observedFromReports([], city.station, date, city.utcOffsetMin, nowMs) };
  const hours = Math.min(48, Math.max(1, Math.ceil((nowMs / 1000 - start) / 3600) + 1));
  try {
    const rows = (await getJson<any[]>(`https://aviationweather.gov/api/data/metar?ids=${city.station}&format=json&hours=${hours}`)) ?? [];
    return { obs: observedFromReports(rows.map((r) => ({ obsTime: Number(r.obsTime), rawOb: String(r.rawOb ?? "") })), city.station, date, city.utcOffsetMin, nowMs) };
  } catch (e) {
    return { obs: null, error: `aviationweather.gov unavailable: ${shortErr(e)}` };
  }
}

// ------------------------------------------------------------------------------------------- v0-lite guardrail
export const V0_MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless", "jma_seamless"] as const;
export const V0_SIGMA_C = 1.5;

export type V0 = {
  name: "isotherm-v0-lite";
  mu: number;
  sigma: number;
  models: Record<string, number>;
  disclaimer: string;
};

/** P(METAR integer Tmax >= k) under N(mu, sigma): Y >= k  <=>  continuous proxy >= k - 0.5. */
export function v0Prob(mu: number, sigma: number, k: number, observedMaxC: number | null = null): number {
  if (observedMaxC !== null && observedMaxC >= k) return 1; // already reached today
  return 1 - Phi((k - 0.5 - mu) / sigma);
}

export async function v0Forecast(city: City, date: number): Promise<{ v0: V0 | null; error?: string }> {
  const iso = isoOf(date);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max` +
    `&models=${V0_MODELS.join(",")}&timezone=${encodeURIComponent(city.tz)}&start_date=${iso}&end_date=${iso}`;
  try {
    const j = await getJson<any>(url);
    const models: Record<string, number> = {};
    for (const m of V0_MODELS) {
      const v = Number(j?.daily?.[`temperature_2m_max_${m}`]?.[0]);
      if (Number.isFinite(v)) models[m] = v;
    }
    const vals = Object.values(models);
    if (!vals.length) {
      const single = Number(j?.daily?.temperature_2m_max?.[0]);
      if (Number.isFinite(single)) models.best_match = single;
    }
    const xs = Object.values(models);
    if (!xs.length) return { v0: null, error: "Open-Meteo returned no daily max for that date" };
    const mu = xs.reduce((s, x) => s + x, 0) / xs.length;
    const spread = Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length);
    return {
      v0: {
        name: "isotherm-v0-lite",
        mu: Math.round(mu * 100) / 100,
        sigma: Math.round(Math.sqrt(V0_SIGMA_C ** 2 + spread ** 2) * 100) / 100,
        models,
        disclaimer:
          "Guardrail only: raw multi-model mean (no bias correction) with sigma ~1.5 C. Isotherm's calibrated v0 forecast loses to Polymarket in backtest (Brier 0.0656 vs 0.0594); this lite version is cruder still.",
      },
    };
  } catch (e) {
    return { v0: null, error: `Open-Meteo unavailable: ${shortErr(e)}` };
  }
}

/** Flag a strike where the guardrail and Polymarket disagree by more than 0.15 (weather spike recommendation). */
export const GUARDRAIL_GAP = 0.15;
