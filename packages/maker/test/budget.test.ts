import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetDay, canSpend, meterKey, recordSpend, type BudgetCfg, type BudgetState } from "../src/budget.ts";

const cfg = { dayUtcOffsetMin: 480, dailyCapMon: { maker: 1 }, reserveMon: { maker: 0.2 } };
const t = Date.parse("2026-10-07T15:59:00Z"); // 23:59 Taipei

test("budget day is the station-local day", () => {
  assert.equal(budgetDay(t, 480), "2026-10-07");
  assert.equal(budgetDay(t + 60_000, 480), "2026-10-08");
});

test("cap, reserve for pulls, kill never refused; meter resets at local midnight", () => {
  const b: BudgetState = { day: "", spent: {}, txs: {} };
  recordSpend(b, "maker", 0.95, t, cfg);
  assert.equal(canSpend(b, "maker", 0.04, "quote", cfg, t).ok, true);
  const refused = canSpend(b, "maker", 0.06, "quote", cfg, t);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /cap 1 MON/);
  assert.equal(canSpend(b, "maker", 0.06, "pull", cfg, t).ok, true);
  assert.equal(canSpend(b, "maker", 0.3, "pull", cfg, t).ok, false);
  const kill = canSpend(b, "maker", 5, "kill", cfg, t);
  assert.deepEqual([kill.ok, kill.overBudget], [true, true]);
  assert.equal(canSpend(b, "maker", 0.5, "quote", cfg, t + 120_000).ok, true); // new day
  assert.equal(b.day, "2026-10-08");
  assert.equal(b.history?.[0].spent.maker, 0.95);
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
  assert.equal(meterKey("maker", "kill", split), "maker");
  // both meters roll over at the budget day boundary (Taipei midnight)
  const next = Date.parse("2026-10-08T16:00:01Z");
  assert.equal(canSpend(b, "maker", 0.79, "roll", split, next).ok, true);
  assert.deepEqual(b.spent, {});
});
