// CLI: node scripts/settle.ts RCSS 2026-10-05 [more dates...]
// Prints the settlement result exactly as the CRE workflow would compute it (same URLs, same rule).
import { tmaxC } from "../src/settlement.ts";
import { stats } from "../src/http.ts";

const [icao = "RCSS", ...dates] = process.argv.slice(2);
for (const d of dates.length ? dates : [new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)]) {
  const t0 = Date.now();
  const s = await tmaxC(icao, d);
  const src = s.sources.map((x) => `${x.source}=${x.tmaxC}(n=${x.nObs},complete=${x.complete},last=${x.lastLocal})`).join(" ");
  console.log(`${s.station} ${s.date} ${s.status} tmaxC=${s.tmaxC}  ${src}  [${s.reason}] ${Date.now() - t0}ms`);
}
console.error("cache", stats);
