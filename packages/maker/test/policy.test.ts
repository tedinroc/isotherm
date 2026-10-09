import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type PolicyInput } from "../src/policy.ts";

const cfg = { requoteTicks: 2, staleHours: 6, refillRatio: 0.5, preStopSec: 90, tick: 0.01 };
const want = { pull: false as const, bid: 0.44, ask: 0.5, bidSize: 100, askSize: 100, half: 0.03, skew: 0, reasons: [] };
const resting = { bid: { id: 1, price: 0.44, remaining: 100 }, ask: { id: 2, price: 0.5, remaining: 100 } };
const base: PolicyInput = { now: 1000, stopAt: 10_000, mode: "quoting", certain: false, fair: 0.47, desired: want, resting, lastQuote: { fair: 0.47, at: 900 }, cfg };
const d = (o: Partial<PolicyInput>) => decide({ ...base, ...o });

test("unchanged quote -> no tx", () => assert.equal(d({}).kind, "none"));
test("no resting quote -> quote", () => assert.equal(d({ resting: {} }).kind, "quote"));
test("kill switch at stopAt and within preStopSec of it", () => {
  assert.equal(d({ now: 10_000 }).kind, "close");
  assert.equal(d({ now: 9_950 }).kind, "close");
  assert.equal(d({ now: 9_920, resting: {} }).kind, "close");
  assert.equal(d({ now: 9_900, resting: {} }).kind, "quote");
  assert.equal(d({ mode: "closed" }).kind, "close"); // closed but orders still there
  assert.equal(d({ mode: "closed", resting: {} }).kind, "none");
});
test("observed max >= strike -> pull (YES certain)", () => {
  const a = d({ certain: true });
  assert.equal(a.kind, "pull");
  assert.equal(a.mode, "certain");
  assert.equal(d({ certain: true, resting: {} }).kind, "none");
});
test("desired pull -> pull resting quotes", () => assert.equal(d({ desired: { pull: true, reasons: ["fair 0.99"] } }).kind, "pull"));
test("re-quote only when the price moves >= requoteTicks", () => {
  assert.equal(d({ desired: { ...want, bid: 0.45, ask: 0.51 }, fair: 0.479 }).kind, "none");
  const a = d({ desired: { ...want, bid: 0.46, ask: 0.52 }, fair: 0.49 });
  assert.equal(a.kind, "requote");
  assert.equal(a.urgent, false);
});
test("a filled side or a deep partial fill -> refill", () => {
  assert.equal(d({ resting: { ask: resting.ask } }).kind, "requote");
  assert.equal(d({ resting: { ...resting, ask: { ...resting.ask, remaining: 40 } } }).kind, "requote");
  assert.equal(d({ resting: { ...resting, ask: { ...resting.ask, remaining: 60 } } }).kind, "none");
});
test("stale quote -> requote", () => assert.equal(d({ now: 900 + 6 * 3600, stopAt: 100_000 }).kind, "requote"));
test("fair crossed a resting quote -> urgent requote", () => {
  const a = d({ fair: 0.51, desired: { ...want, bid: 0.48, ask: 0.54 } });
  assert.equal(a.kind, "requote");
  assert.equal(a.urgent, true);
});
test("requoteTicks 3 (the Worker): a 2-tick move of the desired price or of the fair is no re-quote, 3 ticks is", () => {
  const c3 = { ...cfg, requoteTicks: 3 };
  // the same 2-tick move that re-quotes at requoteTicks 2 (test above)
  assert.equal(d({ desired: { ...want, bid: 0.46, ask: 0.52 }, fair: 0.49 }).kind, "requote");
  assert.equal(d({ cfg: c3, desired: { ...want, bid: 0.46, ask: 0.52 }, fair: 0.49 }).kind, "none");
  const a = d({ cfg: c3, desired: { ...want, bid: 0.46, ask: 0.53 }, fair: 0.497 });
  assert.equal(a.kind, "requote");
  assert.equal(a.urgent, false);
  assert.deepEqual(a.reasons, ["ask 0.5 -> 0.53"]);
  // the fair alone (a wide resting quote, desired unchanged): 0.029 since the quote is not enough, 0.03 is
  const wide = { bid: { id: 1, price: 0.41, remaining: 100 }, ask: { id: 2, price: 0.53, remaining: 100 } };
  const same = { ...want, bid: 0.41, ask: 0.53 };
  assert.equal(d({ cfg: c3, resting: wide, desired: same, fair: 0.499 }).kind, "none");
  assert.deepEqual(d({ cfg: c3, resting: wide, desired: same, fair: 0.5 }).reasons, ["fair moved 0.47 -> 0.5"]);
});
test("the urgent rule does not depend on requoteTicks: fair at or through a resting price re-quotes at once", () => {
  for (const requoteTicks of [3, 10]) {
    const c = { ...cfg, requoteTicks };
    // desired == resting and the fair moved only 0.01 since the quote: the crossing alone triggers it
    const up = d({ cfg: c, fair: 0.5, lastQuote: { fair: 0.49, at: 900 } });
    assert.equal(up.kind, "requote");
    assert.equal(up.urgent, true);
    assert.deepEqual(up.reasons, ["resting ask 0.5 <= fair 0.5"]);
    const down = d({ cfg: c, fair: 0.44, lastQuote: { fair: 0.45, at: 900 } });
    assert.equal(down.urgent, true);
    assert.deepEqual(down.reasons, ["resting bid 0.44 >= fair 0.44"]);
  }
});

// ---------------------------------------------------------------- the lazy maker (policy.lazy; 2026-10-09)
const lazyCfg = { ...cfg, requoteTicks: 3, lazy: true, requoteFairMove: 0.04, staleRefreshHours: 2, staleRefreshMinMove: 0.02, oneSided: true };
const L = (o: Partial<PolicyInput>) => decide({ ...base, cfg: lazyCfg, ...o });

test("lazy: a drifting desired price or a 0.03 fair move is no re-quote; 0.04 is", () => {
  // the desired price moved 2-3 ticks (skew, a narrower spread, other quotes): no reason by itself
  assert.equal(L({ desired: { ...want, bid: 0.41, ask: 0.53 } }).kind, "none");
  assert.equal(L({ desired: { ...want, bid: 0.47, ask: 0.53 }, fair: 0.47 }).kind, "none");
  // the fair moved 0.039 since the quote (still inside a wide resting spread): quiet; 0.04: re-quote both sides
  const wide0 = { bid: { id: 1, price: 0.4, remaining: 100 }, ask: { id: 2, price: 0.56, remaining: 100 } };
  assert.equal(L({ resting: wide0, fair: 0.431, desired: { ...want, bid: 0.4, ask: 0.47 } }).kind, "none");
  assert.equal(L({ resting: wide0, fair: 0.43, desired: { ...want, bid: 0.4, ask: 0.47 } }).kind, "requote");
  const a = L({ fair: 0.51, desired: { ...want, bid: 0.48, ask: 0.54 } });
  assert.equal(a.kind, "requote");
  assert.equal(a.urgent, true); // 0.51 >= the resting ask 0.50
  assert.equal(a.sides, undefined);
  assert.match(a.reasons.join("; "), /fair moved 0.47 -> 0.51 \(>= 0.04\)/);
  // a wide resting quote, fair +0.04 but nothing crossed: non-urgent re-quote
  const wide = { bid: { id: 1, price: 0.4, remaining: 100 }, ask: { id: 2, price: 0.56, remaining: 100 } };
  const b = L({ resting: wide, fair: 0.51, desired: { ...want, bid: 0.48, ask: 0.54 } });
  assert.deepEqual([b.kind, b.urgent], ["requote", false]);
});

test("lazy: a stale quote is refreshed only if the fair also moved >= staleRefreshMinMove", () => {
  const old = { fair: 0.47, at: 1000 - 2 * 3600 };
  assert.equal(L({ lastQuote: old, fair: 0.485 }).kind, "none"); // 2 h old, moved 0.015
  const a = L({ lastQuote: old, fair: 0.49, desired: { ...want, bid: 0.46, ask: 0.52 } });
  assert.equal(a.kind, "requote");
  assert.match(a.reasons[0], /older than 2 h and fair moved 0.47 -> 0.49/);
  assert.equal(L({ lastQuote: { fair: 0.47, at: 1000 - 2 * 3600 + 1 }, fair: 0.49 }).kind, "none"); // 1 s short of 2 h
  // the legacy 6-hour unconditional refresh is gone in lazy mode
  assert.equal(L({ lastQuote: { fair: 0.47, at: 1000 - 7 * 3600 }, fair: 0.47 }).kind, "none");
});

test("lazy: urgent, fills and refills still re-quote; without a lastQuote the resting mid is the reference", () => {
  assert.equal(L({ fair: 0.5 }).urgent, true); // resting ask 0.50 <= fair
  assert.equal(L({ fair: 0.44 }).urgent, true);
  assert.equal(L({ resting: { bid: resting.bid } }).kind, "requote"); // the ask filled
  assert.equal(L({ resting: { ...resting, bid: { ...resting.bid, remaining: 40 } } }).kind, "requote");
  assert.equal(L({ desired: { ...want, ask: null, askSize: 0 } }).kind, "requote"); // ask no longer wanted
  // adopted orders (no lastQuote): mid 0.47; fair 0.508 is 0.038 away -> quiet, 0.512 -> re-quote
  assert.equal(L({ lastQuote: undefined, fair: 0.495, desired: { ...want, bid: 0.46, ask: 0.53 } }).kind, "none");
  const a = L({ lastQuote: undefined, fair: 0.515, desired: { ...want, bid: 0.48, ask: 0.55 } });
  assert.equal(a.kind, "requote");
  assert.match(a.reasons.join("; "), /vs the resting mid/);
});

test("lazy: entering guard-wide re-quotes (protective), leaving it does not", () => {
  const narrowLast = { fair: 0.47, at: 900, wide: false };
  const a = L({ lastQuote: narrowLast, wide: true, desired: { ...want, bid: 0.41, ask: 0.53 } });
  assert.equal(a.kind, "requote");
  assert.deepEqual(a.reasons, ["guard disagrees: widen the resting quote"]);
  assert.equal(L({ lastQuote: { ...narrowLast, wide: true }, wide: false }).kind, "none");
  assert.equal(L({ lastQuote: { fair: 0.47, at: 900 }, wide: true }).kind, "none"); // a lastQuote without the flag
});

test("one-sided: a filled side is refilled alone while the other side is still good; otherwise both", () => {
  const a = L({ resting: { bid: resting.bid } }); // the ask filled, the bid 0.44 is where it should be
  assert.deepEqual([a.kind, a.sides], ["requote", { bid: false, ask: true }]);
  const p = L({ resting: { ...resting, bid: { ...resting.bid, remaining: 40 } } });
  assert.deepEqual(p.sides, { bid: true, ask: false });
  // the kept side is >= requoteFairMove away from where the maker wants it now (skew after a big fill): both sides
  assert.equal(L({ resting: { bid: resting.bid }, desired: { ...want, bid: 0.4, ask: 0.46 } }).sides, undefined);
  // an urgent crossing re-centres both sides, even with the other side still near
  const u = L({ fair: 0.5, desired: { ...want, bid: 0.47, ask: 0.53 } });
  assert.deepEqual([u.urgent, u.sides], [true, undefined]);
  // an unwanted side (position cap) is cancelled alone
  assert.deepEqual(L({ desired: { ...want, bid: null, bidSize: 0 } }).sides, { bid: true, ask: false });
  // a fair move >= requoteFairMove re-centres the whole quote
  assert.equal(L({ resting: { bid: resting.bid }, fair: 0.51, desired: { ...want, bid: 0.48, ask: 0.54 } }).sides, undefined);
  // off without lastQuote, with oneSided off, and in legacy mode
  assert.equal(L({ resting: { bid: resting.bid }, lastQuote: undefined }).sides, undefined);
  assert.equal(L({ resting: { bid: resting.bid }, cfg: { ...lazyCfg, oneSided: false } }).sides, undefined);
  assert.equal(d({ resting: { bid: resting.bid } }).sides, undefined);
});

test("budget tiers: soft = only urgent re-quotes (new quotes still allowed); hard = nothing new, urgent -> pull", () => {
  for (const c of [cfg, lazyCfg]) {
    const t = (o: Partial<PolicyInput>) => decide({ ...base, cfg: c, ...o });
    // soft
    assert.equal(t({ tier: "soft", resting: { bid: resting.bid } }).kind, "none"); // a refill is not urgent
    assert.match(t({ tier: "soft", resting: { bid: resting.bid } }).reasons[0], /soft threshold: only urgent/);
    assert.deepEqual([t({ tier: "soft", fair: 0.51, desired: { ...want, bid: 0.45, ask: 0.57 } }).kind, t({ tier: "soft", fair: 0.51 }).urgent], ["requote", true]);
    assert.equal(t({ tier: "soft", resting: {} }).kind, "quote");
    // hard
    assert.equal(t({ tier: "hard", resting: {} }).kind, "none");
    assert.equal(t({ tier: "hard", resting: {}, mode: "pulled" }).mode, "pulled");
    assert.equal(t({ tier: "hard", resting: { bid: resting.bid } }).kind, "none");
    const u = t({ tier: "hard", fair: 0.51, desired: { ...want, bid: 0.45, ask: 0.57 } });
    assert.deepEqual([u.kind, u.urgent, u.mode], ["pull", true, "pulled"]);
    assert.match(u.reasons.at(-1)!, /pulled instead of re-quoted/);
    // the kill switch, certainty and a desired pull are never held back by a tier
    assert.equal(t({ tier: "hard", now: 10_000 }).kind, "close");
    assert.equal(t({ tier: "hard", certain: true }).kind, "pull");
    assert.equal(t({ tier: "hard", desired: { pull: true, reasons: ["fair 0.99"] } }).kind, "pull");
  }
});
