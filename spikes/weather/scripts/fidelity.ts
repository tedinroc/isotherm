// Settlement fidelity: IEM-derived local-day integer Tmax vs Polymarket's resolved winning bucket.
// Usage: node scripts/fidelity.ts            (both stations)
import { iemObs, dailyMaxima, type Obs } from "../src/obs.ts";
import { seriesEvents, settlementSourceOf, type PmEvent } from "../src/polymarket.ts";
import { STATIONS, addDays, localDateOf } from "../src/stations.ts";
import { stats, writeJson } from "../src/http.ts";

const HIST_START = "2024-01-01";
const today = new Date().toISOString().slice(0, 10);

function inBucket(t: number | null, ev: PmEvent): boolean | null {
  if (t === null || !ev.winner) return null;
  return t >= ev.winner.lo && t <= ev.winner.hi;
}
function bucketOf(t: number, ev: PmEvent): string | null {
  return ev.buckets.find((b) => t >= b.lo && t <= b.hi)?.label ?? null;
}

const summary: any = { generatedAt: new Date().toISOString(), stations: {} };

for (const st of Object.values(STATIONS)) {
  const t0 = Date.now();
  const obs = await iemObs(st.icao, HIST_START, addDays(today, 1));
  const daily = dailyMaxima(st, obs);
  // alternative (wrong) definition for contrast: UTC calendar day
  const utcDaily = dailyMaxima({ ...st, utcOffsetMin: 0 }, obs);
  console.log(`[${st.icao}] IEM obs ${obs.length} (${obs.filter((o) => o.kind === "SPECI").length} SPECI), days ${daily.size}, ${Date.now() - t0} ms`);

  writeJson(`data/daily_${st.icao}.json`, [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)));

  const events = await seriesEvents(st.polymarketSeriesId);
  const resolved = events.filter((e) => e.closed && e.winner);
  const unresolvedClosed = events.filter((e) => e.closed && !e.winner);
  console.log(`[${st.icao}] polymarket events ${events.length}, resolved w/ single winner ${resolved.length}, closed w/o winner ${unresolvedClosed.length}`);

  const rows = resolved.map((ev) => {
    const d = daily.get(ev.date);
    const u = utcDaily.get(ev.date);
    const src = settlementSourceOf(ev, st.icao);
    return {
      date: ev.date,
      source: src.label,
      sourceKind: src.kind,
      winner: ev.winner!.label,
      iemTmax: d?.tmaxC ?? null,
      iemBucket: d?.tmaxC != null ? bucketOf(d.tmaxC, ev) : null,
      match: inBucket(d?.tmaxC ?? null, ev),
      onCycleTmax: d?.tmaxOnCycle ?? null,
      onCycleMatch: inBucket(d?.tmaxOnCycle ?? null, ev),
      hourlyTmax: d?.tmaxHourly ?? null,
      hourlyMatch: inBucket(d?.tmaxHourly ?? null, ev),
      offCycleDecisive: d?.offCycleDecisive ?? false,
      utcDayTmax: u?.tmaxC ?? null,
      utcDayMatch: inBucket(u?.tmaxC ?? null, ev),
      nObs: d?.nObs ?? 0,
      complete: d?.complete ?? false,
      atLocal: d?.atLocal ?? [],
      resolutionSource: ev.resolutionSource,
      volume: Math.round(ev.volume),
    };
  });

  const stationRows = rows.filter((r) => r.sourceKind === "station");
  const count = (k: "match" | "onCycleMatch" | "hourlyMatch" | "utcDayMatch", rs = stationRows) => ({
    n: rs.length,
    match: rs.filter((r) => r[k] === true).length,
    mismatch: rs.filter((r) => r[k] === false).length,
    noData: rs.filter((r) => r[k] === null).length,
  });
  const bySource: Record<string, any> = {};
  for (const r of rows) {
    const s = (bySource[r.source] ??= { n: 0, match: 0, mismatch: 0, first: r.date, last: r.date });
    s.n++;
    if (r.match === true) s.match++;
    if (r.match === false) s.mismatch++;
    s.last = r.date;
  }
  // days where an off-cycle SPECI alone sets the max (tests whether the resolver includes SPECIs)
  const speciDecisive = stationRows.filter((r) => r.offCycleDecisive);
  // days where the :30 report alone sets the max (tests whether the resolver includes half-hourly METARs)
  const halfHourDecisive = stationRows.filter((r) => r.onCycleTmax !== r.hourlyTmax);
  const res = {
    icao: st.icao,
    city: st.city,
    iemObs: obs.length,
    events: events.length,
    resolved: resolved.length,
    closedWithoutWinner: unresolvedClosed.map((e) => e.date),
    firstDate: resolved[0]?.date,
    lastDate: resolved.at(-1)?.date,
    stationSourcedEvents: stationRows.length,
    otherSourcedEvents: rows.filter((r) => r.sourceKind !== "station").map((r) => ({ date: r.date, source: r.source, match: r.match })),
    rule_localDay_allReports: count("match"),
    rule_localDay_onCycleOnly: count("onCycleMatch"),
    rule_localDay_hourlyOnly: count("hourlyMatch"),
    rule_utcDay_allReports: count("utcDayMatch"),
    bySource,
    mismatches: stationRows.filter((r) => r.match === false),
    speciDecisiveDays: speciDecisive.map((r) => ({ date: r.date, all: r.iemTmax, onCycle: r.onCycleTmax, winner: r.winner, allMatch: r.match, onCycleMatch: r.onCycleMatch })),
    halfHourDecisiveDays: { n: halfHourDecisive.length, allReportsMatch: halfHourDecisive.filter((r) => r.match).length, hourlyMatch: halfHourDecisive.filter((r) => r.hourlyMatch).length },
    incompleteDays: stationRows.filter((r) => !r.complete).map((r) => ({ date: r.date, nObs: r.nObs, match: r.match })),
    rows,
  };
  summary.stations[st.icao] = { ...res, rows: undefined };
  writeJson(`results/fidelity_${st.icao}.json`, res);
  console.log(`[${st.icao}] ${res.firstDate}..${res.lastDate}  station-sourced events: ${stationRows.length}, other-sourced: ${res.otherSourcedEvents.length}`);
  for (const k of ["rule_localDay_allReports", "rule_localDay_onCycleOnly", "rule_localDay_hourlyOnly", "rule_utcDay_allReports"] as const)
    console.log(`   ${k.padEnd(28)} ${JSON.stringify((res as any)[k])}`);
  console.log(`   other-sourced (not RCSS/RJTT) events: ${JSON.stringify(res.otherSourcedEvents.reduce((a: any, r: any) => ((a[r.source] = (a[r.source] ?? 0) + 1), a), {}))}`);
  console.log(`   half-hour-decisive days: ${JSON.stringify(res.halfHourDecisiveDays)}  incomplete-coverage days: ${res.incompleteDays.length}`);
  console.log(`[${st.icao}] by resolution source: ${JSON.stringify(bySource)}`);
  for (const m of res.mismatches) console.log(`   MISMATCH ${m.date} [${m.source}] winner=${m.winner} iem=${m.iemTmax} onCycle=${m.onCycleTmax} hourly=${m.hourlyTmax} utcDay=${m.utcDayTmax} nObs=${m.nObs} at=${m.atLocal.join("/")}`);
  console.log(`   off-cycle-SPECI-decisive days: ${speciDecisive.length}`, speciDecisive.map((r) => `${r.date}: all=${r.iemTmax} onCycle=${r.onCycleTmax} winner="${r.winner}"`).join(" | "));
}
writeJson("results/fidelity_summary.json", summary);
console.log("http cache", stats);
