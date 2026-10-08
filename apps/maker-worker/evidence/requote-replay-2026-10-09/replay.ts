// Re-quote spend replay (2026-10-09): how many re-quotes the shared policy sends under
//   current            requoteTicks 2, no guard-wide hysteresis (the Mac's and the Worker's settings until now)
//   hysteresis         guard-wide entered above fair.guardWarn 0.15, kept until below fair.guardWarnExit 0.13,
//                      keyed on the flag the resting quote was placed with (lastQuote.wide)
//   hysteresis + 3     the same with policy.requoteTicks 3 (the recommendation for the Worker)
//   (+ 4, and 3 without hysteresis, for sensitivity)
// It runs the repo's own computeFairs (guard flags, hysteresis), makeQuote and decide per strike, tick by tick.
// Not modelled: fills (inventory skew, refills), other participants on the Kuru books, observation conditioning
// (the observed max stayed far below every strike in these windows).
//
//   node replay.ts            (inputs: prepare.ts, plus ../shadow-compare-2026-10-08/mac-snaps.jsonl)
//
// Three data sets:
//   A. recorded: the Mac's own published snapshots (fair + guard per strike, every Mac tick), 16:33-17:26 UTC Oct 8.
//      Exact inputs, no reconstruction. The current policy must reproduce the Mac's txs here.
//   B. Oct 9 ladder, 13:47 (opening quotes) .. end of the data: fair re-built from the Polymarket CLOB minute history
//      (same formula as ladderFromGamma: normalised bucket mids, P(>=k) = sum of buckets with lower bound >= k; checked
//      against the 53 recorded ticks of A: median |diff| 0.0000, p90 <= 0.004). Ticks at the Mac's real tick times.
//      v0 guard: the Mac's published values from its 15:47:33 refresh on; before that the >=30 guard of each hourly
//      refresh is fitted to the Mac's own requotes (the other strikes are far from both thresholds).
//   C. Oct 8 ladder, Oct 7 05:57 .. Oct 8 02:20 UTC (then the Mac's 1.2 MON cap started pulling instead of
//      re-quoting): a trending day without guard flapping. Its v0 guard was not recorded, so the guard-wide flag is the
//      one the Mac's own quotes show, identical in every scenario: this set measures requoteTicks only.
import { readFileSync } from "node:fs";
import { computeFairs } from "../../../../packages/forecast/src/fair.ts";
import { decide } from "../../../../packages/maker/src/policy.ts";
import { makeQuote } from "../../../../packages/maker/src/pricing.ts";

const HERE = new URL(".", import.meta.url).pathname;
const read = (f: string) => JSON.parse(readFileSync(`${HERE}/${f}`, "utf8"));
const defaults = JSON.parse(readFileSync(`${HERE}/../../../../packages/maker/config/default.json`, "utf8"));
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 19) + "Z";
const ts = (s: string) => Date.parse(s) / 1000;

interface Scenario { name: string; requoteTicks: number; exit: number | null }
const SCENARIOS: Scenario[] = [
  { name: "current (2 ticks, no hysteresis)", requoteTicks: 2, exit: null },
  { name: "hysteresis 0.15/0.13, 2 ticks", requoteTicks: 2, exit: 0.13 },
  { name: "hysteresis + requoteTicks 3", requoteTicks: 3, exit: 0.13 },
  { name: "hysteresis + requoteTicks 4", requoteTicks: 4, exit: 0.13 },
  { name: "requoteTicks 3, no hysteresis", requoteTicks: 3, exit: null },
];

// ------------------------------------------------------------------ inputs
type Hist = { lo: number; t: number[]; p: number[] };
const PM = read("pm-history.json");
const series = (ev: string): Hist[] => PM[ev].buckets.map((b: any) => ({ lo: /or below/.test(b.label) ? -Infinity : Number(b.label.match(/^(-?\d+)/)[1]), t: b.t, p: b.p }));
function priceAt(h: Hist, t: number): number | null {
  let lo = 0, hi = h.t.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (h.t[m] <= t) (r = m), (lo = m + 1);
    else hi = m - 1;
  }
  return r < 0 ? null : h.p[r];
}
function fairFrom(bs: Hist[], t: number, k: number): number | null {
  let sum = 0, above = 0;
  for (const b of bs) {
    const p = priceAt(b, t);
    if (p === null) return null;
    sum += p;
    if (b.lo >= k) above += p;
  }
  return +(above / sum).toFixed(4);
}
interface MacTx { t: number; k: number; kind: string; bid: number | null; ask: number | null; mon: number }
const MAC: MacTx[] = read("mac-quotes.json");
const MAC_TICKS: number[] = read("mac-ticks.json");
const REQUOTE_MON = MAC.filter((x) => x.kind === "requote").reduce((s, x, _, a) => s + x.mon / a.length, 0);
const PULL_MON = 0.0281;

// ------------------------------------------------------------------ guard flags through the real computeFairs
type FlagFn = (t: number, k: number, fair: number, restingWide: boolean, sc: Scenario) => string[];
const guardFlags = (guard: (t: number, k: number) => number | null): FlagFn => (t, k, fair, restingWide, sc) => {
  const g = guard(t, k);
  if (g === null) return [];
  const pm: any = { ok: true, ladder: { [k]: fair }, strikes: [k], mean: null, sd: null };
  const [f] = computeFairs({ strikes: [k], nowMs: t * 1000, localMinute: null, pm, pmFetchedMs: t * 1000, obs: null, v0: { ladder: { [k]: g } }, intraday: null, restingWide: restingWide ? { [k]: true } : null, cfg: { ...defaults.fair, guardWarnExit: sc.exit } });
  return f.flags;
};

// ------------------------------------------------------------------ the replay
interface Ev { t: number; k: number; kind: string; urgent: boolean; bid?: number | null; ask?: number | null; wide?: boolean; reasons: string[] }
interface Init { bid: number | null; ask: number | null; fair: number; at: number; wide?: boolean }
function run(o: { strikes: number[]; ticks: number[]; fair: (t: number, k: number) => number | null; flags: FlagFn; init?: Record<number, Init>; from: number; to: number }, sc: Scenario) {
  const st: Record<number, { resting: { bid: number | null; ask: number | null } | null; lastQuote?: { fair: number; at: number; wide?: boolean }; mode: any }> = {};
  for (const k of o.strikes) {
    const i = o.init?.[k];
    st[k] = i ? { resting: { bid: i.bid, ask: i.ask }, lastQuote: { fair: i.fair, at: i.at, wide: i.wide }, mode: "quoting" } : { resting: null, mode: "pending" };
  }
  const events: Ev[] = [];
  let ticks = 0, minEdge = 1, minEdgeAt = "", staleMax = 0, staleAt = "";
  for (const t of o.ticks) {
    if (t < o.from || t >= o.to) continue;
    ticks++;
    for (const k of o.strikes) {
      const s = st[k];
      const fair = o.fair(t, k);
      if (fair === null) continue;
      const flags = o.flags(t, k, fair, !!(s.lastQuote?.wide && s.resting), sc);
      const desired = makeQuote({ fair, source: "polymarket", flags, netYes: 0, freeYes: 300, freeAusd: 400, others: { bid: null, ask: null }, cfg: defaults.quote });
      const resting: any = {};
      if (s.resting?.bid != null) resting.bid = { id: 1, price: s.resting.bid, remaining: 100 };
      if (s.resting?.ask != null) resting.ask = { id: 2, price: s.resting.ask, remaining: 100 };
      const a = decide({ now: t, stopAt: 4e9, mode: s.mode, certain: false, fair, desired, resting, lastQuote: s.lastQuote, cfg: { ...defaults.policy, requoteTicks: sc.requoteTicks, tick: defaults.quote.tick } });
      if ((a.kind === "quote" || a.kind === "requote") && !desired.pull) {
        events.push({ t, k, kind: a.kind, urgent: a.urgent, bid: desired.bid, ask: desired.ask, wide: flags.includes("guard-wide"), reasons: a.reasons });
        s.resting = { bid: desired.bid, ask: desired.ask };
        s.lastQuote = { fair, at: t, wide: flags.includes("guard-wide") };
        s.mode = "quoting";
      } else if (a.kind === "pull" || a.kind === "close") {
        events.push({ t, k, kind: "pull", urgent: a.urgent, reasons: a.reasons });
        s.resting = null;
        s.mode = a.mode ?? "pulled";
      } else if (a.mode) s.mode = a.mode;
      // what stays on the book until the next tick (prices clamped at minPrice/maxPrice are left out)
      const r = s.resting;
      if (r) {
        const bidOk = r.bid !== null && r.bid > defaults.quote.minPrice, askOk = r.ask !== null && r.ask < defaults.quote.maxPrice;
        const edge = Math.min(bidOk ? fair - r.bid! : 1, askOk ? r.ask! - fair : 1);
        if (edge < minEdge) (minEdge = edge), (minEdgeAt = `${iso(t)} >=${k} ${r.bid}/${r.ask} fair ${fair}`);
        if (bidOk && askOk) {
          const d = Math.abs((r.bid! + r.ask!) / 2 - fair);
          if (d > staleMax) (staleMax = d), (staleAt = `${iso(t)} >=${k} ${r.bid}/${r.ask} fair ${fair}`);
        }
      }
    }
  }
  return { events, ticks, minEdge, minEdgeAt, staleMax, staleAt };
}

/** the Mac's txs the replay reproduces: same strike, same prices (or a pull), within 150 s */
function calib(evs: Ev[], from: number, to: number) {
  const m = MAC.filter((x) => x.t >= from && x.t < to && x.kind !== "quote");
  const e = evs.filter((x) => x.t >= from && x.t < to && x.kind !== "quote");
  const used = new Set<number>();
  let hit = 0;
  for (const x of m) {
    const i = e.findIndex((y, j) => !used.has(j) && y.k === x.k && Math.abs(y.t - x.t) <= 150 && (x.kind === "pull" ? y.kind === "pull" : y.bid === x.bid && y.ask === x.ask));
    if (i >= 0) used.add(i), hit++;
  }
  return `${hit} of the Mac's ${m.length} txs reproduced`;
}
/** re-quotes that went back to the quote they replaced within 3 h (the review's flip-flop count) */
function flipBacks(evs: Ev[], from: number, to: number) {
  let n = 0;
  const q = evs.filter((e) => e.kind !== "pull");
  for (const e of q.filter((e) => e.kind === "requote" && e.t >= from && e.t < to)) {
    const list = q.filter((x) => x.k === e.k), i = list.indexOf(e), prev = list[i - 1];
    if (prev && list.slice(i + 1).some((x) => x.t - e.t <= 3 * 3600 && x.bid === prev.bid && x.ask === prev.ask)) n++;
  }
  return n;
}

const rows: string[][] = [];
const head = ["data", "scenario", "requotes", "pulls", "urgent", "flip-backs", "per 24 h", "MON", "MON / 24 h", "min edge", "max |mid-fair|"];
function report(data: string, sc: Scenario, r: ReturnType<typeof run>, from: number, to: number, withCalib: boolean) {
  const ev = r.events.filter((e) => e.t >= from && e.t < to && e.kind !== "quote");
  const rq = ev.filter((e) => e.kind === "requote"), pulls = ev.length - rq.length, h = (to - from) / 3600;
  const mon = rq.length * REQUOTE_MON + pulls * PULL_MON;
  rows.push([data, sc.name, String(rq.length), String(pulls), String(rq.filter((e) => e.urgent).length), String(flipBacks(r.events, from, to)), (rq.length / h * 24).toFixed(0), mon.toFixed(2), (mon / h * 24).toFixed(2), r.minEdge.toFixed(3), r.staleMax.toFixed(3)]);
  if (withCalib) rows[rows.length - 1][1] += ` [${calib(r.events, from, to)}]`;
}
function macRow(data: string, from: number, to: number) {
  const m = MAC.filter((x) => x.t >= from && x.t < to && x.kind !== "quote"), rq = m.filter((x) => x.kind === "requote"), h = (to - from) / 3600;
  const mon = m.reduce((s, x) => s + x.mon, 0);
  rows.push([data, "Mac actual (txs.jsonl)", String(rq.length), String(m.length - rq.length), "", "", (rq.length / h * 24).toFixed(0), mon.toFixed(2), (mon / h * 24).toFixed(2), "", ""]);
}
const urgentLog: string[] = [];

// ------------------------------------------------------------------ A. recorded Mac snapshots
{
  const snaps = readFileSync(`${HERE}/../shadow-compare-2026-10-08/mac-snaps.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rec = new Map<number, Record<number, { fair: number | null; guard: number | null }>>();
  let first: any = null;
  for (const s of snaps) {
    const lad = s.ladders.find((l: any) => l.key === "RCSS:20261009");
    if (!lad) continue;
    first ??= lad;
    rec.set(ts(lad.polymarket.fetchedAt), Object.fromEntries(lad.strikes.map((x: any) => [x.strike, { fair: x.fair, guard: x.guard }])));
  }
  const ticks = [...rec.keys()].sort((a, b) => a - b);
  // the resting quotes at the first snapshot; their lastQuote fair is that snapshot's fair (the Mac's own is not
  // recorded) and the wide flag is the flag they show, so the hysteresis applies from the first tick
  const init: Record<number, Init> = {};
  for (const x of first.strikes) if (x.bid !== null || x.ask !== null) init[x.strike] = { bid: x.bid, ask: x.ask, fair: x.fair, at: x.quote?.at ?? ticks[0], wide: x.flags.includes("guard-wide") };
  const from = ticks[0], to = ticks[ticks.length - 1] + 1;
  const data = `A recorded ${iso(from).slice(11, 16)}-${iso(to).slice(11, 16)} UTC (${ticks.length} ticks)`;
  macRow(data, from, to);
  for (const sc of SCENARIOS) {
    const r = run({ strikes: [28, 29, 30, 31, 32], ticks, fair: (t, k) => rec.get(t)?.[k]?.fair ?? null, flags: guardFlags((t, k) => rec.get(t)?.[k]?.guard ?? null), init, from, to }, sc);
    report(data, sc, r, from, to, sc === SCENARIOS[0]);
  }
}

// ------------------------------------------------------------------ B. Oct 9 ladder from the PM minute history
{
  const bs = series("oct9");
  const strikes = [28, 29, 30, 31, 32];
  const FROM = ts("2026-10-08T13:47:00Z");
  const END = Math.min(Math.max(...bs.map((b) => b.t[b.t.length - 1])), MAC_TICKS[MAC_TICKS.length - 1] + 1);
  const SEG1 = ts("2026-10-08T14:46:33Z"), SEG2 = ts("2026-10-08T15:47:33Z"), SEG3 = ts("2026-10-08T16:47:56Z");
  const A: Record<number, number> = { 28: 0.9808, 29: 0.9526, 30: 0.8364, 31: 0.5397, 32: 0.1902 }; // v0 mu 30.66, fetched 15:47:33
  const B: Record<number, number> = { 28: 0.9813, 29: 0.9529, 30: 0.8353, 31: 0.5336, 32: 0.1837 }; // v0 mu 30.65, 16:47:56 .. (unchanged at 18:15)
  const mkGuard = (g1: number, g2: number) => (t: number, k: number) => (t >= SEG3 ? B[k] : t >= SEG2 ? A[k] : k === 30 ? (t >= SEG1 ? g2 : g1) : A[k]);
  const fair = (t: number, k: number) => fairFrom(bs, t + 3, k); // the PM fetch happens a few s into the tick
  let best = { score: -1e9, g1: 0, g2: 0 };
  for (let g1 = 0.85; g1 <= 0.895; g1 += 0.0005)
    for (let g2 = 0.85; g2 <= 0.895; g2 += 0.0005) {
      const r = run({ strikes, ticks: MAC_TICKS, fair, flags: guardFlags(mkGuard(g1, g2)), from: FROM, to: SEG2 }, SCENARIOS[0]);
      let score = 0;
      for (const [a, b] of [[FROM, SEG1], [SEG1, SEG2]]) {
        const m = MAC.filter((x) => x.t >= a && x.t < b && x.kind === "requote").length, e = r.events.filter((x) => x.t >= a && x.t < b && x.kind === "requote").length;
        score += 2 * Number(calib(r.events, a, b).split(" ")[0]) - Math.abs(m - e);
      }
      if (score > best.score) best = { score, g1: +g1.toFixed(4), g2: +g2.toFixed(4) };
    }
  const guard = mkGuard(best.g1, best.g2);
  const WINDOWS: [string, number, number][] = [
    [`B Oct 9 ladder 13:47-${iso(END).slice(11, 16)} UTC (${((END - FROM) / 3600).toFixed(1)} h)`, FROM, END],
    [`B' of which Oct 9 Taipei day 16:00-${iso(END).slice(11, 16)} UTC`, ts("2026-10-08T16:00:00Z"), END],
  ];
  for (const [data, a, b] of WINDOWS) macRow(data, a, b);
  for (const sc of SCENARIOS) {
    const r = run({ strikes, ticks: MAC_TICKS, fair, flags: guardFlags(guard), from: FROM, to: END }, sc);
    for (const [data, a, b] of WINDOWS) report(data, sc, r, a, b, sc === SCENARIOS[0]);
    for (const e of r.events.filter((e) => e.urgent && e.kind === "requote")) urgentLog.push(`B ${sc.name}: ${iso(e.t)} >=${e.k} -> ${e.bid}/${e.ask} [${e.reasons.join("; ")}]`);
  }
  rows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  console.log(`B: >=30 guard fitted for the hourly v0 refreshes before 15:47:33 UTC: ${best.g1} (13:45-14:46), ${best.g2} (14:46-15:47); score ${best.score}`);
}

// ------------------------------------------------------------------ C. Oct 8 ladder (no guard flapping)
{
  const bs = series("oct8");
  const strikes = [28, 29, 30, 31];
  const FROM = ts("2026-10-07T05:57:00Z"), TO = ts("2026-10-08T02:20:00Z");
  const fair = (t: number, k: number) => fairFrom(bs, t + 3, k);
  const mac = MAC.filter((x) => x.t >= FROM - 600 && x.t < TO && x.kind !== "pull");
  const flagAt: Record<number, { t: number; wide: boolean }[]> = {};
  for (const x of mac) {
    const f = fairFrom(bs, x.t - 15, x.k) ?? fairFrom(bs, x.t + 60, x.k)!;
    const q = (wide: boolean) => makeQuote({ fair: f, source: "polymarket", flags: wide ? ["guard-wide"] : [], netYes: 0, freeYes: 300, freeAusd: 400, others: { bid: null, ask: null }, cfg: defaults.quote });
    const n = q(false), w = q(true);
    let wide = x.ask! - x.bid! >= 0.12;
    if (!n.pull && n.bid === x.bid && n.ask === x.ask) wide = false;
    else if (!w.pull && w.bid === x.bid && w.ask === x.ask) wide = true;
    (flagAt[x.k] ??= []).push({ t: x.t - 90, wide });
  }
  const flags: FlagFn = (t, k) => ((flagAt[k] ?? []).filter((p) => p.t <= t).at(-1)?.wide ? ["guard-wide"] : []);
  const data = `C Oct 8 ladder Oct 7 05:57-Oct 8 02:20 UTC (${((TO - FROM) / 3600).toFixed(1)} h)`;
  macRow(data, FROM, TO);
  for (const sc of [SCENARIOS[0], SCENARIOS[4], SCENARIOS[3]]) {
    const r = run({ strikes, ticks: MAC_TICKS, fair, flags, from: FROM, to: TO }, sc); // flags fixed: the hysteresis cannot act here
    report(data, { ...sc, name: sc.requoteTicks === 2 ? "current (2 ticks)" : `requoteTicks ${sc.requoteTicks}` }, r, FROM, TO, sc === SCENARIOS[0]);
    for (const e of r.events.filter((e) => e.urgent && e.kind === "requote")) urgentLog.push(`C requoteTicks ${sc.requoteTicks}: ${iso(e.t)} >=${e.k} -> ${e.bid}/${e.ask} [${e.reasons.join("; ")}]`);
  }
}

const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r: string[]) => r.map((c, i) => (i < 2 ? c.padEnd(w[i]) : c.padStart(w[i]))).join(" | ");
console.log(`requote cost ${REQUOTE_MON.toFixed(4)} MON (mean of the Mac's requotes), pull ${PULL_MON}`);
console.log(line(head));
for (const r of rows) console.log(line(r));
console.log("\nurgent re-quotes (fair crossed a resting price):");
for (const u of urgentLog) console.log("  " + u);
