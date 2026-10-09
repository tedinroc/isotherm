// Daily testnet-MON meter per role. Monad bills the GAS LIMIT, so the cost of a tx is gasLimit x gasPrice, known
// before sending. Three meters per role, per budget day (station-local, dayUtcOffsetMin):
//   "<role>"          quotes, re-quotes and replenishing (the QUOTING budget, dailyCapMon): refused above the cap;
//   "<role>:roll"     the ladder roll, when rollCapMon has a cap for the role (else the roll shares "<role>");
//   "<role>:reserve"  pulls, the close-time kill switch, the YES-margin withdraw after close, orphan cancels and the
//                     automatic stale void: NEVER refused by any budget (a refused pull leaves a stale quote for
//                     snipers; a refused kill leaves quotes after close). reserveMon is only the line above which
//                     such a tx is flagged `overBudget` (the Worker alerts on it). Until 2026-10-09 pulls shared the
//                     quoting meter and were refused once it passed cap + reserve.
// Budget tiers (optional, budget.softRatio): above softRatio x the quoting cap the maker widens its spreads and
// re-quotes only urgent strikes; at the cap it places no new quotes (an urgent strike is pulled instead).
export interface BudgetState {
  day: string; // budget day (station-local by default: dayUtcOffsetMin)
  spent: Record<string, number>; // meter -> MON billed today
  txs: Record<string, number>;
  history?: { day: string; spent: Record<string, number>; txs: Record<string, number> }[];
}

export type SpendKind = "roll" | "quote" | "replenish" | "pull" | "kill" | "void";

export interface BudgetCfg {
  dayUtcOffsetMin: number;
  dailyCapMon: Record<string, number>;
  reserveMon: Record<string, number>;
  /** Separate daily cap for the roll per role (meter "<role>:roll"). Absent/null = roll and quoting share one meter
   *  per role (legacy). With it, a day of re-quotes can no longer starve the next day's roll (2026-10-08 incident). */
  rollCapMon?: Partial<Record<string, number>> | null;
  /** Budget tiers: the soft threshold as a fraction of dailyCapMon (e.g. 0.6). Absent/null = no tiers. */
  softRatio?: number | null;
}

/** Kinds metered on "<role>:reserve" and never refused. */
export const RESERVE_KINDS: readonly SpendKind[] = ["pull", "kill", "void"];
export const isReserveKind = (kind: SpendKind) => RESERVE_KINDS.includes(kind);

/** The meter a spend is charged to (see the header). */
export function meterKey(role: string, kind: SpendKind, cfg: Pick<BudgetCfg, "rollCapMon">): string {
  if (isReserveKind(kind)) return `${role}:reserve`;
  return kind === "roll" && typeof cfg.rollCapMon?.[role] === "number" ? `${role}:roll` : role;
}

/** BudgetCfg from a maker config (structural, so this module needs no config import). */
export function budgetCfgOf(cfg: { budget: { dayUtcOffsetMin: number; dailyCapMon: Record<string, number>; reserveMon: Record<string, number>; rollCapMon?: Partial<Record<string, number>> | null; softRatio?: number | null } }): BudgetCfg {
  return { dayUtcOffsetMin: cfg.budget.dayUtcOffsetMin, dailyCapMon: cfg.budget.dailyCapMon, reserveMon: cfg.budget.reserveMon, rollCapMon: cfg.budget.rollCapMon ?? null, softRatio: cfg.budget.softRatio ?? null };
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
  overBudget: boolean; // allowed anyway (reserve meter) although above its line
  reason: string;
  spent: number;
  cap: number;
  remaining: number;
}

export function canSpend(b: BudgetState, role: string, costMon: number, kind: SpendKind, cfg: BudgetCfg, nowMs: number): SpendDecision {
  rollover(b, nowMs, cfg);
  const key = meterKey(role, kind, cfg);
  const spent = b.spent[key] ?? 0;
  const after = spent + costMon;
  if (isReserveKind(kind)) {
    // never refused: a pull / kill / withdraw / stale void costs less than the stale quote it removes
    const line = cfg.reserveMon[role] ?? 0;
    const over = after > line + 1e-12;
    const base = { spent: +spent.toFixed(6), cap: line, remaining: +Math.max(0, line - spent).toFixed(6) };
    return { ok: true, overBudget: over, reason: over ? `${kind} is never refused: ${role} reserve meter ${after.toFixed(4)} > ${line} MON (flagged)` : `${kind} within the ${role} reserve meter`, ...base };
  }
  const separateRoll = key !== role;
  const cap = separateRoll ? (cfg.rollCapMon![role] as number) : (cfg.dailyCapMon[role] ?? 0);
  const base = { spent: +spent.toFixed(6), cap, remaining: +Math.max(0, cap - spent).toFixed(6) };
  if (after <= cap + 1e-12) return { ok: true, overBudget: false, reason: "within daily cap", ...base };
  return { ok: false, overBudget: true, reason: `daily ${separateRoll ? `${role} roll` : role} cap ${cap} MON: spent ${spent.toFixed(4)} + ${costMon.toFixed(4)} would exceed it`, ...base };
}

/** Meter a billed tx. `kind` picks the meter (see meterKey); without it the role's main meter (legacy callers). */
export function recordSpend(b: BudgetState, role: string, costMon: number, nowMs: number, cfg: BudgetCfg, kind?: SpendKind) {
  rollover(b, nowMs, cfg);
  const key = kind ? meterKey(role, kind, cfg) : role;
  b.spent[key] = +((b.spent[key] ?? 0) + costMon).toFixed(9);
  b.txs[key] = (b.txs[key] ?? 0) + 1;
}

export type BudgetTier = "normal" | "soft" | "hard";
export interface TierInfo {
  tier: BudgetTier;
  spent: number;
  cap: number;
  soft: number | null;
}

/** The quoting budget tier of `role` for spends of `kind` (pure apart from the day rollover). Only the quoting meter
 *  has tiers: the roll meter (opening quotes of a new ladder) and the reserve meter are always "normal". */
export function quotingTier(b: BudgetState, role: string, kind: SpendKind, cfg: BudgetCfg, nowMs: number): TierInfo {
  rollover(b, nowMs, cfg);
  const key = meterKey(role, kind, cfg);
  const cap = cfg.dailyCapMon[role] ?? 0;
  const spent = b.spent[key] ?? 0;
  const ratio = cfg.softRatio;
  if (key !== role || typeof ratio !== "number") return { tier: "normal", spent, cap, soft: null };
  const soft = +(cap * ratio).toFixed(9);
  return { tier: spent >= cap - 1e-12 ? "hard" : spent >= soft - 1e-12 ? "soft" : "normal", spent, cap, soft };
}
