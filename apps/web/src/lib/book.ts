// Kuru v1 order book maths (YES/AUSD books: price precision 1e4 on a 0.001 tick, size = YES base units 1e6).
// The quote functions walk the live L2 book to predict what a market order through the Zap returns, so the app can
// show "you get ~N" and pass a min-out that protects the user (the v1 Zap requires a non-zero min-out).
import type { Hex } from 'viem';

export interface Level {
  price: number; // AUSD per YES
  size: number; // YES
}
export interface Book {
  bids: Level[]; // best first
  asks: Level[]; // best first
  bestBid: number | null;
  bestAsk: number | null;
}

export const EMPTY_BOOK: Book = { bids: [], asks: [], bestBid: null, bestAsk: null };

/** getL2Book() bytes: [block, (price,size)* bids, 0, (price,size)* asks], 32-byte words, price ×1e4, size ×1e6. */
export function decodeL2(data: Hex, pricePrecision = 1e4, sizePrecision = 1e6): Book {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  const words: bigint[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push(BigInt(`0x${hex.slice(i, i + 64)}`));
  const book: Book = { bids: [], asks: [], bestBid: null, bestAsk: null };
  let i = 1;
  for (; i < words.length && words[i] !== 0n; i += 2) {
    if (i + 1 >= words.length) break;
    book.bids.push({ price: Number(words[i]) / pricePrecision, size: Number(words[i + 1]) / sizePrecision });
  }
  for (i += 1; i + 1 < words.length; i += 2) {
    if (words[i] === 0n) break;
    book.asks.push({ price: Number(words[i]) / pricePrecision, size: Number(words[i + 1]) / sizePrecision });
  }
  book.bids = book.bids.filter((l) => l.size > 0);
  book.asks = book.asks.filter((l) => l.size > 0);
  book.bestBid = book.bids[0]?.price ?? null;
  book.bestAsk = book.asks[0]?.price ?? null;
  return book;
}

export interface BuyQuote {
  spend: number; // AUSD actually spent
  refund: number; // AUSD returned unspent
  out: number; // YES received after fee
  avgPrice: number | null; // AUSD per YES incl. fee
  filledAll: boolean;
}

/** Market buy of YES with `ausd`, walking asks. Fee is taken from the output (Kuru v1). */
export function quoteBuyYes(book: Book, ausd: number, takerFeeBps = 10): BuyQuote {
  let left = ausd;
  let out = 0;
  for (const l of book.asks) {
    if (left <= 1e-9) break;
    const cost = l.size * l.price;
    if (cost <= left) {
      out += l.size;
      left -= cost;
    } else {
      out += left / l.price;
      left = 0;
    }
  }
  const outNet = floor6(out * (1 - takerFeeBps / 10_000));
  const spend = ausd - left;
  return { spend, refund: left, out: outNet, avgPrice: outNet > 0 ? spend / outNet : null, filledAll: left <= 1e-6 };
}

export interface SellQuote {
  sold: number; // YES sold
  unsold: number; // YES not sold (refunded / merged)
  proceeds: number; // AUSD after fee
  avgPrice: number | null;
}

/** Market sell of `yes` YES into the bids. Fee is taken from the AUSD output. */
export function quoteSellYes(book: Book, yes: number, takerFeeBps = 10): SellQuote {
  let left = yes;
  let gross = 0;
  for (const l of book.bids) {
    if (left <= 1e-9) break;
    const take = Math.min(left, l.size);
    gross += take * l.price;
    left -= take;
  }
  const proceeds = floor6(gross * (1 - takerFeeBps / 10_000));
  const sold = yes - left;
  return { sold, unsold: left, proceeds, avgPrice: sold > 0 ? proceeds / sold : null };
}

/** Total YES the bids can absorb right now. */
export const bidDepth = (book: Book) => book.bids.reduce((a, l) => a + l.size, 0);

export interface NoViaSellQuote {
  mint: number; // complete sets minted in the vault = YES sold = NO received
  proceeds: number; // AUSD expected from selling the YES leg (after Kuru's fee)
  netCost: number; // mint - proceeds
  avgPrice: number | null; // net cost per NO
  depthLimited: boolean; // the bids, not the budget, set the size
}

/**
 * "Buy No" without Zap.buyNo (whose only bound, minAusdBack, also counts unsold YES merged back at par, so a
 * sandwich that empties the bids still passes it: verifier finding N1). Instead the app sends two transactions:
 *   1. vault.mintSet(seriesId, mint)                      -> mint YES + mint NO
 *   2. zap.sellYes(seriesId, market, mint, minAusdOut)    -> AUSD for the YES leg, reverts below minAusdOut
 * sellYes' bound is a true worst-case bound: the user never receives less than minAusdOut for at most `mint` YES.
 * Sizing: the largest `mint` with net cost <= budget, mint <= maxIn (wallet AUSD), and mint <= today's bid depth, so
 * the whole YES leg is expected to sell and no third "merge unsold YES" transaction is normally needed.
 */
export function quoteBuyNoViaSell(book: Book, budget: number, maxIn: number, takerFeeBps = 10): NoViaSellQuote {
  const cap = floor6(Math.min(Math.max(0, maxIn), bidDepth(book)));
  const none: NoViaSellQuote = { mint: 0, proceeds: 0, netCost: 0, avgPrice: null, depthLimited: false };
  if (!(budget > 0) || cap <= 0) return none;
  const cost = (n: number) => n - quoteSellYes(book, n, takerFeeBps).proceeds;
  let lo = 0;
  let hi = cap;
  const fitsAll = cost(cap) <= budget;
  if (fitsAll) lo = cap;
  else {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (cost(mid) <= budget) lo = mid;
      else hi = mid;
    }
  }
  const mint = floor6(lo);
  if (mint <= 0) return none;
  const s = quoteSellYes(book, mint, takerFeeBps);
  const netCost = mint - s.proceeds;
  return { mint, proceeds: s.proceeds, netCost, avgPrice: netCost / mint, depthLimited: fitsAll && bidDepth(book) <= maxIn };
}

export const floor6 = (x: number) => Math.floor(x * 1e6 + 1e-7) / 1e6;
export const toUnits6 = (x: number) => BigInt(Math.floor(x * 1e6 + 1e-7));
export const fromUnits6 = (x: bigint) => Number(x) / 1e6;

/** min-out with a slippage tolerance (fraction), never 0 when the quote is positive. */
export function minOut(expected: number, slippage: number): bigint {
  const u = toUnits6(expected * (1 - slippage));
  return u > 0n ? u : expected > 0 ? 1n : 0n;
}

export const mid = (b: Book) => (b.bestBid !== null && b.bestAsk !== null ? (b.bestBid + b.bestAsk) / 2 : null);
