// Calibration backtest. Usage: node scripts/backtest.ts
// 1) Choose hyper-parameters on a validation period that ends before the first Polymarket market.
// 2) Freeze them and score the Polymarket days: our causal forecasts vs Polymarket-implied ladders.
import { readJson, writeJson } from "../src/http.ts";
import { DET_MODELS, previousRunsTmax } from "../src/openmeteo.ts";
import { DEFAULT_CFG, ladder, walkForward, type Cfg, type Fc, type Obs } from "../src/forecast.ts";
import { brier, fitLogistic, logLoss, pairedBootstrap, predictLogistic, reliability, type Eval } from "../src/score.ts";
import { STATIONS, addDays, dateRange } from "../src/stations.ts";

const HIST_FROM = "2024-01-01";
const VALID_FROM = "2024-06-01"; // after warm-up (bias 60-90d + residual 90d)
const VALID_TO = "2026-03-09"; // last day before the first Polymarket event (RJTT 2026-03-10, RCSS 2026-03-16)
const LAST = addDays(new Date().toISOString().slice(0, 10), -1);
const RPS_K = Array.from({ length: 41 }, (_, i) => i + 2); // 2..42 °C

interface StData { obs: Obs; fc: Record<1 | 2, Fc>; pm: any[] }
const data: Record<string, StData> = {};
for (const st of Object.values(STATIONS)) {
  const daily = readJson<any[]>(`data/daily_${st.icao}.json`);
  const obs: Obs = new Map(daily.filter((d) => d.complete && d.tmaxC !== null).map((d) => [d.date, d.tmaxC]));
  const fc1 = await previousRunsTmax(st, 1, HIST_FROM, LAST);
  const fc2 = await previousRunsTmax(st, 2, HIST_FROM, LAST);
  data[st.icao] = { obs, fc: { 1: fc1, 2: fc2 }, pm: readJson<any[]>(`data/pm_ladders_${st.icao}.json`) };
  console.log(`[${st.icao}] obs days ${obs.size}; lead1 model-days ${[...fc1.values()].reduce((s, m) => s + m.size, 0)}; lead2 ${[...fc2.values()].reduce((s, m) => s + m.size, 0)}; pm events ${data[st.icao].pm.length}`);
}

// ------------------------------------------------------------------ 1) validation grid
const grid: Cfg[] = [];
for (const biasWindow of [30, 60, 90])
  for (const weighting of ["equal", "invmse"] as const)
    for (const [dist, bandwidth] of [["empirical", 0.35], ["empirical", 0.6], ["gaussian", 0]] as const)
      for (const spreadScale of [false, true])
        grid.push({ ...DEFAULT_CFG, biasWindow, weighting, dist, bandwidth: bandwidth || 0.5, spreadScale, residWindow: 90 });

const rps = (lad: Record<number, number>, y: number) => RPS_K.reduce((s, k) => s + (lad[k] - (y >= k ? 1 : 0)) ** 2, 0);
const allDates = dateRange(HIST_FROM, LAST);
const validation = grid.map((cfg) => {
  let sum = 0, n = 0;
  const per: Record<string, number> = {};
  for (const [icao, d] of Object.entries(data))
    for (const lead of [1, 2] as const) {
      let s = 0, c = 0;
      for (const r of walkForward(allDates, d.obs, d.fc[lead], cfg)) {
        if (r.date < VALID_FROM || r.date > VALID_TO) continue;
        const y = d.obs.get(r.date);
        if (y === undefined || r.dressing.resid.length < 30) continue;
        s += rps(ladder(r.point, r.dressing, RPS_K, cfg), y);
        c++;
      }
      per[`${icao}_L${lead}`] = +(s / c).toFixed(4);
      sum += s;
      n += c;
    }
  return { cfg, rpsPooled: +(sum / n).toFixed(4), n, per };
});
validation.sort((a, b) => a.rpsPooled - b.rpsPooled);
const CFG = validation[0].cfg;
console.log("validation top 5 (pooled RPS over k=2..42, lower is better):");
for (const v of validation.slice(0, 5)) console.log(" ", v.rpsPooled, JSON.stringify(v.cfg), JSON.stringify(v.per));
console.log("validation worst:", validation.at(-1)!.rpsPooled, JSON.stringify(validation.at(-1)!.cfg));

// ------------------------------------------------------------------ 2) test on Polymarket days
const results: any = { generatedAt: new Date().toISOString(), cfg: CFG, validationPeriod: [VALID_FROM, VALID_TO], validationTop: validation.slice(0, 8), validationGridSize: grid.length, stations: {} };
const pooled: Record<string, Eval[]> = {};
// pooled evals are keyed "<ICAO>:<date>" so the day-block bootstrap resamples station-days
const push = (icao: string, name: string, es: Eval[]) => (pooled[name] ??= []).push(...es.map((e) => ({ ...e, date: `${icao}:${e.date}` })));

for (const [icao, d] of Object.entries(data)) {
  const wf = { 1: new Map(walkForward(allDates, d.obs, d.fc[1], CFG).map((r) => [r.date, r])), 2: new Map(walkForward(allDates, d.obs, d.fc[2], CFG).map((r) => [r.date, r])) };
  const E: Record<string, Eval[]> = {};
  const add = (name: string, date: string, k: number, p: number, y: number) => (E[name] ??= []).push({ date, k, p, y: y >= k ? 1 : 0 });
  const detErr: Record<string, number[]> = {};
  let usedDays = 0;
  const skipped: any[] = [];
  const dayRows: any[] = [];
  for (const ev of d.pm) {
    const y = d.obs.get(ev.date);
    const s12 = ev.snaps["D-1 12:00"], s23 = ev.snaps["D-1 23:00"], s08 = ev.snaps["D 08:00"];
    const r1 = wf[1].get(ev.date), r2 = wf[2].get(ev.date);
    if (y === undefined || !s12 || !s23 || !s08 || !r1 || !r2) {
      skipped.push({ date: ev.date, why: { obs: y !== undefined, s12: !!s12, s23: !!s23, s08: !!s08, L1: !!r1, L2: !!r2 } });
      continue;
    }
    usedDays++;
    const ks = Object.keys(s23.ladder).map(Number).sort((a, b) => a - b);
    const m1 = ladder(r1.point, r1.dressing, ks, CFG), m2 = ladder(r2.point, r2.dressing, ks, CFG);
    // climatology: trailing 30 complete days ending D-2
    const clim: number[] = [];
    for (let i = 2; i < 32; i++) {
      const v = d.obs.get(addDays(ev.date, -i));
      if (v !== undefined) clim.push(v);
    }
    for (const k of ks) {
      add("model_L2", ev.date, k, m2[k], y);
      add("model_L1", ev.date, k, m1[k], y);
      add("pm_D-1_12", ev.date, k, s12.ladder[k], y);
      add("pm_D-1_23", ev.date, k, s23.ladder[k], y);
      add("pm_D_08", ev.date, k, s08.ladder[k], y);
      add("clim30", ev.date, k, (clim.filter((v) => v >= k).length + 0.5) / (clim.length + 1), y);
      add("blend_L2+pm12", ev.date, k, (m2[k] + s12.ladder[k]) / 2, y);
      add("blend_L1+pm23", ev.date, k, (m1[k] + s23.ladder[k]) / 2, y);
    }
    for (const [name, r] of [["mu_L1", r1], ["mu_L2", r2]] as const) (detErr[name] ??= []).push(r.point.mu - y);
    for (const m of DET_MODELS) {
      const x1 = d.fc[1].get(m)?.get(ev.date);
      if (x1 !== undefined) (detErr[`raw_L1_${m}`] ??= []).push(x1 - y);
    }
    dayRows.push({ date: ev.date, y, mu1: +r1.point.mu.toFixed(2), mu2: +r2.point.mu.toFixed(2), winner: ev.winner, pmMedian23: ks.find((k) => s23.ladder[k] < 0.5) });
  }
  // causal stacking: for day D, fit on strike-evals of the trailing STACK_WIN days with date <= D-2, predict D
  const STACK_WIN = 60, STACK_MIN_DAYS = 30;
  const stackDefs: [string, string[]][] = [
    ["pmRecal_23", ["pm_D-1_23"]],
    ["stack_pm23+L1", ["pm_D-1_23", "model_L1"]],
    ["pmRecal_12", ["pm_D-1_12"]],
    ["stack_pm12+L2", ["pm_D-1_12", "model_L2"]],
  ];
  const byDate = (name: string) => {
    const m = new Map<string, Eval[]>();
    for (const e of E[name]) (m.get(e.date) ?? m.set(e.date, []).get(e.date)!).push(e);
    return m;
  };
  const stackFits: any = {};
  for (const [sname, inputs] of stackDefs) {
    const cols = inputs.map(byDate);
    const dates = [...cols[0].keys()].sort();
    const out: Eval[] = [];
    for (const D of dates) {
      const cutoff = addDays(D, -2);
      const train = dates.filter((d) => d <= cutoff).slice(-STACK_WIN);
      if (train.length < STACK_MIN_DAYS) continue;
      const X: number[][] = [], y: number[] = [];
      for (const d of train) cols[0].get(d)!.forEach((e, i) => (X.push(cols.map((c) => c.get(d)![i].p)), y.push(e.y)));
      const w = fitLogistic(X, y);
      stackFits[sname] = w.map((v) => +v.toFixed(3)); // last fit, for the record
      cols[0].get(D)!.forEach((e, i) => out.push({ ...e, p: predictLogistic(w, cols.map((c) => c.get(D)![i].p)) }));
    }
    E[sname] = out;
  }
  // compare stacks on the same (later) days only
  const stackDays = new Set(E["stack_pm23+L1"].map((e) => e.date));
  const onStackDays = (n: string) => E[n].filter((e) => stackDays.has(e.date));
  const stackCompare = {
    days: stackDays.size,
    "pmRecal_23 vs pm_D-1_23 (Brier)": pairedBootstrap(E["pmRecal_23"], onStackDays("pm_D-1_23"), brier),
    "stack_pm23+L1 vs pm_D-1_23 (Brier)": pairedBootstrap(E["stack_pm23+L1"], onStackDays("pm_D-1_23"), brier),
    "stack_pm23+L1 vs pmRecal_23 (Brier)": pairedBootstrap(E["stack_pm23+L1"], E["pmRecal_23"].filter((e) => stackDays.has(e.date)), brier),
    "stack_pm12+L2 vs pm_D-1_12 (Brier)": pairedBootstrap(E["stack_pm12+L2"], onStackDays("pm_D-1_12").filter((e) => E["stack_pm12+L2"].some((x) => x.date === e.date)), brier),
    lastFits: stackFits,
  };
  const table = Object.fromEntries(Object.entries(E).map(([n, es]) => [n, { brier: +brier(es).toFixed(4), logLoss: +logLoss(es).toFixed(4), n: es.length }]));
  const det = Object.fromEntries(Object.entries(detErr).map(([n, es]) => [n, { mae: +(es.reduce((s, e) => s + Math.abs(e), 0) / es.length).toFixed(3), bias: +(es.reduce((s, e) => s + e, 0) / es.length).toFixed(3), n: es.length }]));
  const exact1 = dayRows.filter((r) => Math.round(r.mu1) === r.y).length;
  const cmp = {
    "model_L2 vs pm_D-1_12 (Brier)": pairedBootstrap(E["model_L2"], E["pm_D-1_12"], brier),
    "model_L1 vs pm_D-1_23 (Brier)": pairedBootstrap(E["model_L1"], E["pm_D-1_23"], brier),
    "blend_L1+pm23 vs pm_D-1_23 (Brier)": pairedBootstrap(E["blend_L1+pm23"], E["pm_D-1_23"], brier),
    "model_L1 vs pm_D-1_23 (logloss)": pairedBootstrap(E["model_L1"], E["pm_D-1_23"], (es) => logLoss(es)),
  };
  results.stations[icao] = {
    days: usedDays, skipped, table, compare: cmp, deterministic: det,
    exactIntegerHitRate_L1: +(exact1 / dayRows.length).toFixed(3),
    stackCompare,
    reliability: { model_L1: reliability(E["model_L1"]), "pm_D-1_23": reliability(E["pm_D-1_23"]) },
    dayRows,
  };
  for (const [n, es] of Object.entries(E)) push(icao, n, es);
  console.log(`\n[${icao}] test days ${usedDays} (skipped ${skipped.length}), strike-evals ${E["model_L1"].length}`);
  for (const [n, t] of Object.entries(table)) console.log(`   ${n.padEnd(16)} Brier ${t.brier.toFixed(4)}  logloss ${t.logLoss.toFixed(4)}`);
  for (const [n, c] of Object.entries(cmp)) console.log(`   ${n.padEnd(38)} diff ${c.diff} CI95 [${c.ci95}] P(A better) ${c.pAbetter}`);
  for (const [n, c] of Object.entries<any>(stackCompare)) if (c && c.ci95) console.log(`   ${n.padEnd(38)} diff ${c.diff} CI95 [${c.ci95}] P(A better) ${c.pAbetter} days ${c.days}`);
  console.log(`   last stacking fits [a, b_pm, b_model]: ${JSON.stringify(stackFits)}`);
  console.log(`   deterministic MAE: mu_L1 ${det.mu_L1.mae} (bias ${det.mu_L1.bias}), mu_L2 ${det.mu_L2.mae}; exact-integer hit (round(mu_L1)==Y) ${exact1}/${dayRows.length}`);
  console.log(`   raw L1 MAE by model: ${DET_MODELS.map((m) => `${m.split("_")[0]} ${det[`raw_L1_${m}`]?.mae}`).join(", ")}`);
}
results.pooled = {
  table: Object.fromEntries(Object.entries(pooled).map(([n, es]) => [n, { brier: +brier(es).toFixed(4), logLoss: +logLoss(es).toFixed(4), n: es.length }])),
  compare: {
    "model_L2 vs pm_D-1_12 (Brier)": pairedBootstrap(pooled["model_L2"], pooled["pm_D-1_12"], brier),
    "model_L1 vs pm_D-1_23 (Brier)": pairedBootstrap(pooled["model_L1"], pooled["pm_D-1_23"], brier),
    "blend_L1+pm23 vs pm_D-1_23 (Brier)": pairedBootstrap(pooled["blend_L1+pm23"], pooled["pm_D-1_23"], brier),
    "blend_L2+pm12 vs pm_D-1_12 (Brier)": pairedBootstrap(pooled["blend_L2+pm12"], pooled["pm_D-1_12"], brier),
  },
};
console.log("\n[pooled]");
for (const [n, t] of Object.entries(results.pooled.table) as any) console.log(`   ${n.padEnd(16)} Brier ${t.brier.toFixed(4)}  logloss ${t.logLoss.toFixed(4)}  n ${t.n}`);
for (const [n, c] of Object.entries(results.pooled.compare) as any) console.log(`   ${n.padEnd(38)} diff ${c.diff} CI95 [${c.ci95}] P(A better) ${c.pAbetter} days ${c.days}`);
writeJson("results/backtest.json", results);
