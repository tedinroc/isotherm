// Pure settlement core: NO imports, NO Node APIs, NO Date-zone logic beyond fixed offsets.
// Designed to be pasted/ported into a Chainlink CRE TypeScript workflow (compiled to WASM).
//
// RULE  Tmax(station, D) = max integer °C of the METAR temperature group "TT/DD" over every METAR and SPECI
//       whose observation time t satisfies  start(D) <= t < start(D) + 24h,  start(D) = D 00:00 local = D 00:00Z - offset.
// COMPLETE  >= 20 distinct local clock hours with a report, and the last report at or after 23:00 local.
// DECISION  primary sources A=IEM, B=AWC: both complete and equal -> SETTLED.
//           If A or B incomplete: add C=Ogimet; any >= 2 complete sources, all equal -> SETTLED.
//           Complete sources that disagree -> never settle (PENDING until deadline, then VOID).

export interface Ob {
  tUtcMs: number;
  tempC: number;
}
export interface DayStats {
  tmaxC: number | null;
  nObs: number;
  nHours: number;
  lastLocal: string | null;
  complete: boolean;
}

export function metarTempC(raw: string): number | null {
  const body = (" " + raw + " ").split(" RMK ")[0];
  const m = body.match(/\s(M?\d{2})\/(M?\d{2}|\/\/)?(?=\s)/);
  if (!m) return null;
  return m[1].charAt(0) === "M" ? -Number(m[1].slice(1)) : Number(m[1]);
}

export function localDayStartUtcMs(localDate: string, utcOffsetMin: number): number {
  return Date.parse(localDate + "T00:00:00Z") - utcOffsetMin * 60000;
}

function pad2(n: number) {
  return (n < 10 ? "0" : "") + n;
}
function ymd(ms: number) {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

export function dayStats(obs: Ob[], localDate: string, utcOffsetMin: number): DayStats {
  const start = localDayStartUtcMs(localDate, utcOffsetMin);
  const inDay = obs.filter((o) => o.tUtcMs >= start && o.tUtcMs < start + 86400000).sort((a, b) => a.tUtcMs - b.tUtcMs);
  if (!inDay.length) return { tmaxC: null, nObs: 0, nHours: 0, lastLocal: null, complete: false };
  const hours: Record<number, true> = {};
  let tmax = -999;
  for (const o of inDay) {
    hours[Math.floor((o.tUtcMs - start) / 3600000)] = true;
    if (o.tempC > tmax) tmax = o.tempC;
  }
  const lastMin = Math.floor((inDay[inDay.length - 1].tUtcMs - start) / 60000);
  const lastLocal = pad2(Math.floor(lastMin / 60)) + ":" + pad2(lastMin % 60);
  const nHours = Object.keys(hours).length;
  return { tmaxC: tmax, nObs: inDay.length, nHours, lastLocal, complete: nHours >= 20 && lastMin >= 23 * 60 };
}

// ---------------------------------------------------------------- source A: IEM ASOS (local-day CSV)
export function iemDayUrl(icao: string, localDate: string, tzName: string): string {
  const s = Date.parse(localDate + "T00:00:00Z");
  const [y1, m1, d1] = ymd(s);
  const [y2, m2, d2] = ymd(s + 86400000);
  return (
    "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=" + icao + "&data=metar" +
    "&year1=" + y1 + "&month1=" + m1 + "&day1=" + d1 + "&year2=" + y2 + "&month2=" + m2 + "&day2=" + d2 +
    "&tz=" + tzName + "&format=onlycomma&latlon=no&elev=no&missing=M&trace=T&direct=no&report_type=3&report_type=4"
  );
}
/** CSV "station,valid,metar" with `valid` in LOCAL time (because of tz=). */
export function parseIemCsv(csv: string, utcOffsetMin: number): Ob[] {
  const out: Ob[] = [];
  const lines = csv.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c1 = line.indexOf(","), c2 = line.indexOf(",", c1 + 1);
    const valid = line.slice(c1 + 1, c2); // "YYYY-MM-DD HH:MM"
    const t = metarTempC(line.slice(c2 + 1));
    if (t === null) continue;
    out.push({ tUtcMs: Date.parse(valid.replace(" ", "T") + ":00Z") - utcOffsetMin * 60000, tempC: t });
  }
  return out;
}

// ---------------------------------------------------------------- source B: aviationweather.gov (JSON)
export function awcDayUrl(icao: string, localDate: string, utcOffsetMin: number): string {
  const end = new Date(localDayStartUtcMs(localDate, utcOffsetMin) + 86400000).toISOString().slice(0, 19) + "Z";
  return "https://aviationweather.gov/api/data/metar?ids=" + icao + "&format=json&date=" + end + "&hours=24";
}
/** JSON array; use obsTime (unix s) and rawOb. Window is inclusive of `date` -> dayStats() drops t >= end. Empty body = []. */
export function parseAwcJson(body: string): Ob[] {
  const s = body.trim();
  if (!s) return [];
  const rows = JSON.parse(s) as { obsTime: number; rawOb: string }[];
  const out: Ob[] = [];
  for (const r of rows) {
    const t = metarTempC(r.rawOb);
    if (t !== null) out.push({ tUtcMs: r.obsTime * 1000, tempC: t });
  }
  return out;
}

// ---------------------------------------------------------------- source C: Ogimet (text, fallback)
export function ogimetDayUrl(icao: string, localDate: string, utcOffsetMin: number): string {
  const f = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace(/[-T:]/g, "");
  const s = localDayStartUtcMs(localDate, utcOffsetMin);
  return "https://www.ogimet.com/cgi-bin/getmetar?icao=" + icao + "&begin=" + f(s) + "&end=" + f(s + 86400000 - 60000);
}
export function parseOgimetText(text: string): Ob[] {
  const out: Ob[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^[A-Z]{4},(\d{4}),(\d{2}),(\d{2}),(\d{2}),(\d{2}),(?:METAR|SPECI) (.*?)=?\s*$/);
    if (!m || / NIL$/.test(m[6])) continue;
    const t = metarTempC(m[6]);
    if (t !== null) out.push({ tUtcMs: Date.parse(m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":00Z"), tempC: t });
  }
  return out;
}

// ---------------------------------------------------------------- decision
export type Status = "SETTLED" | "PENDING" | "VOID";
export function decide(primary: DayStats[], fallback: DayStats[], pastDeadline: boolean): { status: Status; tmaxC: number | null; reason: string } {
  const [a, b] = primary;
  if (a.complete && b.complete) {
    if (a.tmaxC === b.tmaxC) return { status: "SETTLED", tmaxC: a.tmaxC, reason: "primary sources agree" };
    return { status: pastDeadline ? "VOID" : "PENDING", tmaxC: null, reason: "primary sources disagree" };
  }
  const ok = primary.concat(fallback).filter((s) => s.complete && s.tmaxC !== null);
  const allEqual = ok.every((s) => s.tmaxC === ok[0].tmaxC);
  if (ok.length >= 2 && allEqual) return { status: "SETTLED", tmaxC: ok[0].tmaxC, reason: "2-of-3 fallback agree" };
  return { status: pastDeadline ? "VOID" : "PENDING", tmaxC: null, reason: ok.length >= 2 ? "complete sources disagree" : "insufficient complete sources" };
}
