import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, stringToHex } from 'viem';
import { decodeL2, minOut, quoteBuyNo, quoteBuyYes, quoteSellYes, sizeBuyNoForBudget, type Book } from '../src/lib/book';
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
  it('buy NO = mint sets, sell YES into the bids; budget sizing inverts it', () => {
    // fork run: 24.96 sets, YES sold at 0.60 -> 14.96 back, net 10.00 for 24.96 NO
    const q = quoteBuyNo(book, 24.962554, 10);
    expect(q.noOut).toBeCloseTo(24.962554, 6);
    expect(q.ausdBack).toBeCloseTo(14.962554, 3);
    const s = sizeBuyNoForBudget(book, 10, 1000, 10);
    expect(s.netCost).toBeLessThanOrEqual(10 + 1e-6);
    expect(s.netCost).toBeGreaterThan(9.999);
    expect(s.noOut).toBeCloseTo(24.96, 2);
    // thin book: unsold YES merges back 1:1, so the user never ends up holding YES
    const thin = quoteBuyNo({ ...book, bids: [{ price: 0.6, size: 5 }] }, 20, 10);
    expect(thin.noOut).toBeCloseTo(5, 9);
    expect(thin.ausdBack).toBeCloseTo(15 + 5 * 0.6 * 0.999, 6);
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
