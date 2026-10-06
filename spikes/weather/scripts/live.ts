// Live forecast ladder for tomorrow (lead-1 calibration) and the day after (lead-2), vs live Polymarket.
// Usage: node scripts/live.ts [RCSS|RJTT ...]
import { fetchJson, readJson, writeJson } from "../src/http.ts";
import { ENS_MODELS, liveDetTmax, liveEnsembleTmax, previousRunsTmax } from "../src/openmeteo.ts";
import { Phi, ladder, pointForecast, walkForward, type Cfg, type Obs } from "../src/forecast.ts";
import { eventSlug, parseBucket } from "../src/polymarket.ts";
import { STATIONS, addDays, dateRange, localDateOf } from "../src/stations.ts";
import { awcObs, summarizeDay } from "../src/obs.ts";

const CFG: Cfg = readJson("results/backtest.json").cfg;
const want = process.argv.slice(2).filter((a) => STATIONS[a]);
const out: any = { generatedAt: new Date().toISOString(), cfg: CFG, stations: {} };

async function polymarketLive(city: string, date: string) {
  const r = await fetchJson<any[]>(`https://gamma-api.polymarket.com/events?slug=${eventSlug(city, date)}`, { ttlSec: 300 });
  if (!r.length) return null;
  const e = r[0];
  const bs = (e.markets as any[])
    .map((m) => {
      const pb = parseBucket(m.groupItemTitle)!;
      const bid = Number(m.bestBid), ask = Number(m.bestAsk);
      const mid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : Number(JSON.parse(m.outcomePrices)[0]);
      return { label: m.groupItemTitle, lo: pb.lo, hi: pb.hi, bid, ask, mid, liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0) };
    })
    .sort((a, b) => a.lo - b.lo);
  const sum = bs.reduce((s, b) => s + b.mid, 0);
  const lad: Record<number, number> = {};
  for (const b of bs) if (Number.isFinite(b.lo)) lad[b.lo] = bs.filter((x) => x.lo >= b.lo).reduce((s, x) => s + x.mid, 0) / sum;
  return { slug: e.slug, volume: Math.round(Number(e.volume)), sumMid: +sum.toFixed(3), buckets: bs, ladder: lad };
}

for (const st of Object.values(STATIONS).filter((s) => !want.length || want.includes(s.icao))) {
  const nowMs = Date.now();
  const todayLocal = localDateOf(nowMs, st.utcOffsetMin);
  const yesterday = addDays(todayLocal, -1);
  const daily = readJson<any[]>(`data/daily_${st.icao}.json`);
  const obs: Obs = new Map(daily.filter((d) => d.complete && d.tmaxC !== null && d.date < todayLocal).map((d) => [d.date, d.tmaxC]));
  // today's observed max so far (context; AWC is the fresher source)
  const awcToday = (await awcObs(st.icao, 2)).filter((o) => localDateOf(o.tUtc, st.utcOffsetMin) === todayLocal);
  const today = summarizeDay(st, todayLocal, awcToday);

  const det = await liveDetTmax(st, 4);
  const ens = await liveEnsembleTmax(st, 4);
  const res: any = { todayLocal, observedSoFar: { tmaxC: today.tmaxC, nObs: today.nObs, lastLocal: today.lastLocal }, days: {} };
  for (const [lead, date] of [[1, addDays(todayLocal, 1)], [2, addDays(todayLocal, 2)]] as const) {
    const hist = await previousRunsTmax(st, lead, "2024-01-01", yesterday);
    const wf = walkForward(dateRange("2024-01-01", yesterday), obs, hist, CFG);
    const pts = new Map(wf.map((r) => [r.date, r.point]));
    // live point forecast for `date`, calibrated with lead-L history
    const todayF = new Map<string, number>();
    for (const [m, s] of det.tmax) if (s.get(date) !== undefined) todayF.set(m, s.get(date)!);
    const p = pointForecast(date, todayF, obs, hist, CFG)!;
    const resid: number[] = [], spreads: number[] = [];
    for (let d = yesterday; resid.length < CFG.residWindow && d > "2024-01-01"; d = addDays(d, -1)) {
      const q = pts.get(d), y = obs.get(d);
      if (q && y !== undefined) (resid.push(y - q.mu), spreads.push(q.spread));
    }
    const dr = { resid, spreads };
    const pm = await polymarketLive(st.city, date);
    const center = Math.round(p.mu);
    const ks = pm ? Object.keys(pm.ladder).map(Number) : Array.from({ length: 9 }, (_, i) => center - 4 + i);
    const model = ladder(p, dr, ks, CFG);
    // ensemble members, bias-corrected with their deterministic sibling's lead-L bias (not separately calibrated)
    const memb: number[] = [];
    const ensCounts: Record<string, number> = {};
    for (const [em, sib] of Object.entries(ENS_MODELS)) {
      const ms = ens.members.get(em)?.get(date) ?? [];
      ensCounts[em] = ms.length;
      const b = p.bias[sib] ?? 0;
      for (const x of ms) memb.push(x - b);
    }
    const ensLadder = Object.fromEntries(ks.map((k) => [k, memb.reduce((s, x) => s + (1 - Phi((k - 0.5 - x) / CFG.bandwidth)), 0) / memb.length]));
    const q = (arr: number[], f: number) => [...arr].sort((a, b) => a - b)[Math.floor(f * (arr.length - 1))];
    res.days[date] = {
      lead,
      mu: +p.mu.toFixed(2),
      modelSpread: +p.spread.toFixed(2),
      nModels: p.nModels,
      corrected: Object.fromEntries(Object.entries(p.corrected).map(([m, v]) => [m, +v.toFixed(2)])),
      bias: Object.fromEntries(Object.entries(p.bias).map(([m, v]) => [m, +v.toFixed(2)])),
      residSd: +Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / resid.length).toFixed(2),
      ensemble: { members: memb.length, perModel: ensCounts, p10: +q(memb, 0.1).toFixed(2), p50: +q(memb, 0.5).toFixed(2), p90: +q(memb, 0.9).toFixed(2) },
      ladder: ks.map((k) => ({ k, model: +model[k].toFixed(3), ensembleRaw: +ensLadder[k].toFixed(3), polymarket: pm ? +pm.ladder[k].toFixed(3) : null, edge: pm ? +(model[k] - pm.ladder[k]).toFixed(3) : null })),
      polymarket: pm,
    };
    console.log(`\n[${st.icao}] ${date} (lead ${lead})  mu=${p.mu.toFixed(2)}°C  model spread ${p.spread.toFixed(2)}  resid sd ${res.days[date].residSd}  ens(${memb.length}) p10/50/90 ${res.days[date].ensemble.p10}/${res.days[date].ensemble.p50}/${res.days[date].ensemble.p90}  PM ${pm ? pm.slug + " vol $" + pm.volume : "no market yet"}`);
    console.log("   k   P_model  P_ens   P_PM    edge");
    for (const r of res.days[date].ladder) console.log(`  ${String(r.k).padStart(2)}   ${r.model.toFixed(3)}   ${r.ensembleRaw.toFixed(3)}   ${r.polymarket?.toFixed(3) ?? "  -  "}   ${r.edge === null ? "" : (r.edge >= 0 ? "+" : "") + r.edge.toFixed(3)}`);
  }
  console.log(`[${st.icao}] today ${todayLocal} observed max so far ${today.tmaxC}°C (${today.nObs} AWC reports, last ${today.lastLocal} local)`);
  out.stations[st.icao] = res;
}
const file = writeJson(`results/live_${new Date().toISOString().slice(0, 13).replace("T", "_")}Z.json`, out);
writeJson("results/live_latest.json", out);
console.log("\nwrote", file);
