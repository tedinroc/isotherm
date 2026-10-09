import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetDay, canSpend, meterKey, quotingTier, recordSpend, type BudgetCfg, type BudgetState } from "../src/budget.ts";

const cfg = { dayUtcOffsetMin: 480, dailyCapMon: { maker: 1 }, reserveMon: { maker: 0.2 } };
const t = Date.parse("2026-10-07T15:59:00Z"); // 23:59 Taipei

test("budget day is the station-local day", () => {
  assert.equal(budgetDay(t, 480), "2026-10-07");
  assert.equal(budgetDay(t + 60_000, 480), "2026-10-08");
});

test("quoting cap; pulls, the kill switch and stale voids on their own reserve meter, never refused; reset at local midnight", () => {
  const b: BudgetState = { day: "", spent: {}, txs: {} };
  recordSpend(b, "maker", 0.95, t, cfg, "quote");
  assert.equal(canSpend(b, "maker", 0.04, "quote", cfg, t).ok, true);
  const refused = canSpend(b, "maker", 0.06, "quote", cfg, t);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /cap 1 MON/);
  // the quoting meter is far past its cap: a pull is still allowed (before 2026-10-09 it was refused past cap + reserve)
  recordSpend(b, "maker", 5, t, cfg, "quote");
  const pull = canSpend(b, "maker", 0.06, "pull", cfg, t);
  assert.deepEqual([pull.ok, pull.overBudget], [true, false]);
  const bigPull = canSpend(b, "maker", 0.3, "pull", cfg, t); // above the 0.2 reserve line: flagged, still allowed
  assert.deepEqual([bigPull.ok, bigPull.overBudget], [true, true]);
  assert.match(bigPull.reason, /never refused/);
  const kill = canSpend(b, "maker", 5, "kill", cfg, t);
  assert.deepEqual([kill.ok, kill.overBudget], [true, true]);
  assert.equal(canSpend(b, "operator", 0.01, "void", cfg, t).ok, true); // a role without any cap
  recordSpend(b, "maker", 0.03, t, cfg, "pull");
  recordSpend(b, "maker", 0.12, t, cfg, "kill");
  recordSpend(b, "operator", 0.0086, t, cfg, "void");
  assert.deepEqual(b.spent, { maker: 5.95, "maker:reserve": 0.15, "operator:reserve": 0.0086 });
  assert.deepEqual(b.txs, { maker: 2, "maker:reserve": 2, "operator:reserve": 1 });
  // ... and reserve spend never eats the quoting cap
  const b2: BudgetState = { day: "", spent: {}, txs: {} };
  recordSpend(b2, "maker", 0.9, t, cfg, "pull");
  assert.equal(canSpend(b2, "maker", 0.9, "quote", cfg, t).ok, true);
  assert.equal(canSpend(b, "maker", 0.5, "quote", cfg, t + 120_000).ok, true); // new day
  assert.equal(b.day, "2026-10-08");
  assert.equal(b.history?.[0].spent.maker, 5.95);
});

test("separate roll budget: a day of re-quotes can no longer starve the next day's roll (2026-10-08 incident)", () => {
  const now = Date.parse("2026-10-08T09:00:00Z");
  const shared: BudgetCfg = { dayUtcOffsetMin: 480, dailyCapMon: { maker: 1.2 }, reserveMon: { maker: 0.2 } };
  const split: BudgetCfg = { ...shared, rollCapMon: { maker: 0.8 } };
  // legacy (one meter): quoting used the whole cap, so the next day's mintSet is refused -- the incident
  const a: BudgetState = { day: "", spent: {}, txs: {} };
  recordSpend(a, "maker", 1.19, now, shared, "quote");
  assert.equal(canSpend(a, "maker", 0.03, "roll", shared, now).ok, false);
  // separate meters: the same quoting day leaves the roll budget untouched
  const b: BudgetState = { day: "", spent: {}, txs: {} };
  recordSpend(b, "maker", 1.19, now, split, "quote");
  const r = canSpend(b, "maker", 0.03, "roll", split, now);
  assert.equal(r.ok, true, r.reason);
  recordSpend(b, "maker", 0.03, now, split, "roll");
  assert.deepEqual(b.spent, { maker: 1.19, "maker:roll": 0.03 });
  assert.deepEqual(b.txs, { maker: 1, "maker:roll": 1 });
  // ... and roll spend cannot eat the quoting budget either; the roll meter has its own cap and no reserve
  assert.equal(canSpend(b, "maker", 0.009, "quote", split, now).ok, true);
  assert.equal(canSpend(b, "maker", 0.78, "roll", split, now).ok, false);
  assert.match(canSpend(b, "maker", 0.78, "roll", split, now).reason, /maker roll cap 0.8/);
  // a role without a roll cap keeps the shared meter
  assert.equal(meterKey("operator", "roll", split), "operator");
  assert.equal(meterKey("maker", "roll", split), "maker:roll");
  assert.equal(meterKey("maker", "kill", split), "maker:reserve");
  assert.equal(meterKey("maker", "pull", shared), "maker:reserve");
  // both meters roll over at the budget day boundary (Taipei midnight)
  const next = Date.parse("2026-10-08T16:00:01Z");
  assert.equal(canSpend(b, "maker", 0.79, "roll", split, next).ok, true);
  assert.deepEqual(b.spent, {});
});

test("budget tiers on the quoting meter: normal below the soft line, soft from softRatio x cap, hard at the cap", () => {
  const tc: BudgetCfg = { dayUtcOffsetMin: 480, dailyCapMon: { maker: 1.5 }, reserveMon: { maker: 0.4 }, rollCapMon: { maker: 0.8 }, softRatio: 0.6 };
  const b: BudgetState = { day: "", spent: {}, txs: {} };
  assert.deepEqual(quotingTier(b, "maker", "quote", tc, t), { tier: "normal", spent: 0, cap: 1.5, soft: 0.9 });
  recordSpend(b, "maker", 0.89, t, tc, "quote");
  assert.equal(quotingTier(b, "maker", "quote", tc, t).tier, "normal");
  recordSpend(b, "maker", 0.01, t, tc, "quote");
  assert.equal(quotingTier(b, "maker", "quote", tc, t).tier, "soft");
  recordSpend(b, "maker", 2, t, tc, "pull"); // reserve spend does not move the tier
  assert.equal(quotingTier(b, "maker", "quote", tc, t).tier, "soft");
  recordSpend(b, "maker", 0.6, t, tc, "quote");
  assert.equal(quotingTier(b, "maker", "quote", tc, t).tier, "hard");
  // the opening quotes of a new ladder are on the roll meter: no tiers there
  assert.equal(quotingTier(b, "maker", "roll", tc, t).tier, "normal");
  // no softRatio -> no tiers (the Mac's config)
  assert.equal(quotingTier(b, "maker", "quote", { ...tc, softRatio: null }, t).tier, "normal");
  assert.equal(quotingTier(b, "maker", "quote", { ...tc, softRatio: null }, t).soft, null);
  // a new budget day starts normal again
  assert.equal(quotingTier(b, "maker", "quote", tc, t + 120_000).tier, "normal");
});
