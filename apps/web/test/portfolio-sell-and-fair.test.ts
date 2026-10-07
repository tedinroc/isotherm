/// <reference path="../src/vite-env.d.ts" />
// Dynamic round, item 1: Portfolio's "Sell Yes" had no floor (it sold at today's quote, whatever it was); the fair value
// is now labelled when it is not Polymarket-sourced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { minOut, quoteBuyNoViaSell, quoteSellYes, type Book } from '../src/lib/book';
import { planBuyNo, planPortfolioSell, type BuyNoPlan } from '../src/lib/buyNoPlan';
import { fairTag } from '../src/lib/fairSource';

const ADDR = '0x00000000000000000000000000000000000000aa';
const SERIES = '0xa69ae9d5af5141648df6a03de55f960d141e84ccda321efe1c7bb7882cf02cd3';
const quoteOn = (book: Book) => (y: number) => quoteSellYes(book, y, 10);

describe('fair value source label', () => {
  it('no label for a Polymarket-sourced fair value, or when there is no fair value', () => {
    expect(fairTag(0.4113, 'polymarket')).toBeNull();
    expect(fairTag(null, 'fallback-v0')).toBeNull();
    expect(fairTag(undefined, undefined)).toBeNull();
  });
  it('labels every other source, including an older snapshot that does not say', () => {
    expect(fairTag(1, 'certain')).toBe('observed');
    expect(fairTag(0.6, 'fallback-v0')).toBe('model');
    expect(fairTag(0.6, 'fallback-intraday')).toBe('intraday');
    expect(fairTag(0.6, 'none')).toBe('unknown');
    expect(fairTag(0.6, null)).toBe('unknown');
    expect(fairTag(0.6, undefined)).toBe('unknown');
    expect(fairTag(0.6, 'some-new-source')).toBe('unknown');
  });
});

describe('Portfolio "Sell Yes" (planPortfolioSell)', () => {
  const book: Book = {
    bids: [
      { price: 0.34, size: 10 },
      { price: 0.2, size: 5 },
    ],
    asks: [],
    bestBid: 0.34,
    bestAsk: null,
  };

  it('plain position: the minimum is today’s quote × (1 − 2 %), never 0, and only what the bids take is offered', () => {
    const held = 21_260_000n; // 21.26 YES
    const p = planPortfolioSell(quoteOn(book), held, 0.02, null);
    const q = quoteSellYes(book, 21.26, 10);
    expect(p.kind).toBe('quote');
    expect(p.sellUnits).toBe(15_000_000n); // bid depth, not the 21.26 held
    expect(p.heldUnits).toBe(held);
    expect(p.minAusdOut).toBe(minOut(q.proceeds, 0.02));
    expect(p.minAusdOut > 0n).toBe(true);
    expect(p.avgPrice).toBeCloseTo(q.avgPrice!, 9);
    expect(p.blocked).toBe(false);
    expect(p.floor).toBe(0n);
  });

  it('plain position, no bids: blocked (nothing is sent with a 0 minimum)', () => {
    const empty: Book = { bids: [], asks: [], bestBid: null, bestAsk: null };
    const p = planPortfolioSell(quoteOn(empty), 5_000_000n, 0.02, null);
    expect(p.blocked).toBe(true);
    expect(p.minAusdOut).toBe(0n);
  });

  describe('Yes left by a Buy No whose step 2 did not go through', () => {
    const quoted: Book = { bids: [{ price: 0.43, size: 100 }], asks: [], bestBid: 0.43, bestAsk: null };
    const sandwiched: Book = { bids: [{ price: 0.001, size: 50 }], asks: [], bestBid: 0.001, bestAsk: null };
    const origin = planBuyNo(quoteBuyNoViaSell(quoted, 1000, 1000, 10), 0.02, { ausdVault: 0n, yesZap: 0n })!;

    it('after a sandwich the plain quote would sell at ~0.999 per No; the retry floor blocks the sale', () => {
      const plain = planPortfolioSell(quoteOn(sandwiched), origin.mint, 0.02, null);
      expect(plain.blocked).toBe(false); // this is what Portfolio used to send, with no floor at all
      const p = planPortfolioSell(quoteOn(sandwiched), origin.mint, 0.02, { origin, pairs: origin.mint });
      expect(p.kind).toBe('retry');
      expect(p.floor).toBe(origin.minAusdOut);
      expect(p.minAusdOut).toBe(origin.minAusdOut);
      expect(p.blocked).toBe(true);
      expect(p.noPriceNow!).toBeGreaterThan(0.99);
    });

    it('on an unchanged book the retry is offered at the original minimum', () => {
      const p = planPortfolioSell(quoteOn(quoted), origin.mint, 0.02, { origin, pairs: origin.mint });
      expect(p.blocked).toBe(false);
      expect(p.minAusdOut).toBe(origin.minAusdOut);
      expect(p.sellUnits).toBe(origin.mint);
    });

    it('sells at most the stranded pairs; other Yes in the wallet is not part of the retry', () => {
      const p = planPortfolioSell(quoteOn(quoted), origin.mint + 7_000_000n, 0.02, { origin, pairs: origin.mint });
      expect(p.sellUnits).toBe(origin.mint);
      expect(p.heldUnits).toBe(origin.mint + 7_000_000n);
    });

    it('fewer Yes held than recorded pairs: sells what is held, with the per-unit floor scaled down', () => {
      const held = origin.mint / 2n;
      const p = planPortfolioSell(quoteOn(quoted), held, 0.02, { origin, pairs: origin.mint });
      expect(p.sellUnits).toBe(held);
      expect(p.floor * origin.mint >= origin.minAusdOut * held).toBe(true);
    });
  });
});

describe('stranded Buy No record (lib/stranded.ts)', () => {
  const planA: BuyNoPlan = { mint: 10_000_000n, expectedOut: 4_300_000n, minAusdOut: 4_200_000n, worstCost: 5_800_000n, approveAusd: true, approveYes: true };
  const planB: BuyNoPlan = { mint: 10_000_000n, expectedOut: 3_000_000n, minAusdOut: 2_900_000n, worstCost: 7_100_000n, approveAusd: false, approveYes: false };

  async function fresh() {
    vi.resetModules();
    return import('../src/lib/stranded');
  }
  afterEach(() => vi.unstubAllGlobals());

  describe.each([
    ['memory only (no localStorage)', false],
    ['with localStorage', true],
  ])('%s', (_name, withStorage) => {
    beforeEach(() => {
      if (withStorage) {
        const m = new Map<string, string>();
        vi.stubGlobal('localStorage', {
          getItem: (k: string) => m.get(k) ?? null,
          setItem: (k: string, v: string) => void m.set(k, v),
          removeItem: (k: string) => void m.delete(k),
        });
      }
    });

    it('round-trips per wallet and strike, case-insensitively', async () => {
      const st = await fresh();
      expect(st.strandedFor(ADDR, SERIES)).toBeNull();
      st.rememberStranded(ADDR, SERIES, planA, 10_000_000n);
      const r = st.strandedFor(ADDR.toUpperCase().replace('0X', '0x'), SERIES.toUpperCase().replace('0X', '0x'))!;
      expect(r.pairs).toBe(10_000_000n);
      expect(r.origin.minAusdOut).toBe(planA.minAusdOut);
      expect(r.origin.mint).toBe(planA.mint);
      expect(st.strandedFor('0x00000000000000000000000000000000000000bb', SERIES)).toBeNull();
      expect(st.strandedFor(null, SERIES)).toBeNull();
      st.clearStranded(ADDR, SERIES);
      expect(st.strandedFor(ADDR, SERIES)).toBeNull();
    });

    it('a second stranding adds the pairs and keeps the stricter (higher per-unit minimum) plan', async () => {
      const st = await fresh();
      st.rememberStranded(ADDR, SERIES, planB, 4_000_000n);
      st.rememberStranded(ADDR, SERIES, planA, 6_000_000n);
      const r = st.strandedFor(ADDR, SERIES)!;
      expect(r.pairs).toBe(10_000_000n);
      expect(r.origin.minAusdOut).toBe(planA.minAusdOut);
      st.rememberStranded(ADDR, SERIES, planB, 1_000_000n);
      expect(st.strandedFor(ADDR, SERIES)!.origin.minAusdOut).toBe(planA.minAusdOut); // B is laxer: A stays
    });

    it("'set' replaces the count and 0 clears", async () => {
      const st = await fresh();
      st.rememberStranded(ADDR, SERIES, planA, 10_000_000n);
      st.rememberStranded(ADDR, SERIES, planA, 3_000_000n, 'set');
      expect(st.strandedFor(ADDR, SERIES)!.pairs).toBe(3_000_000n);
      st.rememberStranded(ADDR, SERIES, planA, 0n, 'set');
      expect(st.strandedFor(ADDR, SERIES)).toBeNull();
    });
  });

  it('a throwing localStorage falls back to memory', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    });
    const st = await fresh();
    st.rememberStranded(ADDR, SERIES, planA, 2_000_000n);
    expect(st.strandedFor(ADDR, SERIES)!.pairs).toBe(2_000_000n);
  });
});
