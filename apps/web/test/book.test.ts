import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, stringToHex } from 'viem';
import { decodeL2, minOut, quoteBuyNoViaSell, quoteBuyYes, quoteSellYes, toUnits6, type Book } from '../src/lib/book';
import { planBuyNo } from '../src/lib/buyNoPlan';
import { bytecodeHasSelector, decodeResult, decodeSeries, SELECTORS, station4 } from '../src/lib/abi';
import { normalizeDeployments } from '../src/lib/deployments';

const book: Book = {
  asks: [
    { price: 0.64, size: 150 },
    { price: 0.7, size: 100 },
  ],
  bids: [
    { price: 0.6, size: 150 },
    { price: 0.5, size: 50 },
  ],
  bestBid: 0.6,
  bestAsk: 0.64,
};

describe('Kuru book maths (matches the fork fills)', () => {
  it('buy YES walks the asks; the 0.1% fee comes out of the output', () => {
    // fork run: 10 AUSD at 0.64 -> 15.61 YES (15.625 × 0.999)
    const q = quoteBuyYes(book, 10, 10);
    expect(q.out).toBeCloseTo(15.609375, 6);
    expect(q.refund).toBe(0);
    const big = quoteBuyYes(book, 150, 10); // 96 AUSD at 0.64 for 150, 54 at 0.70
    expect(big.out).toBeCloseTo((150 + 54 / 0.7) * 0.999, 5);
    const thin = quoteBuyYes({ ...book, asks: [{ price: 0.5, size: 10 }] }, 10, 10);
    expect(thin.spend).toBeCloseTo(5, 9);
    expect(thin.refund).toBeCloseTo(5, 9);
    expect(thin.filledAll).toBe(false);
  });
  it('buy NO = mintSet then sellYes; budget sizing inverts it and stays within the bids', () => {
    // fork run: 24.96 sets, YES sold at 0.60 -> 14.96 back, net 10.00 for 24.96 NO
    const s = quoteBuyNoViaSell(book, 10, 1000, 10);
    expect(s.netCost).toBeLessThanOrEqual(10 + 1e-6);
    expect(s.netCost).toBeGreaterThan(9.999);
    expect(s.mint).toBeCloseTo(24.96, 2);
    expect(s.proceeds).toBeCloseTo(s.mint * 0.6 * 0.999, 5);
    expect(s.depthLimited).toBe(false);
    // thin book: the mint is capped at what the bids absorb, so step 2 is expected to fill completely
    const thin = quoteBuyNoViaSell({ ...book, bids: [{ price: 0.6, size: 5 }] }, 20, 1000, 10);
    expect(thin.mint).toBeCloseTo(5, 9);
    expect(thin.proceeds).toBeCloseTo(5 * 0.6 * 0.999, 6);
    expect(thin.depthLimited).toBe(true);
    // capped by the wallet balance
    expect(quoteBuyNoViaSell(book, 10, 7, 10).mint).toBeCloseTo(7, 9);
    // no bids: nothing to sell the YES leg into
    expect(quoteBuyNoViaSell({ ...book, bids: [], bestBid: null }, 10, 1000, 10).mint).toBe(0);
  });
  it('buy NO plan: hard minAusdOut on the YES sale, approvals only when missing', () => {
    const q = quoteBuyNoViaSell(book, 10, 1000, 10);
    const p = planBuyNo(q, 0.02, { ausdVault: 0n, yesZap: 0n })!;
    expect(p.mint).toBe(toUnits6(q.mint));
    expect(p.minAusdOut).toBe(minOut(q.proceeds, 0.02));
    expect(p.minAusdOut > 0n).toBe(true);
    expect(p.worstCost).toBe(p.mint - p.minAusdOut);
    expect(p.approveAusd && p.approveYes).toBe(true);
    const p2 = planBuyNo(q, 0.02, { ausdVault: 10n ** 12n, yesZap: 2n ** 255n })!;
    expect(p2.approveAusd || p2.approveYes).toBe(false);
    expect(planBuyNo(quoteBuyNoViaSell(book, 0, 1000, 10), 0.02, { ausdVault: 0n, yesZap: 0n })).toBeNull();
  });
  it('the N1 sandwich: Zap.buyNo\'s bound passes at ~0.999 per NO, the sellYes bound rejects it', () => {
    // victim quoted 100 sets on a 100-YES bid at 0.43 (the verifier's live-fork numbers)
    const quoted: Book = { bids: [{ price: 0.43, size: 100 }], asks: [], bestBid: 0.43, bestAsk: null };
    // attacker sells into the bid first and leaves 50 YES @ 0.001
    const sandwiched: Book = { bids: [{ price: 0.001, size: 50 }], asks: [], bestBid: 0.001, bestAsk: null };
    const mint = 100;
    // old path: Zap.buyNo(ausdIn=100, minAusdBack = 2 % under the quote); ausdBack counts unsold YES merged at par
    const minBack = (mint * 0.43 * 0.999) * 0.98;
    const sold = quoteSellYes(sandwiched, mint, 10);
    const ausdBack = sold.proceeds + sold.unsold; // 0.05 + 50
    const noOut = mint - sold.unsold; // 50
    expect(ausdBack).toBeGreaterThanOrEqual(minBack); // the bound passes…
    expect((mint - ausdBack) / noOut).toBeGreaterThan(0.99); // …at > 0.99 per NO instead of 0.57
    // new path: sellYes(mint, minAusdOut) reverts because it would get 0.05 AUSD < minAusdOut
    const plan = planBuyNo(quoteBuyNoViaSell(quoted, 1000, 1000, 10), 0.02, { ausdVault: 0n, yesZap: 0n })!;
    expect(plan.mint).toBe(100_000_000n);
    expect(toUnits6(sold.proceeds) < plan.minAusdOut).toBe(true);
  });
  it('sell YES into bids', () => {
    const q = quoteSellYes(book, 160, 10);
    expect(q.sold).toBe(160);
    expect(q.proceeds).toBeCloseTo((150 * 0.6 + 10 * 0.5) * 0.999, 5);
  });
  it('min-out is never zero for a positive quote (the v1 Zap rejects 0)', () => {
    expect(minOut(15.609375, 0.02)).toBe(15_297_187n);
    expect(minOut(0.0000004, 0.02)).toBe(1n);
    expect(minOut(0, 0.02)).toBe(0n);
  });
  it('decodes getL2Book bytes (price ×1e4, size ×1e6)', () => {
    const words = [68885424n, 6000n, 150_000_000n, 5000n, 50_000_000n, 0n, 6400n, 150_000_000n];
    const hex = encodeAbiParameters(words.map(() => ({ type: 'uint256' as const })), words);
    const b = decodeL2(hex);
    expect(b.bids).toEqual([
      { price: 0.6, size: 150 },
      { price: 0.5, size: 50 },
    ]);
    expect(b.asks).toEqual([{ price: 0.64, size: 150 }]);
    expect(b.bestBid).toBe(0.6);
    expect(b.bestAsk).toBe(0.64);
    expect(decodeL2(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, 0n]))).toMatchObject({ bestBid: null, bestAsk: null });
  });
});

describe('chain decoders', () => {
  it('station4 / series / result layouts', () => {
    expect(station4('RCSS')).toBe(stringToHex('RCSS', { size: 4 }));
    const yes = '0x67A91138014c30bF5F28A900326971bD08Cd1bc4';
    const no = '0x49B7900D282E3f5262Dd712d2e66ff0166d7516D';
    const v1 = encodeAbiParameters(
      [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'uint64' }, { type: 'bool' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [station4('RCSS'), 20261008, 29, 1791451800n, false, yes, no, 0n],
    );
    expect(decodeSeries(v1)).toMatchObject({ station: 'RCSS', date: 20261008, strikeC: 29, closeTime: 1791451800 });
    const r = encodeAbiParameters([{ type: 'uint8' }, { type: 'int16' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }], [1, 30, 100n, 1000n, keccak256('0x01')]);
    expect(decodeResult(r)).toMatchObject({ status: 1, tmaxC: 30, finalAt: 1000, hasFinalAt: true });
  });
  it('detects v1 capabilities from bytecode selectors', () => {
    expect(bytecodeHasSelector(`0x60${'63' + SELECTORS.canonicalMarket.slice(2)}`, SELECTORS.canonicalMarket)).toBe(true);
    expect(bytecodeHasSelector('0x6080', SELECTORS.canonicalMarket)).toBe(false);
  });
  it('reads deployments by key name', () => {
    const d = normalizeDeployments({ resolver: '0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B', vault: '0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39', zap: '0x1ACaf47987Fe570df5d136Ae1CaC0D45E2B8CFb0' });
    expect(d.zap).toBe('0x1ACaf47987Fe570df5d136Ae1CaC0D45E2B8CFb0');
  });
});
