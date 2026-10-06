// Third-source check: Ogimet-derived local-day Tmax vs IEM and vs Polymarket winners over the Polymarket period.
// Usage: node scripts/ogimet_check.ts
import { dailyMaxima, ogimetObs } from "../src/obs.ts";
import { seriesEvents, settlementSourceOf } from "../src/polymarket.ts";
import { STATIONS } from "../src/stations.ts";
import { readJson, writeJson } from "../src/http.ts";

const out: any = { generatedAt: new Date().toISOString(), stations: {} };
const FROM: Record<string, string> = { RCSS: "2025-08", RJTT: "2026-03" }; // RCSS: also cover the IEM outage
for (const st of Object.values(STATIONS)) {
  const t0 = Date.now();
  const obs = await ogimetObs(st.icao, FROM[st.icao], new Date().toISOString().slice(0, 7));
  const og = dailyMaxima(st, obs);
  writeJson(`data/ogimet_daily_${st.icao}.json`, [...og.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => ({ date: d.date, tmaxC: d.tmaxC, nObs: d.nObs, complete: d.complete })));
  const iem = new Map<string, any>(readJson<any[]>(`data/daily_${st.icao}.json`).map((d) => [d.date, d]));
  const evs = (await seriesEvents(st.polymarketSeriesId)).filter((e) => e.closed && e.winner && settlementSourceOf(e, st.icao).kind === "station");
  let pmMatch = 0, pmMis = 0, pmNo = 0, agree = 0, disagree = 0, both = 0;
  const mism: any[] = [], dis: any[] = [];
  for (const ev of evs) {
    const o = og.get(ev.date);
    if (!o || !o.complete) { pmNo++; continue; }
    const hit = o.tmaxC! >= ev.winner!.lo && o.tmaxC! <= ev.winner!.hi;
    hit ? pmMatch++ : (pmMis++, mism.push({ date: ev.date, ogimet: o.tmaxC, winner: ev.winner!.label }));
  }
  for (const [d, o] of og) {
    const i = iem.get(d);
    if (!i || !i.complete || !o.complete) continue;
    both++;
    i.tmaxC === o.tmaxC ? agree++ : (disagree++, dis.push({ date: d, iem: i.tmaxC, ogimet: o.tmaxC }));
  }
  const outage = [...og.values()].filter((o) => o.complete && !(iem.get(o.date)?.complete)).map((o) => o.date);
  const res = { ogimetObs: obs.length, ogimetDays: og.size, ogimetCompleteDays: [...og.values()].filter((o) => o.complete).length,
    vsPolymarket: { n: evs.length, match: pmMatch, mismatch: pmMis, noData: pmNo, mismatches: mism },
    vsIem: { bothComplete: both, agree, disagree, disagreements: dis },
    daysOgimetCompleteButIemNot: { n: outage.length, first: outage[0], last: outage.at(-1) }, ms: Date.now() - t0 };
  out.stations[st.icao] = res;
  console.log(`[${st.icao}] ogimet ${obs.length} reports, ${res.ogimetCompleteDays}/${og.size} complete days, ${res.ms} ms`);
  console.log(`   vs Polymarket winners: ${pmMatch} match, ${pmMis} mismatch, ${pmNo} no data  ${JSON.stringify(mism)}`);
  console.log(`   vs IEM (both complete): ${agree}/${both} agree  ${JSON.stringify(dis.slice(0, 10))}`);
  console.log(`   days Ogimet complete but IEM not: ${outage.length} (${outage[0]} .. ${outage.at(-1)})`);
}
writeJson("results/ogimet_check.json", out);
