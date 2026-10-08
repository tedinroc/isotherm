// Observation core (runtime-agnostic: no Node APIs). Archive URL builders and parsers, the daily max, and the
// intraday running max, with the HTTP GET injected (`get`), so the Node maker (obs.ts, file-cached fetchText) and
// the Cloudflare Worker (apps/maker-worker) share one implementation. Moved verbatim from obs.ts, which re-exports it.
import type { TextGetter } from "./fetch-types.ts";
import { addDays, localDateOf, localDayUtcRange, station, type Station } from "./stations.ts";
import { iemDayUrl, metarTempC, parseAwcJson, parseIemCsv, type Ob } from "./settle-core.ts";

export { metarTempC };

export interface Obs {
  tUtc: number; // epoch ms of observation time
  tempC: number; // integer °C exactly as coded in the METAR temperature group
  kind: "METAR" | "SPECI";
  raw: string;
  src: "iem" | "awc" | "ogimet";
}

// ---------------------------------------------------------------- IEM (bulk, UTC chunks; same URLs as the spike so
// its cache can seed ours)
export function iemUrl(icao: string, fromUtcDate: string, toUtcDateExcl: string, reportType: 3 | 4): string {
  const [y1, m1, d1] = fromUtcDate.split("-").map(Number);
  const [y2, m2, d2] = toUtcDateExcl.split("-").map(Number);
  return (
    `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${icao}` +
    `&data=tmpc&data=metar&year1=${y1}&month1=${m1}&day1=${d1}&year2=${y2}&month2=${m2}&day2=${d2}` +
    `&tz=Etc/UTC&format=onlycomma&latlon=no&elev=no&missing=M&trace=T&direct=no&report_type=${reportType}`
  );
}

export function parseIemBulk(csv: string, kind: "METAR" | "SPECI"): Obs[] {
  const lines = csv.trim().split("\n");
  const hdr = lines[0].split(",");
  const iV = hdr.indexOf("valid"), iT = hdr.indexOf("tmpc"), iM = hdr.indexOf("metar");
  if (iV < 0 || iT < 0 || iM < 0) throw new Error("unexpected IEM header: " + lines[0]);
  const obs: Obs[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const raw = cols.slice(iM).join(",");
    const tUtc = Date.parse(cols[iV].replace(" ", "T") + ":00Z");
    const parsed = metarTempC(raw);
    const tmpc = cols[iT] === "M" ? null : Number(cols[iT]);
    if (parsed === null && tmpc === null) continue;
    obs.push({ tUtc, tempC: parsed ?? Math.round(tmpc as number), kind, raw, src: "iem" });
  }
  return obs;
}

/** All IEM obs (METAR+SPECI) whose UTC time is in [fromUtcDate, toUtcDateExcl), chunked by calendar year, through `get`.
 *  `immutable` forces an infinite TTL (reproducible analyses over a fixed past window). */
export async function iemObsWith(get: TextGetter, icao: string, fromUtcDate: string, toUtcDateExcl: string, immutable = false): Promise<Obs[]> {
  const today = new Date().toISOString().slice(0, 10);
  const out: Obs[] = [];
  let a = fromUtcDate;
  while (a < toUtcDateExcl) {
    const yearEnd = `${Number(a.slice(0, 4)) + 1}-01-01`;
    const b = yearEnd < toUtcDateExcl ? yearEnd : toUtcDateExcl;
    const ttlSec = immutable ? Infinity : b >= addDays(today, -2) ? 1800 : Infinity;
    for (const rt of [3, 4] as const) out.push(...parseIemBulk(await get(iemUrl(icao, a, b, rt), { ttlSec, timeoutMs: 180_000 }), rt === 3 ? "METAR" : "SPECI"));
    a = b;
  }
  const seen = new Set<string>();
  return out.filter((o) => (seen.has(o.tUtc + o.raw) ? false : (seen.add(o.tUtc + o.raw), true))).sort((x, y) => x.tUtc - y.tUtc);
}

// ---------------------------------------------------------------- Ogimet (third, independent archive; monthly chunks)
export function ogimetUrl(icao: string, beginUtc: Date, endUtcIncl: Date): string {
  const f = (d: Date) => d.toISOString().slice(0, 16).replace(/[-T:]/g, "");
  return `https://www.ogimet.com/cgi-bin/getmetar?icao=${icao}&begin=${f(beginUtc)}&end=${f(endUtcIncl)}`;
}

export function parseOgimet(text: string): Obs[] {
  const out: Obs[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z]{4}),(\d{4}),(\d{2}),(\d{2}),(\d{2}),(\d{2}),((METAR|SPECI) .*?)=?\s*$/);
    if (!m || / NIL$/.test(m[7])) continue;
    const t = metarTempC(m[7].replace(/^(METAR|SPECI) /, ""));
    if (t === null) continue;
    out.push({ tUtc: Date.parse(`${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:00Z`), tempC: t, kind: m[8] as "METAR" | "SPECI", raw: m[7], src: "ogimet" });
  }
  return out;
}

// ---------------------------------------------------------------- daily max (spike semantics, unchanged)
export interface DailyMax {
  station: string;
  date: string;
  tmaxC: number | null;
  nObs: number;
  nHours: number;
  firstLocal: string | null;
  lastLocal: string | null;
  atLocal: string[];
  complete: boolean; // >= 20 distinct local hours and a report at/after 23:00 local
}

export function hhmmLocal(tUtc: number, offMin: number): string {
  return new Date(tUtc + offMin * 60_000).toISOString().slice(11, 16);
}

export function groupByLocalDay(st: Station, obs: Obs[]): Map<string, Obs[]> {
  const by = new Map<string, Obs[]>();
  for (const o of obs) {
    const d = localDateOf(o.tUtc, st.utcOffsetMin);
    (by.get(d) ?? by.set(d, []).get(d)!).push(o);
  }
  for (const os of by.values()) os.sort((a, b) => a.tUtc - b.tUtc);
  return by;
}

export function summarizeDay(st: Station, date: string, os: Obs[]): DailyMax {
  const off = st.utcOffsetMin;
  const tmax = os.length ? Math.max(...os.map((o) => o.tempC)) : null;
  const hours = new Set(os.map((o) => hhmmLocal(o.tUtc, off).slice(0, 2)));
  const lastLocal = os.length ? hhmmLocal(os[os.length - 1].tUtc, off) : null;
  return {
    station: st.icao,
    date,
    tmaxC: tmax,
    nObs: os.length,
    nHours: hours.size,
    firstLocal: os.length ? hhmmLocal(os[0].tUtc, off) : null,
    lastLocal,
    atLocal: os.filter((o) => o.tempC === tmax).map((o) => hhmmLocal(o.tUtc, off)),
    complete: hours.size >= 20 && lastLocal !== null && lastLocal >= "23:00",
  };
}

export function dailyMaxima(st: Station, obs: Obs[]): Map<string, DailyMax> {
  const out = new Map<string, DailyMax>();
  for (const [date, os] of groupByLocalDay(st, obs)) out.set(date, summarizeDay(st, date, os));
  return out;
}

// ---------------------------------------------------------------- intraday: observed max so far
export interface SourceMax {
  src: "iem" | "awc";
  url: string;
  tmaxC: number | null;
  nObs: number;
  lastUtc: number | null;
  error?: string;
}
export interface ObservedMax {
  station: string;
  date: string; // local date
  tmaxC: number | null; // max over the union of reports seen so far in [start, min(now, end))
  nObs: number;
  lastObsUtc: number | null;
  lastLocal: string | null;
  atLocal: string | null; // local time of the first report that hit tmaxC
  dayStarted: boolean;
  dayOver: boolean;
  fetchedAt: string;
  sources: SourceMax[];
}

export function awcWindowUrl(icao: string, endMs: number, hours: number): string {
  return `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=${hours}&date=${new Date(endMs).toISOString().slice(0, 19)}Z`;
}

/** Pure: combine source observations into the running max for the local day (exported for tests). */
export function runningMax(st: Station, date: string, nowMs: number, perSource: { src: "iem" | "awc"; url: string; obs: Ob[] | null; error?: string }[]): ObservedMax {
  const [start, end] = localDayUtcRange(date, st.utcOffsetMin);
  const upto = Math.min(nowMs, end);
  const keep = (o: Ob) => o.tUtcMs >= start && o.tUtcMs < upto;
  const sources: SourceMax[] = [];
  const all = new Map<number, number>(); // tUtcMs -> max temp at that time across sources
  for (const s of perSource) {
    const os = (s.obs ?? []).filter(keep);
    for (const o of os) all.set(o.tUtcMs, Math.max(all.get(o.tUtcMs) ?? -999, o.tempC));
    sources.push({
      src: s.src,
      url: s.url,
      tmaxC: os.length ? Math.max(...os.map((o) => o.tempC)) : null,
      nObs: os.length,
      lastUtc: os.length ? Math.max(...os.map((o) => o.tUtcMs)) : null,
      ...(s.error ? { error: s.error } : {}),
    });
  }
  const times = [...all.keys()].sort((a, b) => a - b);
  let tmax: number | null = null, at: number | null = null;
  for (const t of times) if (tmax === null || all.get(t)! > tmax) (tmax = all.get(t)!), (at = t);
  const last = times.length ? times[times.length - 1] : null;
  return {
    station: st.icao,
    date,
    tmaxC: tmax,
    nObs: times.length,
    lastObsUtc: last,
    lastLocal: last === null ? null : hhmmLocal(last, st.utcOffsetMin),
    atLocal: at === null ? null : hhmmLocal(at, st.utcOffsetMin),
    dayStarted: nowMs >= start,
    dayOver: nowMs >= end,
    fetchedAt: new Date(nowMs).toISOString(),
    sources,
  };
}

/** Running max of the local day so far, from AWC (fresh) and IEM (lags ~1-2 h), through `getText`. Never throws. */
export async function observedMaxWith(getText: TextGetter, icao: string, date: string, nowMs = Date.now(), ttlSec = 120): Promise<ObservedMax> {
  const st = station(icao);
  const [start, end] = localDayUtcRange(date, st.utcOffsetMin);
  if (nowMs < start) return runningMax(st, date, nowMs, []);
  const upto = Math.min(nowMs, end);
  const hours = Math.min(48, Math.ceil((upto - start) / 3_600_000) + 1);
  const awcU = awcWindowUrl(icao, upto, hours);
  const iemU = iemDayUrl(icao, date, st.tzName);
  const get = async (src: "iem" | "awc", url: string, parse: (b: string) => Ob[]) => {
    try {
      return { src, url, obs: parse(await getText(url, { ttlSec, timeoutMs: 20_000, retries: 1 })) };
    } catch (e) {
      return { src, url, obs: null, error: String((e as Error).message ?? e).slice(0, 200) };
    }
  };
  const per = await Promise.all([get("awc", awcU, parseAwcJson), get("iem", iemU, (b) => parseIemCsv(b, st.utcOffsetMin))]);
  return runningMax(st, date, nowMs, per);
}
