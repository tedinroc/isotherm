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
