// Remembers, per wallet and strike, a Buy No whose step 2 did not go through, so that a later "Sell Yes" from
// Portfolio is still held to the plan the user accepted at tap time (lib/buyNoPlan.ts planPortfolioSell).
// Browser storage is a convenience only: if it is blocked the record lives in memory for this tab, and without a
// record Portfolio falls back to "confirm today's quoted minimum", which is still bounded.
import type { Address, Hex } from 'viem';
import type { BuyNoPlan, StrandedBuyNo } from './buyNoPlan';

const KEY = 'isotherm.stranded.v1';
interface Rec {
  pairs: string;
  mint: string;
  expectedOut: string;
  minAusdOut: string;
  worstCost: string;
  at: number;
}
let memory: Record<string, Rec> = {};

const id = (address: Address | string, seriesId: Hex | string) => `${address.toLowerCase()}:${seriesId.toLowerCase()}`;

function readAll(): Record<string, Rec> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object') return { ...memory, ...(v as Record<string, Rec>) };
    }
  } catch {
    /* storage blocked or corrupt: memory only */
  }
  return { ...memory };
}

function writeAll(all: Record<string, Rec>) {
  memory = all;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: memory only */
  }
}

/**
 * Record `pairs` left by a Buy No whose step 2 did not go through.
 * mode 'add' (a new stranding): pairs already recorded for this strike are kept and the stricter plan wins, i.e. the
 * one with the higher per-unit minimum, so no stranded pair can ever be sold below the limit it was bought under.
 * mode 'set': replace the pair count (after a partial resolution), keeping the given plan.
 */
export function rememberStranded(
  address: Address | string,
  seriesId: Hex | string,
  origin: BuyNoPlan,
  pairs: bigint,
  mode: 'add' | 'set' = 'add',
) {
  if (mode === 'set' && pairs <= 0n) return clearStranded(address, seriesId);
  if (pairs <= 0n || origin.mint <= 0n) return;
  let plan = origin;
  let total = pairs;
  const prev = mode === 'add' ? strandedFor(address, seriesId) : null;
  if (prev) {
    total += prev.pairs;
    // per-unit minimum: minAusdOut / mint; compare by cross-multiplication
    if (prev.origin.minAusdOut * origin.mint > origin.minAusdOut * prev.origin.mint) plan = prev.origin;
  }
  const all = readAll();
  all[id(address, seriesId)] = {
    pairs: total.toString(),
    mint: plan.mint.toString(),
    expectedOut: plan.expectedOut.toString(),
    minAusdOut: plan.minAusdOut.toString(),
    worstCost: plan.worstCost.toString(),
    at: Date.now(),
  };
  writeAll(all);
}

export function strandedFor(address: Address | string | null | undefined, seriesId: Hex | string): StrandedBuyNo | null {
  if (!address) return null;
  const r = readAll()[id(address, seriesId)];
  if (!r) return null;
  try {
    const origin: BuyNoPlan = {
      mint: BigInt(r.mint),
      expectedOut: BigInt(r.expectedOut),
      minAusdOut: BigInt(r.minAusdOut),
      worstCost: BigInt(r.worstCost),
      approveAusd: false,
      approveYes: false,
    };
    const pairs = BigInt(r.pairs);
    return origin.mint > 0n && pairs > 0n ? { origin, pairs } : null;
  } catch {
    return null;
  }
}

export function clearStranded(address: Address | string | null | undefined, seriesId: Hex | string) {
  if (!address) return;
  const all = readAll();
  if (!(id(address, seriesId) in all)) return;
  delete all[id(address, seriesId)];
  writeAll(all);
}
