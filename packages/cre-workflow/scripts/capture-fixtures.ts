// Captures real IEM / aviationweather.gov / Ogimet responses for golden fixtures, using the EXACT URLs the
// workflow requests (settle-core.ts). Polite: sequential, 2 s apart, one request per source per station-date.
//   node scripts/capture-fixtures.ts RCSS:2026-10-06 RJTT:2026-10-06 [--ogimet]
// Writes settle/fixtures/{iem,awc,ogimet}_<ICAO>_<date>.* and appends to settle/fixtures/MANIFEST.json.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { awcDayUrl, iemDayUrl, ogimetDayUrl } from "../settle/settle-core.ts";

const STATIONS: Record<string, { off: number; tz: string }> = {
  RCSS: { off: 480, tz: "Asia/Taipei" },
  RJTT: { off: 540, tz: "Asia/Tokyo" },
};
const dir = new URL("../settle/fixtures/", import.meta.url);
const manifestUrl = new URL("MANIFEST.json", dir);
const manifest: Record<string, unknown> = existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, "utf8")) : {};
const withOgimet = process.argv.includes("--ogimet");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const arg of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  const [icao, date] = arg.split(":");
  const st = STATIONS[icao];
  if (!st || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad arg ${arg} (want ICAO:YYYY-MM-DD)`);
  const jobs: [string, string, string][] = [
    ["iem", iemDayUrl(icao, date, st.tz), `iem_${icao}_${date}.csv`],
    ["awc", awcDayUrl(icao, date, st.off), `awc_${icao}_${date}.json`],
  ];
  if (withOgimet) jobs.push(["ogimet", ogimetDayUrl(icao, date, st.off), `ogimet_${icao}_${date}.txt`]);
  for (const [src, url, file] of jobs) {
    const t0 = Date.now();
    const res = await fetch(url, { headers: { "user-agent": "isotherm-cre-fixtures/1.0 (testnet research)" } });
    const body = await res.text();
    if (res.status !== 200) throw new Error(`${src} ${url} -> HTTP ${res.status}`);
    writeFileSync(new URL(file, dir), body);
    manifest[file] = {
      url,
      fetchedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
      ms: Date.now() - t0,
    };
    console.log(`${src} ${icao} ${date}: ${Buffer.byteLength(body)} B in ${Date.now() - t0} ms -> ${file}`);
    await sleep(2000);
  }
}
writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");
