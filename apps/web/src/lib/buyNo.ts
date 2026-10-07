// "Buy No" = vault.mintSet + zap.sellYes(minAusdOut), never Zap.buyNo.
//
// Why: Zap.buyNo's only bound is minAusdBack, and ausdBack counts unsold YES merged back at par. A sandwich that takes
// the maker's bid and leaves a dust bid still clears a 2 % minAusdBack while the victim pays ~0.999 per NO
// (verifier finding N1, test/security/v1). zap.sellYes' bound IS a worst-case bound: at most `yesIn` YES are sold and
// the user never receives less than minAusdOut, so the same sandwich makes step 2 revert. The user then simply holds
// complete pairs (always redeemable 1:1) and can retry the sale at the new price or merge them back.
//
// Steps (one tap in the UI):
//   approve  one-time: AUSD -> vault (100k test AUSD), YES -> Zap for this strike. Done before minting so a failed
//            approval never leaves the user holding pairs.
//   mint     vault.mintSet(seriesId, mint)                      -> mint YES + mint NO
//   sell     zap.sellYes(seriesId, market, mint, minAusdOut)     -> AUSD; reverts if the YES leg would fetch less
//   merge    only if the sale filled partially but still cleared minAusdOut (the book improved): the unsold YES is
//            merged with the same amount of NO back into AUSD, so a "Buy No" never leaves the user holding YES.
import { parseEventLogs, type Hex } from 'viem';
import type { Client } from '../wallet/wallet';
import { zapAbi } from './abi';
import { ensureAusdAllowance, ensureYesAllowance, mergePairs, mintSet, sellYes, type TxResult } from './actions';
import type { BuyNoPlan, StepEvent } from './buyNoPlan';
import { DEPLOYMENTS } from './deployments';
import type { StrikeView } from './data';

export { planBuyNo, planRetrySell, type BuyNoPlan, type RetrySellPlan, type StepEvent, type StepId, type StepStatus } from './buyNoPlan';

/** Step 2 (or a retry of it) failed after step 1 minted: the user holds `pairs` YES + `pairs` NO. Nothing is lost. */
export class SellLegFailed extends Error {
  constructor(
    message: string,
    readonly pairs: bigint,
    readonly mintHash: Hex | null,
  ) {
    super(message);
    this.name = 'SellLegFailed';
  }
}

export interface BuyNoResult {
  approveHashes: Hex[];
  mintHash: Hex | null;
  sellHash: Hex;
  mergeHash: Hex | null;
  noOut: bigint; // NO kept
  ausdOut: bigint; // AUSD from the YES sale
  yesUnsold: bigint; // YES the book did not take (merged back when mergeHash is set)
  cost: bigint; // net AUSD paid for noOut
  ms: number;
}

export async function runBuyNo(client: Client, s: StrikeView, plan: BuyNoPlan, onStep: (e: StepEvent) => void): Promise<BuyNoResult> {
  const t0 = performance.now();
  const approveHashes: Hex[] = [];
  if (plan.approveAusd || plan.approveYes) {
    onStep({ id: 'approve', status: 'active' });
    try {
      if (plan.approveAusd) {
        const a = await ensureAusdAllowance(client, plan.mint, 0n, DEPLOYMENTS.vault);
        if (a) {
          approveHashes.push(a.hash);
          onStep({ id: 'approve', status: 'active', hash: a.hash, what: 'ausd-vault' });
        }
      }
      if (plan.approveYes) {
        const a = await ensureYesAllowance(client, s, plan.mint, 0n);
        if (a) {
          approveHashes.push(a.hash);
          onStep({ id: 'approve', status: 'active', hash: a.hash, what: 'yes-zap' });
        }
      }
    } catch (e) {
      onStep({ id: 'approve', status: 'failed' });
      throw e;
    }
    onStep({ id: 'approve', status: 'done' });
  }

  onStep({ id: 'mint', status: 'active' });
  let m: TxResult;
  try {
    m = await mintSet(client, s, plan.mint);
  } catch (e) {
    onStep({ id: 'mint', status: 'failed' });
    throw e; // nothing minted, nothing to undo
  }
  onStep({ id: 'mint', status: 'done', hash: m.hash });

  const r = await sellLeg(client, s, plan.mint, plan.minAusdOut, m.hash, onStep);
  return { ...r, approveHashes, ms: Math.round(performance.now() - t0) };
}

/** Step 2: sell `yesIn` YES with a hard minAusdOut; merge any unsold YES back with NO. Also used for a retry. */
export async function sellLeg(
  client: Client,
  s: StrikeView,
  yesIn: bigint,
  minAusdOut: bigint,
  mintHash: Hex | null,
  onStep: (e: StepEvent) => void,
): Promise<Omit<BuyNoResult, 'approveHashes' | 'ms'>> {
  onStep({ id: 'sell', status: 'active' });
  let r: TxResult;
  try {
    r = await sellYes(client, s, yesIn, minAusdOut);
  } catch (e) {
    onStep({ id: 'sell', status: 'failed' });
    throw new SellLegFailed((e as Error).message ?? String(e), yesIn, mintHash);
  }
  const ev = parseEventLogs({ abi: zapAbi, logs: r.receipt.logs, eventName: 'ZapSellYes' })[0];
  const ausdOut = ev ? ev.args.ausdOut : minAusdOut;
  const unsold = ev ? ev.args.yesRefund : 0n;
  onStep({ id: 'sell', status: 'done', hash: r.hash });

  let mergeHash: Hex | null = null;
  if (unsold > 0n) {
    onStep({ id: 'merge', status: 'active' });
    try {
      mergeHash = (await mergePairs(client, s.seriesId, unsold)).hash;
      onStep({ id: 'merge', status: 'done', hash: mergeHash });
    } catch {
      // The unsold YES + the same NO stay as pairs; Portfolio offers "Merge pairs".
      onStep({ id: 'merge', status: 'failed' });
    }
  }
  const merged = mergeHash ? unsold : 0n;
  return {
    mintHash,
    sellHash: r.hash,
    mergeHash,
    noOut: yesIn - merged,
    ausdOut,
    yesUnsold: unsold,
    cost: yesIn - ausdOut - merged,
  };
}
