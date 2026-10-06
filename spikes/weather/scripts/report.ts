// Builds results/fidelity_table.csv and results/summary.json from the other results files.
import { readJson, writeJson, ROOT } from "../src/http.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const og = readJson("results/ogimet_check.json");
const lines = ["station,date,settlement_source,polymarket_winner,iem_tmax_c,ogimet_tmax_c,match_iem,volume_usd"]; // ogimet blank = not fetched/incomplete
const summary: any = { generatedAt: new Date().toISOString(), fidelity: {}, sources: {}, backtest: {}, live: {} };
for (const icao of ["RCSS", "RJTT"]) {
  const f = readJson(`results/fidelity_${icao}.json`);
  const ogDaily = new Map<string, any>(readJson<any[]>(`data/ogimet_daily_${icao}.json`).map((d) => [d.date, d]));
  for (const r of f.rows) {
    const o = ogDaily.get(r.date);
    const ogv = o && o.complete ? o.tmaxC : "";
    lines.push([icao, r.date, r.source, `"${r.winner}"`, r.iemTmax, ogv, r.match, r.volume].join(","));
  }
  summary.fidelity[icao] = {
    stationSourced: f.rule_localDay_allReports, onCycleOnly: f.rule_localDay_onCycleOnly, hourlyOnly: f.rule_localDay_hourlyOnly, utcDay: f.rule_utcDay_allReports,
    otherSourced: f.otherSourcedEvents.length, mismatches: f.mismatches.map((m: any) => ({ date: m.date, winner: m.winner, iem: m.iemTmax })),
    offCycleSpeciDecisive: f.speciDecisiveDays, ogimetVsPolymarket: og.stations[icao].vsPolymarket, ogimetVsIem: og.stations[icao].vsIem,
  };
}
const sa = readJson("results/source_agreement.json");
for (const [k, v] of Object.entries<any>(sa.stations)) summary.sources[k] = { awcVsIemCompleteDays: `${v.completeDaysAgree}/${v.completeDays}`, reportsSameTemp: `${v.reportsSameTemp}/${v.reportsInBoth}` };
const bt = readJson("results/backtest.json");
summary.backtest = { cfg: bt.cfg, pooled: bt.pooled, perStation: Object.fromEntries(Object.entries<any>(bt.stations).map(([k, v]) => [k, { days: v.days, table: v.table, compare: v.compare, mae: { mu_L1: v.deterministic.mu_L1, mu_L2: v.deterministic.mu_L2 } }])) };
const live = readJson("results/live_latest.json");
summary.live = { generatedAt: live.generatedAt, stations: Object.fromEntries(Object.entries<any>(live.stations).map(([k, v]) => [k, Object.fromEntries(Object.entries<any>(v.days).map(([d, x]) => [d, { mu: x.mu, ladder: x.ladder, pmVolume: x.polymarket?.volume }]))])) };
writeFileSync(join(ROOT, "results/fidelity_table.csv"), lines.join("\n") + "\n");
writeJson("results/summary.json", summary);
console.log(`fidelity_table.csv rows: ${lines.length - 1}`);
