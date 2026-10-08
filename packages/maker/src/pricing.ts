// Quote construction (pure). Around fair = Polymarket-implied P(Tmax >= k):
//   half-spread = halfSpreadTicks x tick, widened when the guard disagrees or when quoting off the fallback model;
//   inventory skew shifts both sides against the position; bid < fair < ask always (never a negative-edge quote);
//   prices on the maker grid inside [minPrice, maxPrice]; post-only safe (never crosses anybody else's quote);
//   sizes capped by free margin and by the position limit. Prices are handled in integer 0.001 units.
import type { QuoteCfg } from "./config-core.ts";

export interface QuoteInput {
  fair: number | null;
  source: string; // FairSource
  flags: string[];
  netYes: number; // YES delta for this strike: +long YES / -short YES
  freeYes: number; // YES that asks may lock (free margin + our resting ask that the requote cancels)
  freeAusd: number; // AUSD that bids may lock (same idea)
  others: { bid: number | null; ask: number | null }; // everyone else's best quotes on this book
  cfg: QuoteCfg;
}

export type QuoteDecision =
  | { pull: true; reasons: string[] }
  | { pull: false; bid: number | null; ask: number | null; bidSize: number; askSize: number; half: number; skew: number; reasons: string[] };

const M = 1000; // price units per 1.0 AUSD (0.001 = 1 unit)
const EPS = 1e-9;

export function makeQuote(q: QuoteInput): QuoteDecision {
  const c = q.cfg;
  const reasons: string[] = [];
  if (q.fair === null || q.source === "none") return { pull: true, reasons: ["no usable fair value"] };
  if (q.flags.includes("guard-pull")) return { pull: true, reasons: ["Polymarket and the guard model disagree by > guardPull"] };
  if (q.fair <= c.pullBelow + EPS || q.fair >= c.pullAbove - EPS) return { pull: true, reasons: [`fair ${q.fair} outside (${c.pullBelow}, ${c.pullAbove}): outcome ~known`] };

  let widen = 1;
  if (q.flags.includes("guard-wide")) (widen *= c.guardWidenMult), reasons.push(`guard disagrees: x${c.guardWidenMult} spread`);
  if (q.source.startsWith("fallback")) (widen *= c.fallbackWidenMult), reasons.push(`fallback fair (${q.source}): x${c.fallbackWidenMult} spread`);
  const tickU = Math.round(c.tick * M);
  const kTickU = Math.round(c.kuruTick * M);
  const half = c.halfSpreadTicks * c.tick * widen;
  const inv = Math.max(-1, Math.min(1, q.netYes / c.maxPositionYes));
  const skew = -c.skewTicksAtCap * c.tick * inv;
  if (Math.abs(skew) > EPS) reasons.push(`inventory skew ${skew >= 0 ? "+" : ""}${skew.toFixed(3)} (net YES ${q.netYes.toFixed(2)})`);
  const fairU = q.fair * M;
  let bidU: number | null = Math.floor(((q.fair + skew - half) * M + EPS) / tickU) * tickU;
  let askU: number | null = Math.ceil(((q.fair + skew + half) * M - EPS) / tickU) * tickU;
  // never a negative-edge price vs fair
  while (bidU !== null && bidU >= fairU - EPS) bidU -= tickU;
  while (askU !== null && askU <= fairU + EPS) askU += tickU;
  const minU = Math.round(c.minPrice * M), maxU = Math.round(c.maxPrice * M);
  if (bidU < minU) bidU = minU < fairU - EPS ? minU : null;
  if (askU > maxU) askU = maxU > fairU + EPS ? maxU : null;
  // post-only: never cross another participant (the maker never takes)
  if (bidU !== null && q.others.ask !== null) {
    const oa = Math.round(q.others.ask * M);
    if (bidU >= oa) {
      bidU = Math.floor((oa - kTickU) / tickU) * tickU;
      reasons.push(`bid stepped below someone's ask ${q.others.ask}`);
      if (bidU < minU) bidU = null;
    }
  }
  if (askU !== null && q.others.bid !== null) {
    const ob = Math.round(q.others.bid * M);
    if (askU <= ob) {
      askU = Math.ceil((ob + kTickU) / tickU) * tickU;
      reasons.push(`ask stepped above someone's bid ${q.others.bid}`);
      if (askU > maxU) askU = null;
    }
  }
  if (bidU !== null && askU !== null && bidU >= askU) return { pull: true, reasons: ["would cross itself"] }; // unreachable: bid < fair < ask
  // sizes: position cap, free margin, minimum order
  const bid = bidU === null ? null : bidU / M;
  const ask = askU === null ? null : askU / M;
  let bidSize = 0, askSize = 0;
  if (bid !== null) {
    const room = c.maxPositionYes - q.netYes;
    bidSize = Math.floor(Math.min(c.sizeYes, room, q.freeAusd / bid) + EPS);
    if (room <= 0) reasons.push("long-YES cap reached: no bid");
  }
  if (ask !== null) {
    const room = c.maxPositionYes + q.netYes;
    askSize = Math.floor(Math.min(c.sizeYes, room, q.freeYes) + EPS);
    if (room <= 0) reasons.push("short-YES cap reached: no ask");
  }
  const finalBid = bid !== null && bidSize >= c.minOrderYes ? bid : null;
  const finalAsk = ask !== null && askSize >= c.minOrderYes ? ask : null;
  if (finalBid === null && finalAsk === null) return { pull: true, reasons: [...reasons, "no side left after caps / margin"] };
  return { pull: false, bid: finalBid, ask: finalAsk, bidSize: finalBid === null ? 0 : bidSize, askSize: finalAsk === null ? 0 : askSize, half: +half.toFixed(4), skew: +skew.toFixed(4), reasons };
}
