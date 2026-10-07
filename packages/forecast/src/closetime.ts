// Close-time analysis: WHEN is a station's daily max (the settlement value) already known?
//
// For every complete local day: M = max integer °C over all METAR+SPECI, tFirst = local time of the FIRST report
// that equals M. After local time C, the settlement value can still change iff tFirst >= C (a report at or after C
// beats every report before C). So:
//   F(C)        = P(tFirst < C)                    -> "the max has been reached by C"
//   massLeft(C) = 1 - F(C)                         -> probability the max still goes up after C
//   inc_d(C)    = P(M - runningMax(<C) >= d)       -> by how much (the maker's intraday guard table)
// The vault's closeTime (mint stops) and the maker's stop-quoting time come from F (t95 / t99 below).
import type { Obs } from "./obs.ts";
import { groupByLocalDay, summarizeDay } from "./obs.ts";
import type { Station } from "./stations.ts";

export interface DayPath {
  date: string;
  month: number;
  M: number;
  tFirstMin: number; // minutes after local midnight of the first report == M
  // running max strictly before each half-hour mark 00:30 .. 24:00 (index i -> mark (i+1)*30 min); null if no obs yet
  runBefore: (number | null)[];
  source: string;
}

const MARKS = Array.from({ length: 48 }, (_, i) => (i + 1) * 30); // 00:30 .. 24:00

export function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Pure: one complete local day of observations -> its path statistics. */
export function dayPath(st: Station, date: string, os: Obs[], source: string): DayPath {
  const start = Date.parse(date + "T00:00:00Z") - st.utcOffsetMin * 60_000;
  const mins = os.map((o) => ({ m: Math.floor((o.tUtc - start) / 60_000), t: o.tempC })).sort((a, b) => a.m - b.m);
  const M = Math.max(...mins.map((x) => x.t));
  const tFirstMin = mins.find((x) => x.t === M)!.m;
  const runBefore = MARKS.map((mark) => {
    const prev = mins.filter((x) => x.m < mark);
    return prev.length ? Math.max(...prev.map((x) => x.t)) : null;
  });
  return { date, month: Number(date.slice(5, 7)), M, tFirstMin, runBefore, source };
}

export interface CloseTimeStats {
  station: string;
  from: string;
  to: string;
  days: number;
  daysBySource: Record<string, number>;
  firstMaxCdf: { t: string; reached: number }[]; // F at each half-hour mark
  t50: string;
  t90: string;
  t95: string;
  t99: string;
  t995: string;
  latestFirstMax: string;
  hourly: { until: string; massLeft: number; inc1: number; inc2: number; inc3: number; n: number }[];
  incrementTable: { mark: string; markMin: number; pIncGE: number[] }[]; // pIncGE[d-1] = P(M - run(<mark) >= d), d = 1..6
  bySeason: Record<string, { days: number; t90: string; t95: string; t99: string; firstMaxCdf: { t: string; reached: number }[] }>;
  byMonth: Record<string, { days: number; t95: string; t99: string }>;
}

function quantileMark(paths: DayPath[], q: number): string {
  for (const mark of MARKS) {
    const reached = paths.filter((p) => p.tFirstMin < mark).length / paths.length;
    if (reached >= q - 1e-12) return hhmm(mark);
  }
  return "24:00";
}

export const SEASONS: Record<string, number[]> = { "warm (May-Oct)": [5, 6, 7, 8, 9, 10], "cool (Nov-Apr)": [11, 12, 1, 2, 3, 4] };

/** Pure: statistics over day paths. */
export function closeTimeStats(stationIcao: string, from: string, to: string, paths: DayPath[]): CloseTimeStats {
  const n = paths.length;
  const firstMaxCdf = MARKS.map((mark) => ({ t: hhmm(mark), reached: +(paths.filter((p) => p.tFirstMin < mark).length / n).toFixed(4) }));
  const incrementTable = MARKS.map((mark, i) => {
    const withRun = paths.filter((p) => p.runBefore[i] !== null);
    const pIncGE = [1, 2, 3, 4, 5, 6].map((d) => (withRun.length ? +(withRun.filter((p) => p.M - (p.runBefore[i] as number) >= d).length / withRun.length).toFixed(4) : 1));
    return { mark: hhmm(mark), markMin: mark, pIncGE };
  });
  const hourly = MARKS.filter((m) => m % 60 === 0).map((mark) => {
    const i = MARKS.indexOf(mark);
    const withRun = paths.filter((p) => p.runBefore[i] !== null);
    const f = (d: number) => +(withRun.filter((p) => p.M - (p.runBefore[i] as number) >= d).length / Math.max(1, withRun.length)).toFixed(4);
    return { until: hhmm(mark), massLeft: +(paths.filter((p) => p.tFirstMin >= mark).length / n).toFixed(4), inc1: f(1), inc2: f(2), inc3: f(3), n: withRun.length };
  });
  const bySeason: CloseTimeStats["bySeason"] = {};
  for (const [name, months] of Object.entries(SEASONS)) {
    const ps = paths.filter((p) => months.includes(p.month));
    if (ps.length)
      bySeason[name] = {
        days: ps.length,
        t90: quantileMark(ps, 0.9),
        t95: quantileMark(ps, 0.95),
        t99: quantileMark(ps, 0.99),
        firstMaxCdf: MARKS.map((mark) => ({ t: hhmm(mark), reached: +(ps.filter((p) => p.tFirstMin < mark).length / ps.length).toFixed(4) })),
      };
  }
  const byMonth: CloseTimeStats["byMonth"] = {};
  for (let m = 1; m <= 12; m++) {
    const ps = paths.filter((p) => p.month === m);
    if (ps.length) byMonth[String(m).padStart(2, "0")] = { days: ps.length, t95: quantileMark(ps, 0.95), t99: quantileMark(ps, 0.99) };
  }
  const daysBySource: Record<string, number> = {};
  for (const p of paths) daysBySource[p.source] = (daysBySource[p.source] ?? 0) + 1;
  return {
    station: stationIcao,
    from,
    to,
    days: n,
    daysBySource,
    firstMaxCdf,
    t50: quantileMark(paths, 0.5),
    t90: quantileMark(paths, 0.9),
    t95: quantileMark(paths, 0.95),
    t99: quantileMark(paths, 0.99),
    t995: quantileMark(paths, 0.995),
    latestFirstMax: hhmm(Math.max(...paths.map((p) => p.tFirstMin))),
    hourly,
    incrementTable,
    bySeason,
    byMonth,
  };
}

/** Pure: build day paths from (primary, fallback) observation sets; a day uses the primary source when complete,
 *  else the fallback when complete, else it is skipped. */
export function buildPaths(st: Station, from: string, to: string, sources: { name: string; obs: Obs[] }[]): DayPath[] {
  const grouped = sources.map((s) => ({ name: s.name, by: groupByLocalDay(st, s.obs) }));
  const dates = new Set<string>();
  for (const g of grouped) for (const d of g.by.keys()) if (d >= from && d <= to) dates.add(d);
  const out: DayPath[] = [];
  for (const d of [...dates].sort()) {
    for (const g of grouped) {
      const os = g.by.get(d);
      if (!os?.length) continue;
      if (!summarizeDay(st, d, os).complete) continue;
      out.push(dayPath(st, d, os, g.name));
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- recommendation
export interface CloseRecommendation {
  station: string;
  closeLocal: string; // vault closeTime (minting stops) = the season's t99 (rounded to the half hour)
  stopQuotingLocal: string; // maker kill switch = closeLocal - marginMin
  marginMin: number;
  massLeftAtClose: number; // P(the max still rises after closeLocal) in the date's season
  massLeftAtCloseAllYear: number; // same, over the whole 2-year sample
  basis: string;
}

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Close = the t99 of the date's season (never later than 23:30 so the vault's `closeTime <= dayEnd` holds with room). */
export function recommendClose(stats: CloseTimeStats, month: number, marginMin = 10): CloseRecommendation {
  const season = Object.entries(SEASONS).find(([, ms]) => ms.includes(month))?.[0];
  const s = season ? stats.bySeason[season] : undefined;
  const t99 = s?.t99 ?? stats.t99;
  const closeMin = Math.min(toMin(t99), 23 * 60 + 30);
  const closeLocal = hhmm(closeMin);
  const cdf = stats.firstMaxCdf.find((x) => x.t === closeLocal);
  const scdf = s?.firstMaxCdf.find((x) => x.t === closeLocal);
  return {
    station: stats.station,
    closeLocal,
    stopQuotingLocal: hhmm(closeMin - marginMin),
    marginMin,
    massLeftAtClose: scdf ? +(1 - scdf.reached).toFixed(4) : cdf ? +(1 - cdf.reached).toFixed(4) : NaN,
    massLeftAtCloseAllYear: cdf ? +(1 - cdf.reached).toFixed(4) : NaN,
    basis: `${season ?? "all-year"} t99 over ${s?.days ?? stats.days} complete days ${stats.from}..${stats.to}`,
  };
}

/** Intraday guard: P(final max >= k | running max m observed before local minute `nowMin`), from the increment table.
 *  Returns 1 when k <= m. Pure. */
export function pIncrementAtLeast(stats: Pick<CloseTimeStats, "incrementTable">, nowMin: number, m: number, k: number): number {
  if (k <= m) return 1;
  const d = k - m;
  // the last mark at or before now (running max "before mark" ⊆ what we have seen by now)
  const rows = stats.incrementTable.filter((r) => r.markMin <= nowMin);
  const row = rows.length ? rows[rows.length - 1] : stats.incrementTable[0];
  return d <= row.pIncGE.length ? row.pIncGE[d - 1] : 0;
}
