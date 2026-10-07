/// <reference path="../src/vite-env.d.ts" />
// Fix round 2 (verifier item 2): capability reads are cached only on success, the challenge-window fallback is the
// deployed value (900 s) rather than 0, and a retried Buy No step 2 never goes below the original per-unit minimum.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { minOut, quoteBuyNoViaSell, quoteSellYes, toUnits6, type Book } from '../src/lib/book';
import { planBuyNo, planRetrySell } from '../src/lib/buyNoPlan';
import { SELECTORS } from '../src/lib/abi';
import { DEPLOYMENTS, normalizeDeployments } from '../src/lib/deployments';

const chainMock = vi.hoisted(() => ({
  getCode: vi.fn(),
  readContract: vi.fn(),
}));
vi.mock('../src/lib/chain', () => ({
  pub: { getCode: chainMock.getCode, readContract: chainMock.readContract },
  multicall: vi.fn(),
  enc: vi.fn(),
  dec: vi.fn(),
}));

const push4 = (sel: string) => `63${sel.slice(2)}`;
const ZAP_V1 = `0x6080${push4(SELECTORS.canonicalMarket)}00`;
const VAULT_V1 = `0x6080${push4(SELECTORS.mintSetWithAuthorization)}${push4(SELECTORS.mintSetWithPermit)}00`;
const RESOLVER_V1 = `0x6080${push4(SELECTORS.challengeWindow)}00`;
const RESOLVER_FEAS = '0x608060405200';

/** getCode by call order: zap, vault, resolver (Promise.all in readCapabilities). */
function codes(zap: string, vault: string, resolver: string) {
  chainMock.getCode.mockImplementation(async ({ address }: { address: string }) => {
    if (address === DEPLOYMENTS.zap) return zap;
    if (address === DEPLOYMENTS.vault) return vault;
    if (address === DEPLOYMENTS.resolver) return resolver;
    return '0x';
  });
}

async function freshData() {
  vi.resetModules();
  return import('../src/lib/data');
}

describe('capabilities(): only successful reads are cached', () => {
  beforeEach(() => {
    chainMock.getCode.mockReset();
    chainMock.readContract.mockReset();
  });

  it('a getCode failure is not cached as "no registry": it throws, and the next call reads again', async () => {
    const data = await freshData();
    chainMock.getCode.mockRejectedValue(new Error('HTTP request failed (429)'));
    await expect(data.capabilities()).rejects.toThrow(/429/);
    codes(ZAP_V1, VAULT_V1, RESOLVER_V1);
    chainMock.readContract.mockResolvedValue(900n);
    const caps = await data.capabilities();
    expect(caps).toEqual({ canonicalRegistry: true, mintWithAuthorization: true, mintWithPermit: true, challengeWindow: 900 });
    const calls = chainMock.getCode.mock.calls.length;
    expect(await data.capabilities()).toBe(caps); // cached now
    expect(chainMock.getCode.mock.calls.length).toBe(calls);
  });

  it('a failed challengeWindow read falls back to the deployed 900 s (not 0) and is retried on the next call', async () => {
    const data = await freshData();
    expect(data.DEFAULT_CHALLENGE_WINDOW).toBe(900); // deployments/testnet.json params.challengeWindow
    codes(ZAP_V1, VAULT_V1, RESOLVER_V1);
    chainMock.readContract.mockRejectedValueOnce(new Error('timeout'));
    const first = await data.capabilities();
    expect(first.challengeWindow).toBe(900);
    expect(first.canonicalRegistry).toBe(true);
    chainMock.readContract.mockResolvedValueOnce(1800n);
    const second = await data.capabilities(); // not cached: asks again
    expect(second.challengeWindow).toBe(1800);
    expect(chainMock.readContract).toHaveBeenCalledTimes(2);
    expect(await data.capabilities()).toBe(second);
    expect(chainMock.readContract).toHaveBeenCalledTimes(2);
  });

  it('the feasibility resolver (no challengeWindow function) is a real 0 and is cached without a call', async () => {
    const data = await freshData();
    codes('0x6080', '0x6080', RESOLVER_FEAS);
    const caps = await data.capabilities();
    expect(caps).toEqual({ canonicalRegistry: false, mintWithAuthorization: false, mintWithPermit: false, challengeWindow: 0 });
    expect(chainMock.readContract).not.toHaveBeenCalled();
    expect(await data.capabilities()).toBe(caps);
  });

  it('concurrent callers share one in-flight read', async () => {
    const data = await freshData();
    codes(ZAP_V1, VAULT_V1, RESOLVER_V1);
    chainMock.readContract.mockResolvedValue(900n);
    const [a, b] = await Promise.all([data.capabilities(), data.capabilities()]);
    expect(a).toBe(b);
    expect(chainMock.getCode).toHaveBeenCalledTimes(3);
  });
});

describe('deployments: challengeWindow', () => {
  it('reads params.challengeWindow and ignores maxChallengeWindow', () => {
    expect(normalizeDeployments({ params: { maxChallengeWindow: 172800, challengeWindow: 900 } }).challengeWindow).toBe(900);
    expect(normalizeDeployments({ params: { maxChallengeWindow: 172800 } }).challengeWindow).toBeNull();
    expect(normalizeDeployments({}).challengeWindow).toBeNull();
  });
});

describe('retrying step 2 keeps the original per-unit minimum', () => {
  // the N1 numbers: 100 sets quoted on a 100-YES bid at 0.43, then a sandwich leaves 50 YES bid at 0.001
  const quoted: Book = { bids: [{ price: 0.43, size: 100 }], asks: [], bestBid: 0.43, bestAsk: null };
  const sandwiched: Book = { bids: [{ price: 0.001, size: 50 }], asks: [], bestBid: 0.001, bestAsk: null };
  const plan = planBuyNo(quoteBuyNoViaSell(quoted, 1000, 1000, 10), 0.02, { ausdVault: 0n, yesZap: 0n })!;
  const pairs = plan.mint;

  it('after a sandwich the old fresh-quote retry would pay ~0.999 per No; the floor blocks it', () => {
    const fresh = quoteSellYes(sandwiched, Number(pairs) / 1e6, 10);
    const oldMin = minOut(fresh.proceeds, 0.02); // what retrySell used before
    expect(Number(pairs - oldMin) / Number(pairs)).toBeGreaterThan(0.99);
    const r = planRetrySell(plan, pairs, fresh.proceeds, 0.02);
    expect(r.floor).toBe(plan.minAusdOut);
    expect(r.minAusdOut).toBe(plan.minAusdOut);
    expect(r.blocked).toBe(true);
    expect(r.noPriceNow).toBeGreaterThan(0.99);
    expect(r.noPriceWorst).toBeCloseTo(Number(plan.worstCost) / Number(plan.mint), 9);
    expect(r.noPriceNow).toBeGreaterThan(r.noPriceWorst);
  });

  it('a wallet rejection on an unchanged book retries at the original minimum', () => {
    const r = planRetrySell(plan, pairs, quoteSellYes(quoted, Number(pairs) / 1e6, 10).proceeds, 0.02);
    expect(r.blocked).toBe(false);
    expect(r.minAusdOut).toBe(plan.minAusdOut);
    expect(Number(pairs - r.minAusdOut) / Number(pairs)).toBeLessThanOrEqual(r.noPriceWorst + 1e-12);
  });

  it('a slightly worse book inside the original slippage: the floor binds, the sale is still offered', () => {
    const worse: Book = { bids: [{ price: 0.425, size: 100 }], asks: [], bestBid: 0.425, bestAsk: null };
    const proceeds = quoteSellYes(worse, Number(pairs) / 1e6, 10).proceeds;
    expect(minOut(proceeds, 0.02) < plan.minAusdOut).toBe(true);
    const r = planRetrySell(plan, pairs, proceeds, 0.02);
    expect(r.blocked).toBe(false);
    expect(r.minAusdOut).toBe(plan.minAusdOut);
  });

  it('a better book raises the minimum above the floor', () => {
    const better: Book = { bids: [{ price: 0.5, size: 100 }], asks: [], bestBid: 0.5, bestAsk: null };
    const proceeds = quoteSellYes(better, Number(pairs) / 1e6, 10).proceeds;
    const r = planRetrySell(plan, pairs, proceeds, 0.02);
    expect(r.minAusdOut).toBe(minOut(proceeds, 0.02));
    expect(r.minAusdOut > r.floor).toBe(true);
    expect(r.blocked).toBe(false);
  });

  it('scales the floor per unit (rounded up) and blocks with no bids', () => {
    const half = pairs / 2n + 1n;
    const r = planRetrySell(plan, half, 0, 0.02);
    expect(r.floor * plan.mint >= plan.minAusdOut * half).toBe(true);
    expect((r.floor - 1n) * plan.mint < plan.minAusdOut * half).toBe(true);
    expect(r.blocked).toBe(true);
    expect(r.noPriceNow).toBe(1);
    expect(toUnits6(0)).toBe(0n);
  });
});
