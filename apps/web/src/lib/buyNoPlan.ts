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
