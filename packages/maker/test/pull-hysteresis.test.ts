// The pull hysteresis (policy.pullReentry, 2026-10-14): makeQuote's pull thresholds (quote.pullBelow / pullAbove,
// fair.guardPull) have no hysteresis of their own, so a fair hovering at 0.03 or a Polymarket/guard divergence hovering
// at 0.4 flapped pull -> quote -> pull on the live Worker (~0.0875 MON a cycle: 0.059 quoting + 0.028 reserve).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BudgetTier } from "../src/budget.ts";
import { decide, pullCause, type PolicyCfg, type PolicyInput } from "../src/policy.ts";
import { makeQuote } from "../src/pricing.ts";
import { loadConfig, type QuoteCfg } from "../src/config.ts";
import type { SeriesMode } from "../src/state-core.ts";
import { decideBefore } from "./fixtures/policy-before-pull-reentry.ts";

const qcfg: QuoteCfg = { tick: 0.01, kuruTick: 0.001, halfSpreadTicks: 3, minPrice: 0.01, maxPrice: 0.99, pullBelow: 0.03, pullAbove: 0.97, guardWidenMult: 2, fallbackWidenMult: 2, sizeYes: 100, maxPositionYes: 300, skewTicksAtCap: 2, minOrderYes: 1 };
// the shared default policy (lazy, one-sided) plus the thresholds tick.ts hands decide()
const pcfg: PolicyCfg = { requoteTicks: 3, staleHours: 6, refillRatio: 0.5, preStopSec: 90, tick: 0.01, lazy: true, requoteFairMove: 0.04, staleRefreshHours: 2, staleRefreshMinMove: 0.02, oneSided: true, pullBelow: 0.03, pullAbove: 0.97, guardPull: 0.4 };
const flagsOf = (div: number | null) => (div === null ? [] : div > 0.4 ? ["guard-pull"] : div > 0.15 ? ["guard-wide"] : []);

/** One tick of a strike: `fair` null = no usable fair; `div` = |Polymarket fair - guard| (fair.ts divergence); `broke`
 *  = no free margin (makeQuote: "no side left"); `fill` = a taker lifted both resting sides before the tick. */
type Step = { fair: number | null; div?: number | null; broke?: boolean; fill?: boolean; tier?: BudgetTier };

/** One strike through a sequence of ticks, as tick.ts does it: makeQuote -> decide -> act (a pull empties the book and
 *  records its reasons, a quote / requote fills it and records its reasons, `none` records its mode and, with the
 *  hysteresis on, the pull reason of an empty strike that makeQuote pulls, keeping a band / guard cause). */
function run(steps: Step[], pullReentry: number | null | undefined, start: { mode?: SeriesMode; reason?: string } = {}) {
  let mode: SeriesMode = start.mode ?? "pending";
  let reason = start.reason;
  let resting: PolicyInput["resting"] = {};
  let lastQuote: PolicyInput["lastQuote"];
  let id = 0;
  const kinds: string[] = [];
  const reasons: string[][] = [];
  steps.forEach(({ fair, div = null, broke = false, fill = false, tier = "normal" }, i) => {
    if (fill) resting = {};
    const flags = flagsOf(div);
    const desired = makeQuote({ fair, source: fair === null ? "none" : "polymarket", flags, netYes: 0, freeYes: broke ? 0 : 300, freeAusd: broke ? 0 : 1000, others: { bid: null, ask: null }, cfg: qcfg });
    const now = 1000 + 60 * i;
    const a = decide({ now, stopAt: 1e9, mode, certain: false, fair, desired, resting, lastQuote, wide: flags.includes("guard-wide"), divergence: div, pulledFor: pullCause(reason), tier, cfg: { ...pcfg, pullReentry } });
    kinds.push(a.kind);
    reasons.push(a.reasons);
    if (a.kind === "none") {
      if (desired.pull && a.mode === "pulled" && pullReentry != null) {
        const why = a.reasons.join("; ");
        if (mode !== "pulled" || pullCause(why) || !pullCause(reason)) reason = why;
      }
      mode = a.mode ?? mode;
    } else if (a.kind === "pull" || a.kind === "close") (resting = {}), (mode = a.mode ?? "pulled"), (reason = a.reasons.join("; "));
    else if (!desired.pull) {
      resting = {};
      if (desired.bid !== null) resting.bid = { id: ++id, price: desired.bid, remaining: desired.bidSize };
      if (desired.ask !== null) resting.ask = { id: ++id, price: desired.ask, remaining: desired.askSize };
      lastQuote = { fair: fair!, at: now, wide: flags.includes("guard-wide") };
      mode = "quoting";
      reason = a.reasons.join("; ");
    }
  });
  const count = (k: string) => kinds.filter((x) => x === k).length;
  return { kinds, reasons, mode, reason, pulls: count("pull"), quotes: count("quote") + count("requote") };
}

test("a fair flapping around pullBelow: one pull, then no re-quote until the fair is back to pullBelow + pullReentry", () => {
  const seq = [0.06, 0.0297, 0.031, 0.029, 0.031, 0.0299, 0.035, 0.0499, 0.05].map((fair) => ({ fair }));
  const on = run(seq, 0.02);
  assert.deepEqual(on.kinds, ["quote", "pull", "none", "none", "none", "none", "none", "none", "quote"]);
  assert.deepEqual([on.pulls, on.quotes], [1, 2]);
  assert.match(on.reasons[2][0], /^pulled: fair 0.031 not back inside \[0.05, 0.95\] \(pullReentry 0.02\)$/);
  // the same fairs without the hysteresis (today): every dip is a pull and every bounce a new quote
  const off = run(seq, null);
  assert.deepEqual(off.kinds.slice(0, 7), ["quote", "pull", "quote", "pull", "quote", "pull", "quote"]);
  assert.equal(off.pulls, 3);
});

test("the same at pullAbove: back below pullAbove - pullReentry to quote again", () => {
  const on = run([0.9, 0.9703, 0.969, 0.971, 0.96, 0.9501, 0.95].map((fair) => ({ fair })), 0.02);
  assert.deepEqual(on.kinds, ["quote", "pull", "none", "none", "none", "none", "quote"]);
  assert.deepEqual(run([0.9, 0.9703, 0.969].map((fair) => ({ fair })), null).kinds, ["quote", "pull", "quote"]);
});

test("a guard pull: no re-quote until the divergence is <= guardPull - pullReentry", () => {
  const seq = [0.2, 0.41, 0.39, 0.41, 0.385, 0.3801, 0.38].map((div) => ({ fair: 0.47, div }));
  const on = run(seq, 0.02);
  assert.deepEqual(on.kinds, ["quote", "pull", "none", "none", "none", "none", "quote"]);
  assert.match(on.reasons[2][0], /^pulled: Polymarket and the guard model still disagree by 0.39 \(> guardPull 0.4 - pullReentry 0.02\)$/);
  assert.match(on.reasons[3][0], /disagree by > guardPull/); // the second spike is makeQuote's own pull, on an empty book
  const off = run(seq, null);
  assert.deepEqual(off.kinds.slice(0, 4), ["quote", "pull", "quote", "pull"]);
  // no divergence (a fallback fair, no guard): the guard margin does not apply
  assert.deepEqual(run([{ fair: 0.47, div: 0.41 }, { fair: 0.47, div: null }], 0.02, { mode: "quoting" }).kinds, ["none", "quote"]);
});

test("after a band or a guard pull both margins apply, so a strike near both thresholds cannot flap through the other", () => {
  assert.deepEqual(run([{ fair: 0.2, div: 0.1 }, { fair: 0.029, div: 0.1 }, { fair: 0.08, div: 0.39 }, { fair: 0.08, div: 0.3 }], 0.02).kinds, ["quote", "pull", "none", "quote"]);
  assert.deepEqual(run([{ fair: 0.2, div: 0.1 }, { fair: 0.2, div: 0.45 }, { fair: 0.04, div: 0.1 }, { fair: 0.06, div: 0.1 }], 0.02).kinds, ["quote", "pull", "none", "quote"]);
});

test("only a band or guard pull is held: no usable fair, no side left, the hard tier, a manual pull then resume are quoted at once", () => {
  // each strike ends at fair 0.04 with divergence 0.39: inside both hold zones, so a band / guard pull would wait here
  const at = { fair: 0.04, div: 0.39 };
  // no usable fair value (pulled with a tx), then the fair is back
  assert.deepEqual(run([{ fair: 0.2 }, { fair: null }, at], 0.02).kinds, ["quote", "pull", "quote"]);
  // no side left after caps / margin (makeQuote pulls it), then the margin is back
  assert.deepEqual(run([{ fair: 0.2 }, { fair: 0.2, broke: true }, at], 0.02).kinds, ["quote", "pull", "quote"]);
  // emptied by fills under the hard budget tier (mode "pulled", no new quotes), then a new budget day
  const hard = run([{ fair: 0.2 }, { fair: 0.2, fill: true, tier: "hard" }, at], 0.02);
  assert.deepEqual([hard.kinds, hard.reasons[1]], [["quote", "none", "quote"], ["quoting budget spent for today: no new quotes"]]);
  // a manual pull (killLadder close:false: mode "pulled", the reason of the last quote kept), then resume
  assert.deepEqual(run([at], 0.02, { mode: "pulled", reason: "no resting quote" }).kinds, ["quote"]);
  assert.deepEqual(run([at], 0.02, { mode: "pulled" }).kinds, ["quote"]);
  // the same start after a band pull does wait
  assert.deepEqual(run([at], 0.02, { mode: "pulled", reason: "fair 0.029 outside (0.03, 0.97): outcome ~known" }).kinds, ["none"]);
});

test("an empty strike pulled without a tx (both sides filled, then the fair left the band) is held as well", () => {
  const seq: Step[] = [{ fair: 0.2 }, { fair: 0.029, fill: true }, { fair: 0.04 }, { fair: 0.05 }];
  const on = run(seq, 0.02);
  assert.deepEqual(on.kinds, ["quote", "none", "none", "quote"]);
  assert.deepEqual(run(seq, null).kinds, ["quote", "none", "quote", "none"]);
});

test("a gap in the fair does not end a band hold; a strike quoted again starts afresh", () => {
  const seq: Step[] = [{ fair: 0.2 }, { fair: 0.029 }, { fair: 0.04 }, { fair: null }, { fair: 0.04 }, { fair: 0.05 }];
  const on = run(seq, 0.02);
  assert.deepEqual(on.kinds, ["quote", "pull", "none", "none", "none", "quote"]);
  assert.deepEqual(on.reasons[3], ["no usable fair value"]);
  assert.equal(pullCause(on.reason), null); // quoted again at 0.05: the recorded reason is the quote's
  // a band-held strike that makeQuote pulls for the guard keeps a band / guard cause (both margins), and the reverse
  assert.deepEqual(run([{ fair: 0.2 }, { fair: 0.029 }, { fair: 0.04, div: 0.45 }, { fair: 0.04, div: 0.1 }, { fair: 0.06, div: 0.1 }], 0.02).kinds, ["quote", "pull", "none", "none", "quote"]);
});

test("pullCause reads makeQuote's own pull reasons (pricing.ts wording and policy.ts markers stay in step)", () => {
  const mq = (fair: number | null, o: { div?: number; broke?: boolean } = {}) => {
    const d = makeQuote({ fair, source: fair === null ? "none" : "polymarket", flags: flagsOf(o.div ?? null), netYes: 0, freeYes: o.broke ? 0 : 300, freeAusd: o.broke ? 0 : 1000, others: { bid: null, ask: null }, cfg: qcfg });
    assert.equal(d.pull, true);
    return pullCause(d.reasons.join("; "));
  };
  assert.equal(mq(0.029), "band");
  assert.equal(mq(0.03), "band");
  assert.equal(mq(0.975), "band");
  assert.equal(mq(0.47, { div: 0.41 }), "guard");
  assert.equal(mq(0.02, { div: 0.41 }), "guard"); // makeQuote checks the guard first
  assert.equal(mq(null), null);
  assert.equal(mq(0.47, { div: 0.2, broke: true }), null); // "guard disagrees: x2 spread; no side left after caps / margin"
  for (const r of [undefined, null, "", "no resting quote", "resting ask 0.97 <= fair 0.975; quoting budget spent for today: pulled instead of re-quoted", "pulled: fair 0.031 not back inside [0.05, 0.95] (pullReentry 0.02)"])
    assert.equal(pullCause(r), null);
});

test("only an empty PULLED strike waits: new strikes, the kill switch, certainty, pulls, urgent crossings and the budget are unchanged", () => {
  const want = makeQuote({ fair: 0.04, source: "polymarket", flags: [], netYes: 0, freeYes: 300, freeAusd: 1000, others: { bid: null, ask: null }, cfg: qcfg });
  const base: PolicyInput = { now: 1000, stopAt: 10_000, mode: "pulled", certain: false, fair: 0.04, desired: want, resting: {}, divergence: 0.1, pulledFor: "band", cfg: { ...pcfg, pullReentry: 0.02 } };
  const d = (o: Partial<PolicyInput>) => decide({ ...base, ...o });
  assert.deepEqual([d({}).kind, d({}).mode], ["none", "pulled"]);
  assert.equal(d({ pulledFor: "guard" }).kind, "none");
  assert.equal(d({ pulledFor: null }).kind, "quote");
  assert.equal(d({ mode: "pending" }).kind, "quote"); // a new strike (the roll) is not pulled: no hysteresis
  assert.equal(d({ mode: "quoting" }).kind, "quote");
  assert.equal(d({ now: 9_950 }).kind, "close"); // the kill switch
  assert.equal(d({ now: 9_950, resting: { bid: { id: 1, price: 0.01, remaining: 100 } } }).kind, "close");
  assert.equal(d({ mode: "closed", resting: { bid: { id: 1, price: 0.01, remaining: 100 } } }).kind, "close");
  assert.equal(d({ certain: true, resting: { bid: { id: 1, price: 0.01, remaining: 100 } } }).kind, "pull");
  assert.equal(d({ desired: { pull: true, reasons: ["fair 0.03"] }, resting: { bid: { id: 1, price: 0.01, remaining: 100 } } }).kind, "pull");
  // the hard budget tier keeps its own reason
  assert.deepEqual(d({ tier: "hard" }).reasons, ["quoting budget spent for today: no new quotes"]);
  // resting orders on a "pulled" strike (a failed cancel, adopted orders): decided exactly as before, urgent crossings too
  const rest = { bid: { id: 1, price: 0.04, remaining: 100 }, ask: { id: 2, price: 0.08, remaining: 100 } };
  for (const o of [{ resting: rest }, { resting: rest, fair: 0.045 }, { resting: { ask: rest.ask } }, { resting: rest, lastQuote: { fair: 0.1, at: 900 } }])
    assert.deepEqual(d(o), decideBefore({ ...base, ...o }));
  assert.deepEqual([d({ resting: rest }).kind, d({ resting: rest }).urgent], ["requote", true]);
});

/** 20 000 random decide() inputs over the edges that matter here (fairs and divergences at the thresholds, every mode,
 *  tier, pull cause, resting shape; the legacy and the lazy policy). */
function* randomInputs(n: number): Generator<PolicyInput> {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const legacy = { requoteTicks: 2, staleHours: 6, refillRatio: 0.5, preStopSec: 90, tick: 0.01 };
  const lazy = { ...legacy, requoteTicks: 3, lazy: true, requoteFairMove: 0.04, staleRefreshHours: 2, staleRefreshMinMove: 0.02, oneSided: true };
  for (let i = 0; i < n; i++) {
    const fair = pick([0.01, 0.029, 0.03, 0.031, 0.04, 0.05, 0.2, 0.47, 0.95, 0.969, 0.97, 0.99, rnd()]);
    const div = pick([null, 0, 0.1, 0.38, 0.39, 0.4, 0.41, rnd()]);
    const flags = flagsOf(div);
    const desired = makeQuote({ fair, source: "polymarket", flags, netYes: pick([0, 150, -300]), freeYes: 300, freeAusd: pick([0, 1000]), others: { bid: null, ask: null }, cfg: qcfg });
    const side = (p: number) => ({ id: 1, price: +p.toFixed(2), remaining: pick([100, 30]) });
    yield {
      now: 1000 + Math.floor(rnd() * 20_000),
      stopAt: 20_000,
      mode: pick<SeriesMode>(["pending", "quoting", "pulled", "certain", "closed"]),
      certain: rnd() < 0.05,
      fair,
      desired,
      resting: pick([{}, { bid: side(rnd()) }, { ask: side(rnd()) }, { bid: side(rnd()), ask: side(rnd()) }]),
      lastQuote: pick([undefined, { fair: rnd(), at: Math.floor(rnd() * 20_000), wide: pick([undefined, true, false]) }]),
      wide: flags.includes("guard-wide"),
      tier: pick<BudgetTier | undefined>([undefined, "normal", "soft", "hard"]),
      divergence: div,
      pulledFor: pick([undefined, null, "band", "guard"] as const),
      cfg: { ...pick([legacy, lazy]), pullBelow: 0.03, pullAbove: 0.97, guardPull: 0.4 },
    };
  }
}

test("off (null, absent): decide() is the pre-change decide() (frozen copy), on 20 000 random inputs", () => {
  for (const inp of randomInputs(20_000)) {
    const before = decideBefore(inp);
    for (const pullReentry of [null, undefined]) assert.deepEqual(decide({ ...inp, cfg: { ...inp.cfg, pullReentry } }), before);
  }
});

test("on (0.02): the only change from the pre-change decide() is a hold, on an empty pulled strike pulled for the band or guard", () => {
  let held = 0;
  for (const inp of randomInputs(20_000)) {
    const before = decideBefore(inp);
    const now = decide({ ...inp, cfg: { ...inp.cfg, pullReentry: 0.02 } });
    if (JSON.stringify(now) === JSON.stringify(before)) continue;
    held++;
    assert.equal(before.kind, "quote");
    assert.deepEqual([now.kind, now.mode, inp.mode, !!(inp.resting.bid || inp.resting.ask), inp.pulledFor === "band" || inp.pulledFor === "guard"], ["none", "pulled", "pulled", false, true]);
    assert.match(now.reasons[0], /^pulled: .*pullReentry 0.02\)$/);
  }
  assert.ok(held >= 50, `only ${held} holds in the sample`); // 87 with this seed
});

test("config: policy.pullReentry is off by default and validated to [0, 0.2)", () => {
  assert.equal(loadConfig().policy.pullReentry, null);
  for (const ok of [0, 0.02, 0.19]) assert.equal(loadConfig({ policy: { pullReentry: ok } }).policy.pullReentry, ok);
  for (const bad of [-0.01, 0.2, 0.5, true]) assert.throws(() => loadConfig({ policy: { pullReentry: bad } }), /policy.pullReentry .* must be a number in \[0, 0.2\)/);
  // a string is named as one (it reads like the number otherwise)
  assert.throws(() => loadConfig({ policy: { pullReentry: "0.02" } }), /^Error: policy.pullReentry "0.02" must be a number in \[0, 0.2\)/);
  // the re-entry band must not be empty (it would keep a pulled strike pulled for good)
  assert.throws(() => loadConfig({ policy: { pullReentry: 0.15 }, quote: { pullBelow: 0.3, pullAbove: 0.6 } }), /re-entry band/);
  assert.throws(() => loadConfig({ policy: { pullReentry: 0.15 }, fair: { guardPull: 0.15 } }), /fair.guardPull/);
});
