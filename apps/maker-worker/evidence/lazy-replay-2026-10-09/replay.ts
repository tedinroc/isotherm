// "Lazy maker" replay (2026-10-09): re-quotes per day, MON per day and the quote quality (resting mid vs fair) of the
// quoting policy the live Worker ran until now vs the lazy policy (packages/maker policy.ts lazy / oneSided) and the
// quoting budget tiers (budget.ts quotingTier), tick by tick on the three RCSS ladders the maker quoted:
//   Oct 8 ladder [28..31]   Oct 7 05:57 .. Oct 8 09:18:30 UTC (kill switch)
//   Oct 9 ladder [28..32]   Oct 8 13:47 .. Oct 9 09:18:30 UTC
//   Oct 10 ladder [28..31]  Oct 9 04:01 .. the end of the data (the ladder is still open)
// It runs the repo's own computeFairs (observed-max conditioning, guard flags, hysteresis), makeQuote, decide and
// quotingTier: the same code the Worker runs. One tick every 60 s; fair re-built from the Polymarket CLOB minute
// history 3 s into the tick (normalised bucket prices, P(>=k) = sum of buckets with lower bound >= k; the same
// formula as ladderFromGamma). On the ladder's own day the observed METAR max (IEM, 5 min publication lag)
// conditions the fair and pulls certain strikes; from 11:00 local the guard is the intraday increment table
// (results/close_time.json), as live.
// The v0 guard of the night before is not archived. Oct 9: the Mac's published values (see
// ../requote-replay-2026-10-09: mu 30.66 then 30.65; >=30 fitted before 15:47 UTC). Oct 10: the values the live Worker
// published at 15:39 UTC Oct 9 (mu 29.87), held constant. Oct 8: none (no guard flags before 11:00 local).
// Every scenario gets the same inputs. Not modelled: fills (13 maker fills on these books in three days, see
// chain.json), other participants' quotes (post-only stepping), gas price changes (102 gwei).
// Costs per tx (MON billed, limit = estimate x 1.08 at 102 gwei; ../one-side-gas-2026-10-09): re-quote cancel 2 +
// place 2 0.0576, one side cancel 1 + place 1 0.037, place 1 0.0317, pull (cancel 2) 0.0278, new quote (place 2) 0.0594.
//   node replay.ts            (inputs: node prepare.ts)
import { readFileSync, writeFileSync } from "node:fs";
import { computeFairs } from "../../../../packages/forecast/src/fair.ts";
import { quotingTier, recordSpend, type BudgetCfg, type BudgetState } from "../../../../packages/maker/src/budget.ts";
import { decide, type PolicyCfg } from "../../../../packages/maker/src/policy.ts";
import { makeQuote } from "../../../../packages/maker/src/pricing.ts";
import type { CloseTimeStats } from "../../../../packages/forecast/src/closetime.ts";

const HERE = new URL(".", import.meta.url).pathname;
const read = (f: string) => JSON.parse(readFileSync(`${HERE}/${f}`, "utf8"));
const defaults = JSON.parse(readFileSync(`${HERE}/../../../../packages/maker/config/default.json`, "utf8"));
const closeStats: CloseTimeStats = JSON.parse(readFileSync(`${HERE}/../../../../packages/forecast/results/close_time.json`, "utf8")).stations.RCSS;
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";
const ts = (s: string) => Date.parse(s) / 1000;
const COST = { requote: 0.0576, oneSide: 0.037, place1: 0.0317, pull: 0.0278, quote: 0.0594 };

// ------------------------------------------------------------------ scenarios
interface Scenario {
  name: string;
  policy: Partial<PolicyCfg>;
  tiers?: { cap: number; softRatio: number; widen: number } | null;
  exit?: number | null; // guard-wide hysteresis exit (default 0.13)
  quote?: Record<string, number>; // quote config overrides (sensitivity only)
}
const LIVE: Partial<PolicyCfg> = { requoteTicks: 3, staleHours: 6, lazy: false };
const LAZY = (move: number, staleH = 2, minMove = 0.02, oneSided = true): Partial<PolicyCfg> => ({ requoteTicks: 3, staleHours: 6, lazy: true, requoteFairMove: move, staleRefreshHours: staleH, staleRefreshMinMove: minMove, oneSided });
const SCENARIOS: Scenario[] = [
  { name: "live until now: requoteTicks 3 + hysteresis, no tiers", policy: LIVE },
  { name: "lazy 0.03 / 2 h / 0.02", policy: LAZY(0.03) },
  { name: "lazy 0.04 / 2 h / 0.02", policy: LAZY(0.04) },
  { name: "lazy 0.05 / 2 h / 0.02", policy: LAZY(0.05) },
  { name: "lazy 0.04 / 4 h / 0.02", policy: LAZY(0.04, 4) },
  { name: "lazy 0.04, two-sided only", policy: LAZY(0.04, 2, 0.02, false) },
  { name: "lazy 0.04 + tiers 1.5 MON, soft 60 % x2", policy: LAZY(0.04), tiers: { cap: 1.5, softRatio: 0.6, widen: 2 } },
  { name: "lazy 0.04 + tiers 1.2 MON, soft 60 % x2", policy: LAZY(0.04), tiers: { cap: 1.2, softRatio: 0.6, widen: 2 } },
  { name: "lazy 0.04 + tiers 1.0 MON, soft 60 % x2", policy: LAZY(0.04), tiers: { cap: 1.0, softRatio: 0.6, widen: 2 } },
  { name: "live settings + tiers 1.5 MON (tiers alone)", policy: LIVE, tiers: { cap: 1.5, softRatio: 0.6, widen: 2 } },
  { name: "sensitivity: lazy 0.05, half-spread 4 ticks, no tiers", policy: LAZY(0.05), quote: { halfSpreadTicks: 4 } },
];

// ------------------------------------------------------------------ inputs
type Hist = { lo: number; hi: number; t: number[]; p: number[] };
const PM = read("pm-history.json");
const METAR: { t: number; tempC: number }[] = read("metar.json");
const CHAIN = read("chain.json");
const series = (ev: string): Hist[] =>
  PM[ev].buckets.map((b: any) => {
    const n = Number(b.label.match(/^(-?\d+)/)[1]);
    return { lo: /or below/.test(b.label) ? -Infinity : n, hi: /or higher/.test(b.label) ? Infinity : n, t: b.t, p: b.p };
  });
function priceAt(h: Hist, t: number): number | null {
  let lo = 0, hi = h.t.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (h.t[m] <= t) (r = m), (lo = m + 1);
    else hi = m - 1;
  }
  return r < 0 ? null : h.p[r];
}
/** The live ladder shape computeFairs wants: P(>=k) for every integer k between the buckets' finite bounds. */
function pmLadder(bs: Hist[], t: number) {
  const ps = bs.map((b) => priceAt(b, t));
  if (ps.some((p) => p === null)) return null;
  const sum = ps.reduce((a, b) => a! + b!, 0)!;
  const fin = bs.filter((b) => Number.isFinite(b.lo)).map((b) => b.lo);
  const strikes: number[] = [];
  const ladder: Record<number, number> = {};
  for (let k = Math.min(...fin); k <= Math.max(...fin); k++) {
    strikes.push(k);
    ladder[k] = +(bs.reduce((a, b, i) => a + (b.lo >= k ? ps[i]! : 0), 0) / sum).toFixed(4);
  }
  return { ok: true, ladder, strikes, mean: null, sd: null } as any;
}
const DAY_START = (isoDate: string) => ts(`${isoDate}T00:00:00Z`) - 8 * 3600; // local midnight, Taipei
function obsAt(isoDate: string, t: number) {
  const s = DAY_START(isoDate);
  if (t < s) return null;
  const seen = METAR.filter((o) => o.t >= s && o.t < s + 86_400 && o.t <= t - 300);
  return { tmaxC: seen.length ? Math.max(...seen.map((o) => o.tempC)) : null, dayStarted: true } as any;
}
const V0_OCT9_A: Record<number, number> = { 28: 0.9808, 29: 0.9526, 30: 0.8364, 31: 0.5397, 32: 0.1902 };
const V0_OCT9_B: Record<number, number> = { 28: 0.9813, 29: 0.9529, 30: 0.8353, 31: 0.5336, 32: 0.1837 };
const V0_OCT10: Record<number, number> = { 28: 0.953, 29: 0.8494, 30: 0.6002, 31: 0.2563 };
const v0Oct9 = (t: number): Record<number, number> => (t >= ts("2026-10-08T16:47:56Z") ? V0_OCT9_B : t >= ts("2026-10-08T15:47:33Z") ? V0_OCT9_A : { ...V0_OCT9_A, 30: t >= ts("2026-10-08T14:46:33Z") ? 0.8695 : 0.8685 });

interface LadderDef { key: string; ev: string; isoDate: string; strikes: number[]; from: number; to: number; v0: (t: number) => Record<number, number> | null }
const STOP = (closeTime: number) => closeTime - 600 - 90; // stopAt - preStopSec
const firstQuote = (ladder: string) => Math.min(...CHAIN.rows.filter((r: any) => r.ladder === ladder && r.events.some((e: any) => e.kind === "create")).map((r: any) => r.t));
const ENDDATA = Math.min(...["oct10"].flatMap((e) => PM[e].buckets.map((b: any) => b.t.at(-1))));
const LADDERS: LadderDef[] = [
  { key: "Oct 8 ladder", ev: "oct8", isoDate: "2026-10-08", strikes: [28, 29, 30, 31], from: Math.floor(firstQuote("oct8")), to: STOP(1791451800), v0: () => null },
  { key: "Oct 9 ladder", ev: "oct9", isoDate: "2026-10-09", strikes: [28, 29, 30, 31, 32], from: Math.floor(firstQuote("oct9")), to: STOP(1791538200), v0: v0Oct9 },
  { key: "Oct 10 ladder", ev: "oct10", isoDate: "2026-10-10", strikes: [28, 29, 30, 31], from: Math.floor(firstQuote("oct10")), to: Math.min(STOP(1791624600), ENDDATA), v0: () => V0_OCT10 },
];
const HIST: Record<string, Hist[]> = Object.fromEntries(LADDERS.map((l) => [l.ev, series(l.ev)]));

// ------------------------------------------------------------------ the replay
type Kind = "quote" | "requote" | "one-side" | "pull";
interface Ev { t: number; ladder: string; k: number; kind: Kind; urgent: boolean; mon: number; opening: boolean; reasons: string[] }
interface Gap { t: number; ladder: string; k: number; gap: number; edge: number }
const tday = (t: number) => new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10); // Taipei day (the budget day)

function run(sc: Scenario) {
  const bc: BudgetCfg = { dayUtcOffsetMin: 480, dailyCapMon: { maker: sc.tiers?.cap ?? 99 }, reserveMon: { maker: 0.4 }, rollCapMon: { maker: 0.8 }, softRatio: sc.tiers?.softRatio ?? null };
  const budget: BudgetState = { day: "", spent: {}, txs: {} };
  const st = new Map<string, { resting: { bid: number | null; ask: number | null } | null; lastQuote?: { fair: number; at: number; wide?: boolean }; mode: any; opened: boolean }>();
  const events: Ev[] = [];
  const gaps: Gap[] = [];
  const ticks = new Set<number>();
  for (const l of LADDERS) for (let t = l.from; t <= l.to; t += 60) ticks.add(t);
  const order = [...ticks].sort((a, b) => a - b);
  for (const t of order) {
    for (const l of LADDERS) {
      if (t < l.from || t > l.to) continue;
      const pm = pmLadder(HIST[l.ev], t + 3);
      if (!pm) continue;
      const obs = obsAt(l.isoDate, t);
      const s0 = DAY_START(l.isoDate);
      const localMinute = t >= s0 && t < s0 + 86_400 ? Math.floor((t - s0) / 60) : null;
      const v0 = l.v0(t);
      const restingWide: Record<number, boolean> = {};
      for (const k of l.strikes) {
        const s = st.get(`${l.ev}:${k}`);
        if (s?.resting && s.lastQuote?.wide) restingWide[k] = true;
      }
      const fairs = computeFairs({ strikes: l.strikes, nowMs: t * 1000, localMinute, pm, pmFetchedMs: t * 1000, obs: obs && obs.tmaxC !== null ? obs : null, v0: v0 ? { ladder: v0 } : null, intraday: closeStats, restingWide, cfg: { ...defaults.fair, guardWarnExit: sc.exit === undefined ? 0.13 : sc.exit } });
      for (const f of fairs) {
        const key = `${l.ev}:${f.k}`;
        const s = st.get(key) ?? { resting: null, mode: "pending", opened: false };
        st.set(key, s);
        const ti = quotingTier(budget, "maker", s.opened ? "quote" : "roll", bc, t * 1000);
        const widen = ti.tier !== "normal" && sc.tiers ? { mult: sc.tiers.widen, why: "quoting budget" } : null;
        const desired = makeQuote({ fair: f.fair, source: f.source, flags: f.flags, netYes: 0, freeYes: 300, freeAusd: 400, others: { bid: null, ask: null }, cfg: { ...defaults.quote, ...sc.quote }, widen });
        const resting: any = {};
        if (s.resting?.bid != null) resting.bid = { id: 1, price: s.resting.bid, remaining: 100 };
        if (s.resting?.ask != null) resting.ask = { id: 2, price: s.resting.ask, remaining: 100 };
        const a = decide({ now: t, stopAt: 4e9, mode: s.mode, certain: f.certain === "yes", fair: f.fair, desired, resting, lastQuote: s.lastQuote, wide: f.flags.includes("guard-wide"), tier: ti.tier, cfg: { ...defaults.policy, ...sc.policy, tick: defaults.quote.tick } as PolicyCfg });
        const spend = (kind: Kind, mon: number, urgent: boolean) => {
          const opening = kind === "quote" && !s.opened;
          events.push({ t, ladder: l.key, k: f.k, kind, urgent, mon, opening, reasons: a.reasons });
          recordSpend(budget, "maker", mon, t * 1000, bc, kind === "pull" ? "pull" : opening ? "roll" : "quote");
        };
        if ((a.kind === "quote" || a.kind === "requote") && !desired.pull) {
          if (a.kind === "requote" && a.sides) {
            const placed = (a.sides.bid ? desired.bid !== null : false) || (a.sides.ask ? desired.ask !== null : false);
            const cancelled = (a.sides.bid && s.resting?.bid != null) || (a.sides.ask && s.resting?.ask != null);
            spend("one-side", placed && cancelled ? COST.oneSide : placed ? COST.place1 : COST.pull / 2, a.urgent);
            s.resting = { bid: a.sides.bid ? desired.bid : s.resting!.bid, ask: a.sides.ask ? desired.ask : s.resting!.ask };
          } else {
            spend(a.kind, a.kind === "quote" ? COST.quote : COST.requote, a.urgent);
            s.resting = { bid: desired.bid, ask: desired.ask };
            s.lastQuote = { fair: f.fair!, at: t, wide: f.flags.includes("guard-wide") };
          }
          s.opened = true;
          s.mode = "quoting";
        } else if (a.kind === "pull" || a.kind === "close") {
          spend("pull", COST.pull, a.urgent);
          s.resting = null;
          s.mode = a.mode ?? "pulled";
        } else if (a.mode) s.mode = a.mode;
        // quote quality while resting (prices clamped at minPrice/maxPrice left out)
        const r = s.resting;
        if (r && f.fair !== null) {
          const bidOk = r.bid !== null && r.bid > defaults.quote.minPrice, askOk = r.ask !== null && r.ask < defaults.quote.maxPrice;
          const edge = Math.min(bidOk ? f.fair - r.bid! : 1, askOk ? r.ask! - f.fair : 1);
          if (bidOk && askOk) gaps.push({ t, ladder: l.key, k: f.k, gap: Math.abs((r.bid! + r.ask!) / 2 - f.fair), edge });
        }
      }
    }
  }
  return { events, gaps };
}

// ------------------------------------------------------------------ report
const DAYS: [string, number, number][] = [
  ["Taipei Oct 8 (Oct 7 16:00 - Oct 8 16:00 UTC)", ts("2026-10-07T16:00:00Z"), ts("2026-10-08T16:00:00Z")],
  ["Taipei Oct 9 (Oct 8 16:00 - Oct 9 16:00 UTC)", ts("2026-10-08T16:00:00Z"), ts("2026-10-09T16:00:00Z")],
];
const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN);
const lines: string[] = [];
const say = (s = "") => (console.log(s), lines.push(s));
say(`inputs: ${LADDERS.map((l) => `${l.key} ${iso(l.from)}..${iso(l.to)} [${l.strikes}]`).join("; ")}`);
say(`costs MON: ${JSON.stringify(COST)}`);

// actual (on chain): the live maker's txs on these books (Mac until 2026-10-08 23:00 UTC, the Worker after)
const actual = (from: number, to: number, ladder?: string) => {
  const rows = CHAIN.rows.filter((r: any) => r.t >= from && r.t < to && r.maker && (!ladder || r.ladder === ladder));
  const c = { requote: 0, oneSide: 0, quote: 0, pull: 0, fills: CHAIN.rows.filter((r: any) => r.t >= from && r.t < to && !r.maker && (!ladder || r.ladder === ladder)).length };
  for (const r of rows) {
    const cr = r.events.filter((e: any) => e.kind === "create").length, cx = r.events.filter((e: any) => e.kind === "cancel").reduce((a: number, e: any) => a + e.ids.length, 0);
    if (cr === 2 && cx >= 1) c.requote++;
    else if (cr === 1 && cx >= 1) c.oneSide++;
    else if (cr >= 1) c.quote++;
    else c.pull++;
  }
  return c;
};
const head = ["window", "scenario", "requotes", "one-side", "pulls", "urgent", "quotes (opening)", "quoting MON", "pull MON", "max |mid-fair|", "p95 |mid-fair|", "min edge"];
const rows: string[][] = [];
const RESULTS = SCENARIOS.map((sc) => ({ sc, ...run(sc) }));
const windows: [string, number, number, string | undefined][] = [
  ...DAYS.map(([n, a, b]) => [n, a, b, undefined] as [string, number, number, string | undefined]),
  ...LADDERS.map((l) => [`${l.key} (${((l.to - l.from) / 3600).toFixed(1)} h)`, l.from, l.to + 1, l.key] as [string, number, number, string | undefined]),
];
for (const [name, a, b, lad] of windows) {
  const ac = actual(a, b, lad && LADDERS.find((l) => l.key === lad)!.ev);
  rows.push([name, `ACTUAL on chain (fills ${ac.fills})`, String(ac.requote), String(ac.oneSide), String(ac.pull), "", String(ac.quote), "", "", "", "", ""]);
  for (const r of RESULTS) {
    const ev = r.events.filter((e) => e.t >= a && e.t < b && (!lad || e.ladder === lad));
    const gp = r.gaps.filter((g) => g.t >= a && g.t < b && (!lad || g.ladder === lad));
    const mon = ev.filter((e) => !e.opening && e.kind !== "pull").reduce((s, e) => s + e.mon, 0);
    const pmon = ev.filter((e) => e.kind === "pull").reduce((s, e) => s + e.mon, 0);
    const worst = gp.reduce((m, g) => (g.gap > m.gap ? g : m), { gap: 0 } as any);
    rows.push([
      name,
      r.sc.name,
      String(ev.filter((e) => e.kind === "requote").length),
      String(ev.filter((e) => e.kind === "one-side").length),
      String(ev.filter((e) => e.kind === "pull").length),
      String(ev.filter((e) => e.urgent && e.kind !== "pull").length),
      `${ev.filter((e) => e.kind === "quote").length} (${ev.filter((e) => e.opening).length})`,
      mon.toFixed(2),
      pmon.toFixed(2),
      gp.length ? `${worst.gap.toFixed(3)} (${iso(worst.t).slice(5)} >=${worst.k})` : "-",
      gp.length ? q(gp.map((g) => g.gap), 0.95).toFixed(3) : "-",
      gp.length ? Math.min(...gp.map((g) => g.edge)).toFixed(3) : "-",
    ]);
  }
}
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r: string[]) => r.map((c, i) => (i < 2 ? c.padEnd(w[i]) : c.padStart(w[i]))).join(" | ");
say(line(head));
for (const r of rows) say(line(r));
// per-24 h rates over the whole replay (all ladders)
const span = (Math.max(...LADDERS.map((l) => l.to)) - Math.min(...LADDERS.map((l) => l.from))) / 86_400;
// all-in projection per day: + one 4-strike roll incl. its opening quotes (measured at go-live 2026-10-07: operator
// 0.7761 + maker 0.4805 = 1.2568 MON) + the close-time kill switch and YES withdraw (~0.10 MON for 4 strikes)
const FIXED_ROLL = 1.2568, FIXED_KILL = 0.1;
say(`\nper 24 h over the whole replay (${(span * 24).toFixed(1)} h, all ladders); all-in adds a 4-strike roll ${FIXED_ROLL} and the kill switch ${FIXED_KILL} MON per day:`);
for (const r of RESULTS) {
  const ev = r.events.filter((e) => !e.opening);
  const mon = ev.filter((e) => e.kind !== "pull").reduce((s, e) => s + e.mon, 0);
  const pmon = ev.filter((e) => e.kind === "pull").reduce((s, e) => s + e.mon, 0);
  const allIn = mon / span + pmon / span + FIXED_ROLL + FIXED_KILL;
  say(`  ${r.sc.name.padEnd(54)} all-in ~${allIn.toFixed(2)} MON/day; re-quotes ${(ev.filter((e) => e.kind === "requote").length / span).toFixed(1)}/day, one-side ${(ev.filter((e) => e.kind === "one-side").length / span).toFixed(1)}/day, pulls ${(ev.filter((e) => e.kind === "pull").length / span).toFixed(1)}/day; quoting meter ${(mon / span).toFixed(2)} + pulls ${(pmon / span).toFixed(2)} MON/day`);
}
const share = (r: (typeof RESULTS)[number]) => {
  const rq = r.events.filter((e) => e.kind === "requote" || e.kind === "one-side");
  return `${rq.filter((e) => e.urgent).length} of ${rq.length} re-quotes urgent`;
};
say(`\nwhy the policy alone cannot reach the target: most re-quotes on these days are URGENT (the fair moved through a resting price, i.e. by about the half-spread 0.03-0.04 within a minute or two). live: ${share(RESULTS[0])}; lazy 0.04: ${share(RESULTS[2])}; lazy 0.04 + tiers 1.5: ${share(RESULTS[6])}.`);
say("\nurgent re-quotes, lazy 0.04, Oct 9 ladder (first 25):");
for (const e of RESULTS[2].events.filter((e) => e.urgent && e.kind !== "pull" && e.ladder === "Oct 9 ladder").slice(0, 25)) say(`  ${iso(e.t)} >=${e.k} ${e.kind}: ${e.reasons.join("; ").slice(0, 140)}`);
writeFileSync(`${HERE}/results.txt`, lines.join("\n") + "\n");
