// Close-time analysis over 2 years of METAR+SPECI (IEM archive; RCSS's 2025-09..2026-02 IEM outage is filled from
// Ogimet, which agreed with IEM on 272/272 complete RCSS days). Writes results/close_time.json.
//   node scripts/close-time.ts [FROM=2024-10-01] [TO=2026-09-30]
import { iemObs, ogimetObs, type Obs } from "../src/obs.ts";
import { buildPaths, closeTimeStats, recommendClose, type CloseTimeStats } from "../src/closetime.ts";
import { stats as httpStats, writeJson } from "../src/http.ts";
import { addDays, station } from "../src/stations.ts";

const FROM = process.argv[2] ?? "2024-10-01";
const TO = process.argv[3] ?? "2026-09-30";
const out: any = { generatedAt: new Date().toISOString(), from: FROM, to: TO, method: "first local time each complete day's integer max is reached; METAR+SPECI incl. :30 reports; complete = >=20 local hours and a report at/after 23:00", stations: {}, recommendations: {} };

for (const icao of ["RCSS", "RJTT"]) {
  const st = station(icao);
  // same chunk URLs as the weather spike (2024-01-01 .. 2026-10-07) so its cache seeds ours; window filtered below
  const iem = await iemObs(icao, "2024-01-01", "2026-10-07", true);
  const sources: { name: string; obs: Obs[] }[] = [{ name: "iem", obs: iem }];
  if (icao === "RCSS") sources.push({ name: "ogimet", obs: await ogimetObs(icao, "2025-08", "2026-10", true) });
  const paths = buildPaths(st, FROM, TO, sources);
  const s: CloseTimeStats = closeTimeStats(icao, FROM, TO, paths);
  out.stations[icao] = s;
  const recs: Record<string, unknown> = {};
  for (let m = 1; m <= 12; m++) recs[String(m).padStart(2, "0")] = recommendClose(s, m);
  out.recommendations[icao] = recs;

  const expected = Math.round((Date.parse(TO) - Date.parse(FROM)) / 86_400_000) + 1;
  console.log(`\n[${icao}] ${s.days}/${expected} complete local days ${FROM}..${TO}  (by source ${JSON.stringify(s.daysBySource)})`);
  console.log(`  daily max first reached by:  50% ${s.t50}  90% ${s.t90}  95% ${s.t95}  99% ${s.t99}  99.5% ${s.t995}  (latest ${s.latestFirstMax})`);
  for (const [name, v] of Object.entries(s.bySeason)) console.log(`  ${name.padEnd(15)} ${String(v.days).padStart(3)} days   90% ${v.t90}  95% ${v.t95}  99% ${v.t99}`);
  console.log("  local time | P(max still rises after) | P(rises >=1C) >=2C >=3C");
  for (const h of s.hourly.filter((x) => x.until >= "10:00" && x.until <= "22:00"))
    console.log(`     ${h.until}  |  ${(h.massLeft * 100).toFixed(1).padStart(5)}%                 |  ${(h.inc1 * 100).toFixed(1).padStart(5)}% ${(h.inc2 * 100).toFixed(1).padStart(5)}% ${(h.inc3 * 100).toFixed(1).padStart(5)}%`);
  const oct = recommendClose(s, 10);
  console.log(`  recommendation (October): vault closeTime ${oct.closeLocal} local, maker stops quoting ${oct.stopQuotingLocal}; P(max rises after close) = ${(oct.massLeftAtClose * 100).toFixed(2)}% [${oct.basis}]`);
  void addDays;
}
const file = writeJson("results/close_time.json", out);
console.log(`\nwrote ${file}  (http cache: ${JSON.stringify(httpStats)})`);
