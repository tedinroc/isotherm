// node scripts/settle.ts RCSS 2026-10-05 [more dates...]  -> SETTLED / PENDING / VOID with per-source detail
import { tmaxC } from "../src/settlement.ts";
const [icao, ...dates] = process.argv.slice(2);
for (const d of dates) {
  const s = await tmaxC(icao, d);
  console.log(`${s.station} ${s.date} ${s.status} tmaxC=${s.tmaxC}  ${s.sources.map((x) => `${x.source}=${x.tmaxC}(n=${x.nObs},complete=${x.complete},last=${x.lastLocal})`).join(" ")}  [${s.reason}]`);
}
