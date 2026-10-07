import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetDay, canSpend, recordSpend, type BudgetState } from "../src/budget.ts";

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
