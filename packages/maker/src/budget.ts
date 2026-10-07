// Daily testnet-MON meter per role. Monad bills the GAS LIMIT, so the cost of a tx is gasLimit x gasPrice, known
// before sending. Quotes and roll steps must fit under the daily cap; pulls may also use a reserve on top; the
// close-time kill switch is never refused (stale quotes after close are free money for snipers), only flagged.
export interface BudgetState {
  day: string; // budget day (station-local by default: dayUtcOffsetMin)
  spent: Record<string, number>; // role -> MON billed today
  txs: Record<string, number>;
  history?: { day: string; spent: Record<string, number>; txs: Record<string, number> }[];
}

export type SpendKind = "roll" | "quote" | "replenish" | "pull" | "kill";

export interface BudgetCfg {
  dayUtcOffsetMin: number;
  dailyCapMon: Record<string, number>;
  reserveMon: Record<string, number>;
}

export function budgetDay(nowMs: number, offsetMin: number): string {
  return new Date(nowMs + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** Start a new day if needed (keeps the last 14 days of history). Mutates and returns `b`. */
export function rollover(b: BudgetState, nowMs: number, cfg: BudgetCfg): BudgetState {
  const d = budgetDay(nowMs, cfg.dayUtcOffsetMin);
  if (b.day !== d) {
    if (b.day) (b.history ??= []).push({ day: b.day, spent: b.spent, txs: b.txs });
    b.history = (b.history ?? []).slice(-14);
    b.day = d;
    b.spent = {};
    b.txs = {};
  }
  return b;
}

export interface SpendDecision {
  ok: boolean;
  overBudget: boolean; // allowed anyway (kill switch) although over cap + reserve
  reason: string;
  spent: number;
  cap: number;
  remaining: number;
}

export function canSpend(b: BudgetState, role: string, costMon: number, kind: SpendKind, cfg: BudgetCfg, nowMs: number): SpendDecision {
  rollover(b, nowMs, cfg);
  const spent = b.spent[role] ?? 0;
  const cap = cfg.dailyCapMon[role] ?? 0;
  const reserve = cfg.reserveMon[role] ?? 0;
  const after = spent + costMon;
  const base = { spent: +spent.toFixed(6), cap, remaining: +Math.max(0, cap - spent).toFixed(6) };
  if (after <= cap + 1e-12) return { ok: true, overBudget: false, reason: "within daily cap", ...base };
  if (kind === "pull" && after <= cap + reserve + 1e-12) return { ok: true, overBudget: false, reason: "pull uses the reserve", ...base };
  if (kind === "kill") return { ok: true, overBudget: after > cap + reserve, reason: "kill switch is never refused", ...base };
  return { ok: false, overBudget: true, reason: `daily ${role} cap ${cap} MON: spent ${spent.toFixed(4)} + ${costMon.toFixed(4)} would exceed it`, ...base };
}

export function recordSpend(b: BudgetState, role: string, costMon: number, nowMs: number, cfg: BudgetCfg) {
  rollover(b, nowMs, cfg);
  b.spent[role] = +((b.spent[role] ?? 0) + costMon).toFixed(9);
  b.txs[role] = (b.txs[role] ?? 0) + 1;
}
