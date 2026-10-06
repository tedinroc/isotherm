// Observation sources (keyless): Iowa Environmental Mesonet ASOS archive + aviationweather.gov METAR API.
import { fetchText } from "./http.ts";
import { addDays, localDateOf, station, type Station } from "./stations.ts";

export interface Obs {
  tUtc: number; // epoch ms of observation time
  tempC: number; // integer °C exactly as coded in the METAR temperature group
  kind: "METAR" | "SPECI";
  raw: string;
  src: "iem" | "awc" | "ogimet";
}

// METAR temperature-group parser lives in the pure settlement core (shared with the CRE workflow).
import { metarTempC } from "./settle-core.ts";
export { metarTempC };

// ---------------------------------------------------------------- IEM
// Docs: https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?help
// report_type=3 -> routine METAR, report_type=4 -> SPECI. We fetch them separately so each row is tagged.
export function iemUrl(icao: string, fromUtcDate: string, toUtcDateExcl: string, reportType: 3 | 4): string {
  const [y1, m1, d1] = fromUtcDate.split("-").map(Number);
  const [y2, m2, d2] = toUtcDateExcl.split("-").map(Number);
  return (
    `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${icao}` +
    `&data=tmpc&data=metar&year1=${y1}&month1=${m1}&day1=${d1}&year2=${y2}&month2=${m2}&day2=${d2}` +
    `&tz=Etc/UTC&format=onlycomma&latlon=no&elev=no&missing=M&trace=T&direct=no&report_type=${reportType}`
  );
}

function parseIemCsv(csv: string, kind: "METAR" | "SPECI"): { obs: Obs[]; tmpcMismatch: number } {
  const lines = csv.trim().split("\n");
  const hdr = lines[0].split(",");
  const iV = hdr.indexOf("valid"), iT = hdr.indexOf("tmpc"), iM = hdr.indexOf("metar");
  if (iV < 0 || iT < 0 || iM < 0) throw new Error("unexpected IEM header: " + lines[0]);
  const obs: Obs[] = [];
  let tmpcMismatch = 0;
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const raw = cols.slice(iM).join(","); // metar is last column
    const tUtc = Date.parse(cols[iV].replace(" ", "T") + ":00Z");
    const parsed = metarTempC(raw);
    const tmpc = cols[iT] === "M" ? null : Number(cols[iT]);
    if (parsed === null && tmpc === null) continue;
    if (parsed !== null && tmpc !== null && Math.abs(parsed - tmpc) > 0.01) tmpcMismatch++;
    obs.push({ tUtc, tempC: parsed ?? Math.round(tmpc as number), kind, raw, src: "iem" });
  }
  return { obs, tmpcMismatch };
}

/** All IEM obs (METAR+SPECI) whose UTC time is in [fromUtcDate, toUtcDateExcl). Chunked by calendar year. */
export async function iemObs(icao: string, fromUtcDate: string, toUtcDateExcl: string): Promise<Obs[]> {
  const today = new Date().toISOString().slice(0, 10);
  const out: Obs[] = [];
  let mismatches = 0;
  let a = fromUtcDate;
  while (a < toUtcDateExcl) {
    const yearEnd = `${Number(a.slice(0, 4)) + 1}-01-01`;
    const b = yearEnd < toUtcDateExcl ? yearEnd : toUtcDateExcl;
    // a chunk that ends within 2 days of now is still growing -> 30 min TTL, else immutable
    const ttlSec = b >= addDays(today, -2) ? 1800 : Infinity;
    for (const rt of [3, 4] as const) {
      const csv = await fetchText(iemUrl(icao, a, b, rt), { ttlSec, timeoutMs: 180_000 });
      const r = parseIemCsv(csv, rt === 3 ? "METAR" : "SPECI");
      mismatches += r.tmpcMismatch;
      out.push(...r.obs);
    }
    a = b;
  }
  if (mismatches) console.warn(`[iem] ${icao}: ${mismatches} rows where IEM tmpc != METAR temp group`);
  // de-dup identical (time, raw) rows; keep corrections (different raw) since max() is what matters
  const seen = new Set<string>();
  return out
    .filter((o) => (seen.has(o.tUtc + o.raw) ? false : (seen.add(o.tUtc + o.raw), true)))
    .sort((x, y) => x.tUtc - y.tUtc);
}

// ---------------------------------------------------------------- aviationweather.gov
// Docs: https://aviationweather.gov/data/api/ . Keeps roughly the last 15 days; one response is capped
// (observed: 400 rows), so we page backwards with &date= (end time).
export function awcUrl(icao: string, hours: number, endIso?: string): string {
  return (
    `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=${hours}` +
    (endIso ? `&date=${encodeURIComponent(endIso)}` : "")
  );
}

export async function awcObs(icao: string, days = 15): Promise<Obs[]> {
  const out = new Map<string, Obs>();
  let end = new Date();
  const stop = Date.now() - days * 86_400_000;
  for (let page = 0; page < 10 && end.getTime() > stop; page++) {
    const endIso = end.toISOString().slice(0, 19) + "Z";
    const body = (await fetchText(awcUrl(icao, 96, page === 0 ? undefined : endIso), { ttlSec: 1800 })).trim();
    const rows: any[] = body ? JSON.parse(body) : []; // AWC answers 204/empty when it has no data
    if (!rows.length) break;
    let oldest = Infinity;
    for (const r of rows) {
      const tUtc = r.obsTime * 1000;
      oldest = Math.min(oldest, tUtc);
      const temp = metarTempC(r.rawOb);
      if (temp === null) continue;
      out.set(tUtc + r.rawOb, { tUtc, tempC: temp, kind: r.metarType === "SPECI" ? "SPECI" : "METAR", raw: r.rawOb, src: "awc" });
    }
    end = new Date(oldest - 60_000);
  }
  return [...out.values()].sort((a, b) => a.tUtc - b.tUtc);
}

// ---------------------------------------------------------------- Ogimet (third, independent archive)
// https://www.ogimet.com/cgi-bin/getmetar?icao=RCSS&begin=YYYYMMDDHHmm&end=YYYYMMDDHHmm  (UTC, inclusive)
// Lines: "RCSS,2026,09,30,23,30,METAR RCSS 302330Z ... =" ; missing slots are listed as "... NIL=".
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

/** Ogimet obs in monthly UTC chunks. Past months are immutable. */
export async function ogimetObs(icao: string, fromMonth: string, toMonth: string): Promise<Obs[]> {
  const out: Obs[] = [];
  const nowMonth = new Date().toISOString().slice(0, 7);
  for (let ym = fromMonth; ym <= toMonth; ) {
    const [y, m] = ym.split("-").map(Number);
    const begin = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1) - 60_000);
    const text = await fetchText(ogimetUrl(icao, begin, end), { ttlSec: ym >= nowMonth ? 1800 : Infinity, timeoutMs: 120_000 });
    if (/limit|excess|quota/i.test(text.slice(0, 300)) && !/METAR/.test(text.slice(0, 300))) throw new Error("ogimet refused: " + text.slice(0, 200));
    out.push(...parseOgimet(text));
    ym = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  }
  return out.sort((a, b) => a.tUtc - b.tUtc);
}

// ---------------------------------------------------------------- daily max
export interface DailyMax {
  station: string;
  date: string; // local calendar date
  tmaxC: number | null; // max over METAR+SPECI, integer °C
  tmaxOnCycle: number | null; // max over reports at minute :00/:30 only (RCSS/RJTT routine half-hourly cycle)
  tmaxHourly: number | null; // max over reports at minute :00 only
  offCycleDecisive: boolean; // an off-cycle report (SPECI, minute not :00/:30) is strictly hotter than every on-cycle report
  nObs: number;
  nHours: number; // distinct local hours with >=1 obs
  firstLocal: string | null;
  lastLocal: string | null;
  atLocal: string[]; // local HH:MM of the obs that hit the max
  complete: boolean; // coverage rule used for void decisions
}

export function hhmmLocal(tUtc: number, offMin: number): string {
  return new Date(tUtc + offMin * 60_000).toISOString().slice(11, 16);
}

/** Group obs into local calendar days and compute the settlement max. */
export function dailyMaxima(st: Station, obs: Obs[]): Map<string, DailyMax> {
  const by = new Map<string, Obs[]>();
  for (const o of obs) {
    const d = localDateOf(o.tUtc, st.utcOffsetMin);
    (by.get(d) ?? by.set(d, []).get(d)!).push(o);
  }
  const out = new Map<string, DailyMax>();
  for (const [date, os] of by) out.set(date, summarizeDay(st, date, os));
  return out;
}

export function summarizeDay(st: Station, date: string, os: Obs[]): DailyMax {
  const off = st.utcOffsetMin;
  const tmax = os.length ? Math.max(...os.map((o) => o.tempC)) : null;
  // NOTE: IEM's report_type=4 ("specials") also contains the routine :30 half-hourly METARs, so IEM's tag is
  // not the true METAR/SPECI split. We classify by observation minute instead.
  const minute = (o: Obs) => new Date(o.tUtc).getUTCMinutes();
  const mx = (xs: Obs[]) => (xs.length ? Math.max(...xs.map((o) => o.tempC)) : null);
  const onCycle = os.filter((o) => minute(o) === 0 || minute(o) === 30);
  const hourly = os.filter((o) => minute(o) === 0);
  const hours = new Set(os.map((o) => hhmmLocal(o.tUtc, off).slice(0, 2)));
  const lastLocal = os.length ? hhmmLocal(os[os.length - 1].tUtc, off) : null;
  return {
    station: st.icao,
    date,
    tmaxC: tmax,
    tmaxOnCycle: mx(onCycle),
    tmaxHourly: mx(hourly),
    offCycleDecisive: tmax !== null && (mx(onCycle) ?? -999) < tmax,
    nObs: os.length,
    nHours: hours.size,
    firstLocal: os.length ? hhmmLocal(os[0].tUtc, off) : null,
    lastLocal,
    atLocal: os.filter((o) => o.tempC === tmax).map((o) => hhmmLocal(o.tUtc, off)),
    // "complete": >= 20 distinct local hours observed, including at least one obs at/after 23:00 local
    complete: hours.size >= 20 && lastLocal !== null && lastLocal >= "23:00",
  };
}

export { station };
