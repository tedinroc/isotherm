// Cutover helper (pure, no I/O): turn the Mac maker's state.json into the state the Worker imports.
//
// The Mac's Node runner keeps ONE MON meter per role per Taipei day: roll steps and quotes share it (config
// local.json: maker cap 3.0). The Worker meters the roll separately (config/worker.json: rollCapMon maker 0.8, plus
// a quoting cap of 2.2). Imported as is, the Mac's whole day (roll included) would count against the Worker's
// smaller quoting cap: on a day like 2026-10-08 (maker 2.45 MON, 0.27 of it roll) the Worker would refuse every
// re-quote until Taipei midnight. With the Mac's txs.jsonl, today's spend is re-booked per kind: roll steps onto
// "<role>:roll", pulls / kill switch / withdraws onto "<role>:reserve", everything else onto "<role>". Without the tx log (or if it does not add up to the state's meters)
// the meters are imported unchanged, which is the conservative choice.
//
// The state's `deployment.source` is the Mac's local file path; it is replaced (it is informational only).

export const ROLL_ROLES = ["maker", "operator", "marketCreator"];

export function budgetDay(ms, offsetMin = 480) {
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10);
}

/**
 * @param {any} state       the Mac's state.json (parsed)
 * @param {string|null} txsJsonl  the Mac's txs.jsonl (text) or null
 * @param {{ dayUtcOffsetMin?: number, rollRoles?: string[], tolerance?: number }} [o]
 * @returns {{ state: any, notes: string[] }}
 */
export function prepareImport(state, txsJsonl, o = {}) {
  const offset = o.dayUtcOffsetMin ?? 480;
  const rollRoles = new Set(o.rollRoles ?? ROLL_ROLES);
  const tol = o.tolerance ?? 1e-4;
  const notes = [];
  const out = structuredClone(state);
  if (out.deployment && typeof out.deployment === "object") out.deployment.source = "imported from the Mac maker's state.json";
  const b = out.budget;
  if (!b || !b.day || !b.spent || !Object.keys(b.spent).length) {
    notes.push("budget: nothing spent today on the Mac; meters start empty");
    return { state: out, notes };
  }
  if (!txsJsonl) {
    notes.push(`budget: no txs.jsonl; the Mac's meters for ${b.day} are imported unchanged (roll spend counts against the quoting cap today)`);
    return { state: out, notes };
  }
  const spent = {}, txs = {}, perRole = {};
  for (const line of txsJsonl.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(r.t);
    if (!Number.isFinite(t) || budgetDay(t, offset) !== b.day || typeof r.mon !== "number" || !r.role) continue;
    // pulls, the kill switch, withdraws and voids go to the reserve meter (never refused; packages/maker budget.ts)
    const key = ["pull", "kill", "void"].includes(r.kind) ? `${r.role}:reserve` : r.kind === "roll" && rollRoles.has(r.role) ? `${r.role}:roll` : r.role;
    spent[key] = +((spent[key] ?? 0) + r.mon).toFixed(9);
    txs[key] = (txs[key] ?? 0) + 1;
    perRole[r.role] = (perRole[r.role] ?? 0) + r.mon;
  }
  // the tx log must account for the state's meters (txs.jsonl rounds each tx to 6 dp)
  for (const [role, v] of Object.entries(b.spent)) {
    const n = b.txs?.[role] ?? 1;
    if (Math.abs((perRole[role] ?? 0) - v) > tol + n * 1e-6) {
      notes.push(`budget: txs.jsonl has ${(perRole[role] ?? 0).toFixed(6)} MON for ${role} on ${b.day}, the state ${Number(v).toFixed(6)}; meters imported unchanged`);
      return { state: out, notes };
    }
  }
  b.spent = spent;
  b.txs = txs;
  notes.push(`budget ${b.day} re-booked for the Worker's meters: ${Object.entries(spent).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(", ")}`);
  return { state: out, notes };
}
