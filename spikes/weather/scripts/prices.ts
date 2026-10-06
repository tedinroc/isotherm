// Polymarket-implied P(Tmax >= k) ladders at fixed local snapshot times, for every resolved,
// station-sourced daily event. Usage: node scripts/prices.ts [RCSS|RJTT ...]
import { eventPriceHistories, impliedLadder, seriesEvents, settlementSourceOf } from "../src/polymarket.ts";
import { STATIONS, addDays, localDayUtcRange } from "../src/stations.ts";
import { pmap, readJson, stats, writeJson } from "../src/http.ts";

// snapshot name -> (local date offset relative to D, local hour)
export const SNAPSHOTS: Record<string, [number, number]> = {
  "D-1 12:00": [-1, 12],
  "D-1 23:00": [-1, 23],
  "D 08:00": [0, 8],
};

const want = process.argv.slice(2).filter((a) => STATIONS[a]);
for (const st of Object.values(STATIONS).filter((s) => !want.length || want.includes(s.icao))) {
  const daily = new Map<string, any>(readJson<any[]>(`data/daily_${st.icao}.json`).map((d) => [d.date, d]));
  const events = (await seriesEvents(st.polymarketSeriesId)).filter(
    (e) => e.closed && e.winner && settlementSourceOf(e, st.icao).kind === "station",
  );
  const t0 = Date.now();
  let done = 0;
  const rows = await pmap(events, 3, async (ev) => {
    const hist = await eventPriceHistories(ev);
    if (++done % 25 === 0) console.log(`  [${st.icao}] ${done}/${events.length} events, ${Math.round((Date.now() - t0) / 1000)} s`);
    const snaps: Record<string, any> = {};
    for (const [name, [dOff, hour]] of Object.entries(SNAPSHOTS)) {
      const [dayStart] = localDayUtcRange(addDays(ev.date, dOff), st.utcOffsetMin);
      const ts = Math.floor((dayStart + hour * 3600_000) / 1000);
      const L = impliedLadder(ev, hist, ts);
      snaps[name] = L ? { ts, sumRaw: +L.sumRaw.toFixed(4), ladder: L.ladder, buckets: L.buckets.map((b) => [b.label, +b.p.toFixed(4)]) } : null;
    }
    return {
      date: ev.date,
      tmaxObs: daily.get(ev.date)?.tmaxC ?? null,
      winner: ev.winner!.label,
      volume: Math.round(ev.volume),
      buckets: ev.buckets.map((b) => b.label),
      nPoints: Object.fromEntries([...hist].map(([k, v]) => [k, v.length])),
      snaps,
    };
  });
  const coverage = Object.fromEntries(Object.keys(SNAPSHOTS).map((s) => [s, rows.filter((r) => r.snaps[s]).length]));
  writeJson(`data/pm_ladders_${st.icao}.json`, rows);
  console.log(`[${st.icao}] ${rows.length} events, snapshots available: ${JSON.stringify(coverage)}, ${Math.round((Date.now() - t0) / 1000)} s, cache ${JSON.stringify(stats)}`);
}
