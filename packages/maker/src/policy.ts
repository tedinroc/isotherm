// What to do with one strike this tick (pure). Re-quoting costs ~0.058 MON on Monad (cancel 2 + place 2; Monad bills
// the gas limit), so it happens only when it matters. Close-time and certainty pull everything, in every mode.
//
// LEGACY rules (policy.lazy off): no quote yet, a side filled / refill needed, the desired price moved >= requoteTicks,
// the resting quote is on the wrong side of fair (urgent), the fair moved >= requoteTicks since the quote, or the quote
// is older than staleHours.
//
// LAZY rules (policy.lazy on, the "lazy maker" of 2026-10-09): re-quote a strike only when
//   (a) urgent: the fair is at or through a resting price;
//   (b) a side was filled or needs a refill (or is no longer wanted: position cap, margin);
//   (c) |fair - lastQuote.fair| >= requoteFairMove;
//   (d) the quote is older than staleRefreshHours AND |fair - lastQuote.fair| >= staleRefreshMinMove;
//   (e) the guard now wants the wide spread and the resting quote was placed narrow (entering guard-wide is protective;
//       leaving it is not a reason by itself, and the guard-wide hysteresis in fair.ts still applies).
// The desired price drifting (skew, other participants, a spread that would narrow) is NOT a reason by itself.
// Without a lastQuote (orders adopted from the books) the resting mid stands in for lastQuote.fair in (c).
//
// ONE-SIDED (policy.oneSided, with lazy): when only side-specific, non-urgent reasons fire -- (b): a fill, a refill, an
// unwanted side -- and the other side is resting, uncrossed and within requoteFairMove of where the maker wants it, only
// the side that needs it is replaced (`sides`), with lastQuote's fair/time kept. Measured on a fork: one side costs
// 55-66 % of a full re-quote. An urgent crossing always re-centres both sides.
//
// BUDGET TIERS (`tier`, from budget.ts quotingTier): "soft" -> only urgent re-quotes (new quotes on an empty strike
// still go out, with the wider spread pricing.ts applies); "hard" -> no new quotes and no re-quotes; an urgent strike is
// PULLED instead (pulls are metered on the reserve meter and never refused).
import type { BudgetTier } from "./budget.ts";
import type { QuoteDecision } from "./pricing.ts";
import type { SeriesMode } from "./state-core.ts";

export interface RestingSide {
  id: number;
  price: number;
  remaining: number;
}
export interface PolicyCfg {
  requoteTicks: number;
  staleHours: number;
  refillRatio: number;
  preStopSec: number;
  tick: number;
  lazy?: boolean | null;
  requoteFairMove?: number | null;
  staleRefreshHours?: number | null;
  staleRefreshMinMove?: number | null;
  oneSided?: boolean | null;
}
export interface PolicyInput {
  now: number; // unix s
  stopAt: number; // kill-switch time for this ladder
  mode: SeriesMode;
  certain: boolean; // observed max >= strike
  fair: number | null;
  desired: QuoteDecision;
  resting: { bid?: RestingSide; ask?: RestingSide };
  lastQuote?: { fair: number; at: number; wide?: boolean };
  /** the desired quote carries the guard-wide spread (fair flags) */
  wide?: boolean;
  /** quoting budget tier (absent = "normal") */
  tier?: BudgetTier;
  cfg: PolicyCfg;
}

export type ActionKind = "none" | "quote" | "requote" | "pull" | "close";
export interface Action {
  kind: ActionKind;
  urgent: boolean;
  reasons: string[];
  mode?: SeriesMode; // mode to record after acting
  /** requote only: the sides to replace (one-sided update). Absent = both. */
  sides?: { bid: boolean; ask: boolean };
}

const EPS = 1e-9;

export function decide(p: PolicyInput): Action {
  const hasResting = !!(p.resting.bid || p.resting.ask);
  const step = p.cfg.requoteTicks * p.cfg.tick - EPS;
  if (p.mode === "closed") return hasResting ? { kind: "close", urgent: true, reasons: ["closed series still has resting orders"], mode: "closed" } : { kind: "none", urgent: false, reasons: ["closed"] };
  if (p.now >= p.stopAt - p.cfg.preStopSec)
    return { kind: "close", urgent: true, reasons: [`kill switch: ${p.now >= p.stopAt ? "past" : "within " + p.cfg.preStopSec + " s of"} stop-quoting time`], mode: "closed" };
  if (p.certain) return hasResting ? { kind: "pull", urgent: true, reasons: ["observed max >= strike: YES certain"], mode: "certain" } : { kind: "none", urgent: false, reasons: ["certain"], mode: "certain" };
  const d = p.desired;
  if (d.pull) return hasResting ? { kind: "pull", urgent: true, reasons: d.reasons, mode: "pulled" } : { kind: "none", urgent: false, reasons: d.reasons, mode: "pulled" };
  if (!hasResting) {
    if (p.tier === "hard") return { kind: "none", urgent: false, reasons: ["quoting budget spent for today: no new quotes"], mode: p.mode === "pending" ? "pending" : "pulled" };
    return { kind: "quote", urgent: false, reasons: ["no resting quote"], mode: "quoting" };
  }

  const reasons: string[] = [];
  const need = { bid: false, ask: false }; // side-specific reasons
  let both = false; // a reason that re-centres the whole quote
  let urgent = false;
  const { bid, ask } = p.resting;
  if (p.fair !== null && bid && bid.price >= p.fair) (urgent = true), (need.bid = true), reasons.push(`resting bid ${bid.price} >= fair ${p.fair}`);
  if (p.fair !== null && ask && ask.price <= p.fair) (urgent = true), (need.ask = true), reasons.push(`resting ask ${ask.price} <= fair ${p.fair}`);
  if ((d.bid === null) !== !bid) (need.bid = true), reasons.push(d.bid === null ? "bid no longer wanted" : "bid side empty (filled)");
  if ((d.ask === null) !== !ask) (need.ask = true), reasons.push(d.ask === null ? "ask no longer wanted" : "ask side empty (filled)");
  if (!p.cfg.lazy) {
    if (d.bid !== null && bid && Math.abs(d.bid - bid.price) >= step) (both = true), reasons.push(`bid ${bid.price} -> ${d.bid}`);
    if (d.ask !== null && ask && Math.abs(d.ask - ask.price) >= step) (both = true), reasons.push(`ask ${ask.price} -> ${d.ask}`);
  }
  if (d.bid !== null && bid && bid.remaining < p.cfg.refillRatio * d.bidSize) (need.bid = true), reasons.push(`bid partly filled (${bid.remaining} left)`);
  if (d.ask !== null && ask && ask.remaining < p.cfg.refillRatio * d.askSize) (need.ask = true), reasons.push(`ask partly filled (${ask.remaining} left)`);

  if (!p.cfg.lazy) {
    if (p.lastQuote && p.fair !== null && Math.abs(p.fair - p.lastQuote.fair) >= step) (both = true), reasons.push(`fair moved ${p.lastQuote.fair} -> ${p.fair}`);
    if (p.lastQuote && p.now - p.lastQuote.at >= p.cfg.staleHours * 3600) (both = true), reasons.push(`quote older than ${p.cfg.staleHours} h`);
  } else {
    const move = p.cfg.requoteFairMove ?? 0.04;
    const ref = p.lastQuote?.fair ?? (bid && ask ? +((bid.price + ask.price) / 2).toFixed(4) : null);
    if (ref !== null && p.fair !== null) {
      const mv = Math.abs(p.fair - ref);
      const staleH = p.cfg.staleRefreshHours ?? 2;
      if (mv >= move - EPS) (both = true), reasons.push(`fair moved ${ref} -> ${p.fair} (>= ${move}${p.lastQuote ? "" : ", vs the resting mid"})`);
      else if (p.lastQuote && p.now - p.lastQuote.at >= staleH * 3600 && mv >= (p.cfg.staleRefreshMinMove ?? 0.02) - EPS)
        (both = true), reasons.push(`quote older than ${staleH} h and fair moved ${ref} -> ${p.fair}`);
    }
    if (p.wide === true && p.lastQuote?.wide === false) (both = true), reasons.push("guard disagrees: widen the resting quote");
  }

  if (!reasons.length) return { kind: "none", urgent: false, reasons: ["quote still good"], mode: "quoting" };
  if (p.tier === "hard") {
    if (urgent) return { kind: "pull", urgent: true, reasons: [...reasons, "quoting budget spent for today: pulled instead of re-quoted"], mode: "pulled" };
    return { kind: "none", urgent: false, reasons: [`quoting budget spent for today: not re-quoted (${reasons.join("; ")})`], mode: "quoting" };
  }
  if (p.tier === "soft" && !urgent) return { kind: "none", urgent: false, reasons: [`quoting budget above the soft threshold: only urgent re-quotes (${reasons.join("; ")})`], mode: "quoting" };

  const out: Action = { kind: "requote", urgent, reasons, mode: "quoting" };
  // one-sided only for a fill / refill / unwanted side: an urgent crossing re-centres the whole quote (a crossing means
  // the fair moved by about the half-spread, so the other side is that far off too; replay of 2026-10-09)
  if (p.cfg.lazy && p.cfg.oneSided && !both && !urgent && p.lastQuote && need.bid !== need.ask) {
    // keep the other side if it is resting, not crossed and still close to where the maker wants it
    const keep = need.bid ? "ask" : "bid";
    const r = p.resting[keep];
    const want = keep === "bid" ? d.bid : d.ask;
    const tol = (p.cfg.requoteFairMove ?? 0.04) - EPS;
    if (r && want !== null && Math.abs(r.price - want) < tol) out.sides = { bid: need.bid, ask: need.ask };
  }
  return out;
}
