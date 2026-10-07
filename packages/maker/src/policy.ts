// What to do with one strike this tick (pure). Re-quoting costs ~0.05 MON on Monad, so it happens only when it
// matters: no quote yet, a side filled/refill needed, the desired price moved >= requoteTicks, the resting quote is
// now on the wrong side of fair (urgent), or it is older than staleHours. Close-time and certainty pull everything.
import type { QuoteDecision } from "./pricing.ts";
import type { SeriesMode } from "./state.ts";

export interface RestingSide {
  id: number;
  price: number;
  remaining: number;
}
export interface PolicyInput {
  now: number; // unix s
  stopAt: number; // kill-switch time for this ladder
  mode: SeriesMode;
  certain: boolean; // observed max >= strike
  fair: number | null;
  desired: QuoteDecision;
  resting: { bid?: RestingSide; ask?: RestingSide };
  lastQuote?: { fair: number; at: number };
  cfg: { requoteTicks: number; staleHours: number; refillRatio: number; preStopSec: number; tick: number };
}

export type ActionKind = "none" | "quote" | "requote" | "pull" | "close";
export interface Action {
  kind: ActionKind;
  urgent: boolean;
  reasons: string[];
  mode?: SeriesMode; // mode to record after acting
}

export function decide(p: PolicyInput): Action {
  const hasResting = !!(p.resting.bid || p.resting.ask);
  const step = p.cfg.requoteTicks * p.cfg.tick - 1e-9;
  if (p.mode === "closed") return hasResting ? { kind: "close", urgent: true, reasons: ["closed series still has resting orders"], mode: "closed" } : { kind: "none", urgent: false, reasons: ["closed"] };
  if (p.now >= p.stopAt - p.cfg.preStopSec)
    return { kind: "close", urgent: true, reasons: [`kill switch: ${p.now >= p.stopAt ? "past" : "within " + p.cfg.preStopSec + " s of"} stop-quoting time`], mode: "closed" };
  if (p.certain) return hasResting ? { kind: "pull", urgent: true, reasons: ["observed max >= strike: YES certain"], mode: "certain" } : { kind: "none", urgent: false, reasons: ["certain"], mode: "certain" };
  const d = p.desired;
  if (d.pull) return hasResting ? { kind: "pull", urgent: true, reasons: d.reasons, mode: "pulled" } : { kind: "none", urgent: false, reasons: d.reasons, mode: "pulled" };
  if (!hasResting) return { kind: "quote", urgent: false, reasons: ["no resting quote"], mode: "quoting" };

  const reasons: string[] = [];
  let urgent = false;
  const { bid, ask } = p.resting;
  if (p.fair !== null && bid && bid.price >= p.fair) (urgent = true), reasons.push(`resting bid ${bid.price} >= fair ${p.fair}`);
  if (p.fair !== null && ask && ask.price <= p.fair) (urgent = true), reasons.push(`resting ask ${ask.price} <= fair ${p.fair}`);
  if ((d.bid === null) !== !bid) reasons.push(d.bid === null ? "bid no longer wanted" : "bid side empty (filled)");
  if ((d.ask === null) !== !ask) reasons.push(d.ask === null ? "ask no longer wanted" : "ask side empty (filled)");
  if (d.bid !== null && bid && Math.abs(d.bid - bid.price) >= step) reasons.push(`bid ${bid.price} -> ${d.bid}`);
  if (d.ask !== null && ask && Math.abs(d.ask - ask.price) >= step) reasons.push(`ask ${ask.price} -> ${d.ask}`);
  if (d.bid !== null && bid && bid.remaining < p.cfg.refillRatio * d.bidSize) reasons.push(`bid partly filled (${bid.remaining} left)`);
  if (d.ask !== null && ask && ask.remaining < p.cfg.refillRatio * d.askSize) reasons.push(`ask partly filled (${ask.remaining} left)`);
  if (p.lastQuote && p.fair !== null && Math.abs(p.fair - p.lastQuote.fair) >= step) reasons.push(`fair moved ${p.lastQuote.fair} -> ${p.fair}`);
  if (p.lastQuote && p.now - p.lastQuote.at >= p.cfg.staleHours * 3600) reasons.push(`quote older than ${p.cfg.staleHours} h`);
  if (!reasons.length) return { kind: "none", urgent: false, reasons: ["quote still good"], mode: "quoting" };
  return { kind: "requote", urgent, reasons, mode: "quoting" };
}
