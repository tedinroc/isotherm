// Pure planning for "Buy No" (no chain or wallet access, so unit tests import it directly). Executor: lib/buyNo.ts.
import type { Hex } from 'viem';
import { minOut, toUnits6, type NoViaSellQuote } from './book';

export type StepId = 'approve' | 'mint' | 'sell' | 'merge';
export type StepStatus = 'todo' | 'active' | 'done' | 'failed';
export interface StepEvent {
  id: StepId;
  status: StepStatus;
  hash?: Hex; // a transaction that belongs to this step (approvals report one event per transaction)
  what?: 'ausd-vault' | 'yes-zap'; // which one-time approval `hash` is
}

export interface BuyNoPlan {
  mint: bigint; // complete sets to mint = YES to sell = NO received (6 dp units)
  expectedOut: bigint; // AUSD the YES leg should fetch on today's book
  minAusdOut: bigint; // sellYes bound: expectedOut × (1 − slippage), never 0
  worstCost: bigint; // mint − minAusdOut: the most the NO can cost if step 2 goes through
  approveAusd: boolean; // AUSD → vault allowance below `mint`
  approveYes: boolean; // YES → Zap allowance below `mint` for this strike
}

export function planBuyNo(
  q: NoViaSellQuote,
  slippage: number,
  allowance: { ausdVault: bigint; yesZap: bigint },
): BuyNoPlan | null {
  const mint = toUnits6(q.mint);
  if (mint <= 0n || !(q.proceeds > 0)) return null;
  const minAusdOut = minOut(q.proceeds, slippage);
  if (minAusdOut <= 0n) return null;
  return {
    mint,
    expectedOut: toUnits6(q.proceeds),
    minAusdOut,
    worstCost: mint - minAusdOut,
    approveAusd: allowance.ausdVault < mint,
    approveYes: allowance.yesZap < mint,
  };
}

export interface RetrySellPlan {
  pairs: bigint; // YES to sell (= the pairs left after step 2 did not go through)
  floor: bigint; // the original plan's per-unit minimum applied to `pairs` (rounded up)
  expectedOut: bigint; // what today's bids would pay for `pairs` YES (after Kuru's fee)
  minAusdOut: bigint; // the retry's sellYes bound: max(today's quote × (1 − slippage), floor)
  blocked: boolean; // today's bids cannot pay `floor`: the sale would revert, so it is not offered
  noPriceNow: number; // AUSD per No if the YES leg sold for expectedOut now (1 with no bids)
  noPriceWorst: number; // the original plan's worst case per No (worstCost / mint)
}

/**
 * Retry of step 2 after it did not go through (a sandwich moved the bids, the wallet rejected it, ...).
 * The retry is quoted on today's book, but its minimum is never below the original plan's per-unit minimum, so
 * the No can never end up costing more than the worst case the user accepted at tap time. A sandwich that leaves a
 * dust bid would otherwise fill the retry at ~0.999 per No (the same loss N1 described, one transaction later).
 * When today's bids cannot meet that floor, the retry is blocked and the UI says why; merging back stays available.
 */
export function planRetrySell(original: BuyNoPlan, pairs: bigint, quotedProceeds: number, slippage: number): RetrySellPlan {
  const floor = original.mint > 0n ? (original.minAusdOut * pairs + original.mint - 1n) / original.mint : 0n;
  const expectedOut = quotedProceeds > 0 ? toUnits6(quotedProceeds) : 0n;
  const fresh = minOut(quotedProceeds, slippage);
  const minAusdOut = fresh > floor ? fresh : floor;
  const per = (ausd: bigint) => (pairs > 0n ? Number(pairs - (ausd < pairs ? ausd : pairs)) / Number(pairs) : 1);
  return {
    pairs,
    floor,
    expectedOut,
    minAusdOut,
    blocked: pairs <= 0n || minAusdOut <= 0n || expectedOut < floor,
    noPriceNow: per(expectedOut),
    noPriceWorst: original.mint > 0n ? Number(original.worstCost) / Number(original.mint) : 1,
  };
}

/** What Portfolio's "Sell Yes" will send, frozen when the user opens the confirmation. */
export interface PortfolioSellPlan {
  kind: 'retry' | 'quote';
  sellUnits: bigint; // YES passed to zap.sellYes (6 dp)
  heldUnits: bigint; // YES the wallet holds for this strike
  expectedOut: bigint; // AUSD today's bids should pay for sellUnits (after Kuru's fee)
  avgPrice: number | null; // AUSD per YES at today's quote
  minAusdOut: bigint; // the sellYes bound; never 0 when a sale is offered
  floor: bigint; // retry: the original Buy No plan's per-unit minimum × sellUnits; quote: 0
  blocked: boolean; // nothing to sell, no bids, or (retry) today's bids cannot pay the floor
  noPriceNow: number | null; // retry only: AUSD per No if the YES leg sold for expectedOut now
  noPriceWorst: number | null; // retry only: the worst case per No the user accepted at tap time
}

/** A Buy No whose step 2 did not go through: the plan accepted at tap time and the pairs it left in the wallet. */
export interface StrandedBuyNo {
  origin: BuyNoPlan;
  pairs: bigint;
}

type SellQuoteFn = (yes: number) => { sold: number; proceeds: number; avgPrice: number | null };

/**
 * Portfolio "Sell Yes". Two cases:
 * - The YES is the unsold leg of a Buy No whose step 2 did not go through (`stranded`): this is the same retry the
 *   trade sheet offers, so it sells at most those pairs and keeps the original plan's per-unit minimum
 *   (planRetrySell). When today's bids cannot pay that floor the sale is blocked; merging back stays available.
 * - Otherwise the minimum is today's quote × (1 − slippage), and the UI makes the user confirm that number (with the
 *   average price) before anything is sent. Only what today's bids can absorb is offered.
 */
export function planPortfolioSell(
  quote: SellQuoteFn,
  heldUnits: bigint,
  slippage: number,
  stranded: StrandedBuyNo | null,
): PortfolioSellPlan {
  const held = heldUnits > 0n ? heldUnits : 0n;
  if (stranded && stranded.pairs > 0n && stranded.origin.mint > 0n) {
    const sellUnits = stranded.pairs < held ? stranded.pairs : held;
    const q = quote(Number(sellUnits) / 1e6);
    const r = planRetrySell(stranded.origin, sellUnits, q.proceeds, slippage);
    return {
      kind: 'retry',
      sellUnits,
      heldUnits: held,
      expectedOut: r.expectedOut,
      avgPrice: q.avgPrice,
      minAusdOut: r.minAusdOut,
      floor: r.floor,
      blocked: r.blocked,
      noPriceNow: r.noPriceNow,
      noPriceWorst: r.noPriceWorst,
    };
  }
  const q = quote(Number(held) / 1e6);
  const sold = toUnits6(q.sold);
  const sellUnits = sold < held ? sold : held;
  const min = q.proceeds > 0 ? minOut(q.proceeds, slippage) : 0n;
  return {
    kind: 'quote',
    sellUnits,
    heldUnits: held,
    expectedOut: q.proceeds > 0 ? toUnits6(q.proceeds) : 0n,
    avgPrice: q.avgPrice,
    minAusdOut: min,
    floor: 0n,
    blocked: sellUnits <= 0n || min <= 0n,
    noPriceNow: null,
    noPriceWorst: null,
  };
}
