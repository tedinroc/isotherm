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
