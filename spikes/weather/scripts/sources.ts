// Source agreement: IEM ASOS archive vs aviationweather.gov METAR API, per local day, last ~15 days.
// Usage: node scripts/sources.ts
import { awcObs, dailyMaxima, iemObs } from "../src/obs.ts";
import { STATIONS, addDays } from "../src/stations.ts";
import { writeJson } from "../src/http.ts";

const today = new Date().toISOString().slice(0, 10);
const out: any = { generatedAt: new Date().toISOString(), stations: {} };
for (const st of Object.values(STATIONS)) {
  const t0 = Date.now();
  const awc = await awcObs(st.icao, 16);
  const tAwc = Date.now() - t0;
  const iem = await iemObs(st.icao, addDays(today, -20), addDays(today, 1));
  const dA = dailyMaxima(st, awc);
  const dI = dailyMaxima(st, iem);
  // per-report agreement on overlapping timestamps
  const iemByT = new Map(iem.map((o) => [o.tUtc, o]));
  let both = 0, sameTemp = 0;
  const diffs: any[] = [];
  for (const o of awc) {
    const i = iemByT.get(o.tUtc);
    if (!i) continue;
    both++;
    if (i.tempC === o.tempC) sameTemp++;
    else diffs.push({ t: new Date(o.tUtc).toISOString(), awc: o.raw, iem: i.raw });
  }
  const awcOnly = awc.filter((o) => !iemByT.has(o.tUtc)).map((o) => o.raw);
  const awcT = new Set(awc.map((o) => o.tUtc));
  const awcFirst = awc[0]?.tUtc ?? Infinity;
  const iemOnly = iem.filter((o) => o.tUtc >= awcFirst && !awcT.has(o.tUtc)).map((o) => o.raw);
  const days = [...dA.keys()].filter((d) => dI.has(d)).sort();
  const rows = days.map((d) => {
    const a = dA.get(d)!, i = dI.get(d)!;
    return { date: d, awc: a.tmaxC, iem: i.tmaxC, agree: a.tmaxC === i.tmaxC, awcComplete: a.complete, iemComplete: i.complete, awcN: a.nObs, iemN: i.nObs, awcSpeci: awc.filter((o) => o.kind === "SPECI").length };
  });
  const full = rows.filter((r) => r.awcComplete && r.iemComplete);
  const res = {
    awcObs: awc.length, awcFetchMs: tAwc, awcSpeci: awc.filter((o) => o.kind === "SPECI").length,
    reportsInBoth: both, reportsSameTemp: sameTemp, tempDiffs: diffs, awcOnly, iemOnlyInAwcWindow: iemOnly,
    completeDays: full.length, completeDaysAgree: full.filter((r) => r.agree).length, rows,
  };
  out.stations[st.icao] = res;
  console.log(`[${st.icao}] AWC ${awc.length} reports (${res.awcSpeci} SPECI) in ${tAwc} ms; matched-by-time ${both}, same temp ${sameTemp}; AWC-only ${awcOnly.length}; IEM-only ${iemOnly.length}`);
  for (const r of rows) console.log(`   ${r.date} awc=${r.awc} iem=${r.iem} ${r.agree ? "AGREE" : "DIFF "} complete(awc/iem)=${r.awcComplete}/${r.iemComplete} n=${r.awcN}/${r.iemN}`);
  if (awcOnly.length) console.log("   AWC-only:", awcOnly.slice(0, 5));
  if (iemOnly.length) console.log("   IEM-only:", iemOnly.slice(0, 5));
}
writeJson("results/source_agreement.json", out);
