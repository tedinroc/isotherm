// Live view for one station-date: Polymarket-implied ladder (CLOB best bid/ask), observed max so far, v0 guard,
// fair values, the strikes a roll would pick, and the recommended close.  node scripts/ladder.ts RCSS 2026-10-08
import { livePolymarketLadder, pickStrikes } from "../src/polymarket.ts";
import { observedMaxSoFar } from "../src/obs.ts";
import { v0Ladder } from "../src/v0.ts";
import { computeFairs } from "../src/fair.ts";
import { closeFor, loadCloseTime } from "../src/close-config.ts";
import { localDateOf, localDayUtcRange, station } from "../src/stations.ts";
import { writeJson } from "../src/http.ts";

const icao = (process.argv[2] ?? "RCSS").toUpperCase();
const st = station(icao);
const now = Date.now();
const date = process.argv[3] ?? localDateOf(now + 86_400_000, st.utcOffsetMin);
const pm = await livePolymarketLadder(icao, date);
const obs = await observedMaxSoFar(icao, date, now);
let v0 = null;
try { v0 = await v0Ladder(icao, date, now); } catch (e) { console.log("v0 unavailable:", String(e).slice(0, 160)); }
const strikes = process.argv[4] ? process.argv[4].split(",").map(Number) : pm ? pickStrikes(pm) : [];
const [start] = localDayUtcRange(date, st.utcOffsetMin);
const localMinute = now >= start && now < start + 86_400_000 ? Math.floor((now - start) / 60_000) : null;
const fairs = computeFairs({ strikes, nowMs: now, localMinute, pm, pmFetchedMs: pm ? Date.parse(pm.fetchedAt) : null, obs, v0, intraday: loadCloseTime()?.stations[icao] ?? null });
const close = closeFor(icao, date);
console.log(`${icao} ${date}  Polymarket ${pm ? `${pm.url} vol $${pm.volume} sum ${pm.sumRaw} quotes=${pm.quoteSource} ok=${pm.ok} median ${pm.median} mean ${pm.mean} sd ${pm.sd}` : "no event"}`);
if (pm?.warnings.length) console.log("  warnings:", pm.warnings.join("; "));
if (pm) for (const b of pm.buckets) console.log(`  ${b.label.padEnd(16)} bid ${String(b.bestBid ?? "-").padEnd(6)} ask ${String(b.bestAsk ?? "-").padEnd(6)} -> ${b.price.toFixed(4)} (${b.priceSource}${b.illiquid ? ", illiquid" : ""})  p=${b.p.toFixed(4)}`);
console.log(`  observed max so far: ${obs.tmaxC ?? "-"}°C (${obs.nObs} reports, last ${obs.lastLocal ?? "-"} local)  v0: ${v0 ? `mu ${v0.mu} lead ${v0.lead}` : "-"}`);
console.log(`  close: vault ${close.closeLocal} local, maker stops ${close.stopQuotingLocal}  (${close.basis})`);
console.log("   k   PM      PMcond  guard   fair    source       flags");
for (const f of fairs) console.log(`  ${String(f.k).padStart(2)}   ${f.pm?.toFixed(3) ?? "  -  "}   ${f.pmCond?.toFixed(3) ?? "  -  "}   ${f.guard?.toFixed(3) ?? "  -  "}   ${f.fair?.toFixed(3) ?? "  -  "}   ${f.source.padEnd(12)} ${f.flags.join(",")}`);
writeJson(`results/live_${icao}_${date}.json`, { generatedAt: new Date(now).toISOString(), pm, obs, v0, strikes, fairs, close });
