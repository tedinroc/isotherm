// Pure trade planning against a Kuru v1 L2 snapshot. Integer math only (base units), so minOut guards are exact.
// Kuru takes the taker fee from the OUTPUT token (taker spike: 20 AUSD at 0.44 -> 45.409090 YES = 45.4545 x 0.999).
import type { Level, MarketParams } from "./kuru.js";
import { notionalQuote, sizeUToBase, baseToSizeU } from "./kuru.js";

type P = Pick<MarketParams, "pricePrecision" | "sizePrecision" | "baseDecimals" | "quoteDecimals" | "takerFeeBps">;

export const BPS = 10_000n;
export const applyBpsDown = (x: bigint, bps: bigint) => (x * (BPS - bps)) / BPS;
export const afterFee = (x: bigint, feeBps: bigint) => (x * (BPS - feeBps)) / BPS;

export type BuyWalk = {
  spendQuote: bigint; // quote units actually spent (<= budget)
  grossBase: bigint; // base units bought before the fee
  netBase: bigint; // base units received after the taker fee
  levelsUsed: number;
  worstPriceU: bigint | null;
  limitedByPrice: boolean; // stopped at maxPrice (or ran out of book) before spending the budget
};

/** Market-buy `budgetQuote` against `asks` (best first), never touching a level priced above `maxPriceU`. */
export function walkBuy(asks: Level[], budgetQuote: bigint, maxPriceU: bigint | null, p: P): BuyWalk {
  let remaining = budgetQuote;
  let grossSizeU = 0n;
  let levelsUsed = 0;
  let worst: bigint | null = null;
  for (const l of asks) {
    if (remaining <= 0n) break;
    if (maxPriceU !== null && l.priceU > maxPriceU) break;
    const levelCost = notionalQuote(l.sizeU, l.priceU, p);
    if (levelCost <= remaining) {
      grossSizeU += l.sizeU;
      remaining -= levelCost;
    } else {
      // partial level: Kuru spends the whole remaining quote here (sub-unit dust included), buying what it affords
      const sz = (remaining * p.sizePrecision * p.pricePrecision) / (l.priceU * 10n ** p.quoteDecimals);
      grossSizeU += sz;
      if (sz > 0n) {
        levelsUsed++;
        worst = l.priceU;
      }
      const grossBase = sizeUToBase(grossSizeU, p);
      return { spendQuote: budgetQuote, grossBase, netBase: afterFee(grossBase, p.takerFeeBps), levelsUsed, worstPriceU: worst, limitedByPrice: false };
    }
    levelsUsed++;
    worst = l.priceU;
  }
  const spent = budgetQuote - remaining;
  const grossBase = sizeUToBase(grossSizeU, p);
  return { spendQuote: spent, grossBase, netBase: afterFee(grossBase, p.takerFeeBps), levelsUsed, worstPriceU: worst, limitedByPrice: remaining > 0n };
}

export type SellWalk = {
  soldBase: bigint;
  grossQuote: bigint;
  netQuote: bigint;
  levelsUsed: number;
  worstPriceU: bigint | null;
  limitedByPrice: boolean; // could not sell everything at or above minPrice
};

/** Market-sell `baseIn` into `bids` (best first), never touching a level priced below `minPriceU`. */
export function walkSell(bids: Level[], baseIn: bigint, minPriceU: bigint | null, p: P): SellWalk {
  let remainingU = baseToSizeU(baseIn, p);
  let soldU = 0n;
  let grossQuote = 0n;
  let levelsUsed = 0;
  let worst: bigint | null = null;
  for (const l of bids) {
    if (remainingU <= 0n) break;
    if (minPriceU !== null && l.priceU < minPriceU) break;
    const take = l.sizeU < remainingU ? l.sizeU : remainingU;
    soldU += take;
    remainingU -= take;
    grossQuote += notionalQuote(take, l.priceU, p);
    levelsUsed++;
    worst = l.priceU;
  }
  return {
    soldBase: sizeUToBase(soldU, p),
    grossQuote,
    netQuote: afterFee(grossQuote, p.takerFeeBps),
    levelsUsed,
    worstPriceU: worst,
    limitedByPrice: remainingU > 0n,
  };
}

/**
 * Quote needed to RECEIVE at least `netBaseOut` base units (after the fee) from `asks`, no level above maxPriceU.
 * Returns null when the book (within the price limit) is too thin.
 */
export function quoteForExactOut(asks: Level[], netBaseOut: bigint, maxPriceU: bigint | null, p: P): { quote: bigint; worstPriceU: bigint } | null {
  // gross needed so that floor(gross * (1 - fee)) >= net
  const grossBase = (netBaseOut * BPS + (BPS - p.takerFeeBps) - 1n) / (BPS - p.takerFeeBps);
  let needU = baseToSizeU(grossBase, p);
  if (sizeUToBase(needU, p) < grossBase) needU += 1n;
  let quote = 0n;
  let worst: bigint | null = null;
  for (const l of asks) {
    if (needU <= 0n) break;
    if (maxPriceU !== null && l.priceU > maxPriceU) return null;
    const take = l.sizeU < needU ? l.sizeU : needU;
    // round each level's cost UP by one quote unit so the market buy never comes up short
    quote += notionalQuote(take, l.priceU, p) + 1n;
    needU -= take;
    worst = l.priceU;
  }
  if (needU > 0n || worst === null) return null;
  return { quote, worstPriceU: worst };
}

/** Kuru market buys take the quote amount in pricePrecision units; the zap converts with ausdIn * pp / 10^qd. */
export function roundQuoteToPricePrecision(quote: bigint, p: Pick<MarketParams, "pricePrecision" | "quoteDecimals">): bigint {
  const unit = 10n ** p.quoteDecimals / p.pricePrecision;
  if (unit <= 1n) return quote;
  return (quote / unit) * unit;
}

export function priceUToString(priceU: bigint | null, pricePrecision: bigint): string | null {
  if (priceU === null) return null;
  const d = pricePrecision.toString().length - 1;
  const s = priceU.toString().padStart(d + 1, "0");
  return `${s.slice(0, -d) || "0"}.${s.slice(-d)}`;
}

/** Average price (quote per base, decimal) of a fill, for reporting only. */
export function avgPrice(quote: bigint, base: bigint, quoteDecimals: bigint, baseDecimals: bigint): number | null {
  if (base === 0n) return null;
  return Number(quote) / 10 ** Number(quoteDecimals) / (Number(base) / 10 ** Number(baseDecimals));
}
