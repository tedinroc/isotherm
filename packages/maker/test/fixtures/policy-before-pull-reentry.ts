// FROZEN COPY of policy.ts decide() before the pull hysteresis (as last committed, git 87a86d8; HEAD 5a47b9f has it
// unchanged). test/pull-hysteresis.test.ts compares the new decide() against it with policy.pullReentry off (null /
// absent) and on. Not used by the maker. If decide() is changed on purpose later, those tests fail by design: drop this
// file and them with it.
import type { Action, PolicyInput } from "../../src/policy.ts";

const EPS = 1e-9;

export function decideBefore(p: PolicyInput): Action {
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
