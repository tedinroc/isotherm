// Security review v1 (2026-10-07): abuse tests for the drip / relay endpoints. No chain access: the relayer core
// runs against an in-memory store and a fake viem client whose every call yields to the event loop, the way RPC
// I/O does inside the Durable Object (a DO serves concurrent requests on one thread, interleaving at awaits).
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, getAddress, keccak256, stringToHex, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { RECEIVE_TYPES, SELECTORS } from '../../src/abi';
import { DEPLOYMENTS } from '../../src/deployments';
import { configFrom, type Env } from '../../src/env';
import { MemStore } from '../../src/limits';
import { authorizationNonce, createRelayer } from '../../src/relayer';
import { normalizeSnapshot } from '../../src/snapshot';
import { ipBucket } from '../../src/util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const io = () => new Promise((r) => setTimeout(r, 2));

interface FakeOpts {
  relayerMon?: bigint;
  receiptStatus?: 'success' | 'reverted';
  receiptThrows?: boolean;
  vaultHasAuthorization?: boolean;
  ausdOf?: (a: string) => bigint;
}

function fakeChain(opts: FakeOpts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const series = encodeAbiParameters(
    [
      { type: 'bytes4' },
      { type: 'uint32' },
      { type: 'int16' },
      { type: 'uint64' },
      { type: 'bool' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
    ],
    [stringToHex('RCSS', { size: 4 }), 20261008, 30, BigInt(now + 6 * 3600), false, getAddress(`0x${'aa'.repeat(20)}`), getAddress(`0x${'bb'.repeat(20)}`), 0n],
  );
  const account = privateKeyToAccount(generatePrivateKey());
  let nonce = 0;
  const sent: string[] = [];
  const rpc = { blockNumber: 0 };
  const pub = {
    call: async () => (await io(), { data: series }),
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      await io();
      if (functionName === 'balanceOf') return opts.ausdOf ? opts.ausdOf(String(args?.[0])) : 1_000_000_000n;
      if (functionName === 'authorizationState') return false;
      if (functionName === 'nonces') return 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    getCode: async ({ address }: { address: string }) => {
      await io();
      if (getAddress(address) !== getAddress(DEPLOYMENTS.vault)) return undefined; // EOAs have no code
      const auth = opts.vaultHasAuthorization === false ? '' : `63${SELECTORS.mintSetWithAuthorization.slice(2)}`;
      return `0x${auth}63${SELECTORS.mintSetWithPermit.slice(2)}` as Hex;
    },
    getBalance: async ({ address }: { address: string }) => (await io(), address === account.address ? (opts.relayerMon ?? 5n * 10n ** 18n) : 0n),
    estimateContractGas: async () => (await io(), 310_000n),
    getTransactionCount: async () => (await io(), nonce),
    getBlockNumber: async () => (await io(), (rpc.blockNumber += 1), 100n),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      await io();
      if (opts.receiptThrows) throw new Error('WaitForTransactionReceiptTimeoutError');
      return { status: opts.receiptStatus ?? 'success', blockNumber: 100n, gasUsed: 309_470n, transactionHash: hash };
    },
  };
  const wallet = {
    account,
    chain: { id: 10143 },
    writeContract: async (req: { functionName: string }) => {
      await io();
      nonce += 1;
      sent.push(req.functionName);
      return keccak256(toHex(`tx${nonce}`));
    },
    sendTransaction: async () => {
      await io();
      nonce += 1;
      sent.push('value');
      return keccak256(toHex(`tx${nonce}`));
    },
  };
  return { pub, wallet, sent, rpc };
}

function relayerWith(opts: FakeOpts = {}, over: Partial<ReturnType<typeof configFrom>> = {}) {
  const chain = fakeChain(opts);
  const store = new MemStore();
  const cfg = { ...configFrom({} as Env), ...over };
  const relayer = createRelayer({ cfg, dep: DEPLOYMENTS, pub: chain.pub as never, wallet: chain.wallet as never, store });
  return { ...chain, store, cfg, relayer };
}

async function signedAuthorization(holderKey: Hex, seriesId: Hex, amount: bigint, salt: Hex) {
  const holder = privateKeyToAccount(holderKey);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 900);
  const signature = await holder.signTypedData({
    domain: { name: 'Agora Dollar', version: '1', chainId: 10143, verifyingContract: DEPLOYMENTS.ausd },
    types: RECEIVE_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: { from: holder.address, to: DEPLOYMENTS.vault, value: amount, validAfter: 0n, validBefore, nonce: authorizationNonce(seriesId, amount, salt) },
  });
  return {
    mode: 'authorization' as const,
    chainId: 10143,
    seriesId,
    amount: amount.toString(),
    holder: holder.address as Address,
    validAfter: '0',
    validBefore: validBefore.toString(),
    salt,
    signature,
  };
}

describe('relayed mint: caps hold under concurrent requests', () => {
  it('N parallel requests for one holder relay at most the per-address cap (and never past the daily cap)', async () => {
    const { pub, wallet, sent } = fakeChain();
    const store = new MemStore();
    const cfg = { ...configFrom({} as Env), relayPerAddressPerDay: 2, relayDailyCap: 3 };
    const relayer = createRelayer({ cfg, dep: DEPLOYMENTS, pub: pub as never, wallet: wallet as never, store });
    const seriesId = keccak256(toHex('series'));
    const holderKey = generatePrivateKey();
    const reqs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => signedAuthorization(holderKey, seriesId, 1_000_000n, keccak256(toHex(`salt${i}`)))),
    );
    const results = await Promise.allSettled(reqs.map((r) => relayer.relayMint(r)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(sent.filter((f) => f === 'mintSetWithAuthorization').length).toBe(ok);
    expect(ok).toBe(2); // per-address cap; before the fix all 8 passed the check and were broadcast
    // a second holder can use the remaining global slot, then the daily cap holds
    const other = generatePrivateKey();
    const more = await Promise.all(Array.from({ length: 5 }, (_, i) => signedAuthorization(other, seriesId, 1_000_000n, keccak256(toHex(`o${i}`)))));
    const r2 = await Promise.allSettled(more.map((r) => relayer.relayMint(r)));
    expect(r2.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(sent.length).toBe(3);
    expect(await store.get('relay:total')).toBe(3);
  });
});

describe('health: a flood of /api/health calls does not become a flood of RPC calls', () => {
  it('memoises relayer info for a few seconds and dedupes in-flight calls', async () => {
    const { pub, wallet, rpc } = fakeChain();
    const relayer = createRelayer({ cfg: configFrom({} as Env), dep: DEPLOYMENTS, pub: pub as never, wallet: wallet as never, store: new MemStore() });
    const all = await Promise.all(Array.from({ length: 50 }, () => relayer.info()));
    expect(all.every((x) => x.relayer === wallet.account.address)).toBe(true);
    expect(rpc.blockNumber).toBe(1);
  });
});

describe('drip: per-network limit is keyed by IPv6 /64, not the full address', () => {
  it('buckets IPv6 by /64 and leaves IPv4 alone', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe(ipBucket('2001:db8:1:2:ffff:ffff:ffff:fffe'));
    expect(ipBucket('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:DB8:0001:0002:0:0:0:9')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(ipBucket('2001:db8:1:2::1'));
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('local')).toBe('local');
  });
});

describe('snapshot: only https Polymarket links reach the web app', () => {
  const snap = (url: unknown) => ({ ladders: [{ station: 'RCSS', date: '2026-10-08', polymarket: { url }, strikes: [] }] });
  it('drops javascript: and foreign URLs (React 18 renders javascript: hrefs)', () => {
    expect(normalizeSnapshot(snap('javascript:alert(document.cookie)')).ladders[0].polymarketUrl).toBeNull();
    expect(normalizeSnapshot(snap('https://evil.example/event/x')).ladders[0].polymarketUrl).toBeNull();
    expect(normalizeSnapshot(snap('http://polymarket.com/event/x')).ladders[0].polymarketUrl).toBeNull();
    const good = 'https://polymarket.com/event/highest-temperature-in-taipei-on-october-8-2026';
    expect(normalizeSnapshot(snap(good)).ladders[0].polymarketUrl).toBe(good);
  });
});

// ---- API fix round (2026-10-07): caps sized to the relayer's MON, per-network relay limit, dust floor, permit off ----
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: { status?: number; message?: string }) => ({ ok: false as const, status: e.status, message: e.message }));

describe('relayed mint: per-network limit, minimum amount, permit disabled', () => {
  it('8 parallel requests from 8 holders on one network relay at most RELAY_PER_IP_PER_DAY', async () => {
    const { relayer, sent, store } = relayerWith({}, { relayPerIpPerDay: 2, relayPerAddressPerDay: 5, relayDailyCap: 50 });
    const seriesId = keccak256(toHex('series'));
    const reqs = await Promise.all(Array.from({ length: 8 }, (_, i) => signedAuthorization(generatePrivateKey(), seriesId, 1_000_000n, keccak256(toHex(`n${i}`)))));
    const res = await Promise.all(reqs.map((r) => settle(relayer.relayMint(r, 'net-a'))));
    expect(res.filter((r) => r.ok).length).toBe(2);
    expect(res.filter((r) => !r.ok).every((r) => !r.ok && r.status === 429 && /this network/.test(r.message ?? ''))).toBe(true);
    expect(sent.length).toBe(2);
    // another network still has its own allowance
    const other = await signedAuthorization(generatePrivateKey(), seriesId, 1_000_000n, keccak256(toHex('other')));
    expect((await settle(relayer.relayMint(other, 'net-b'))).ok).toBe(true);
    expect(await store.get('relay:total')).toBe(3);
  });

  it('refuses dust (below RELAY_MIN_AUSD, default 1 AUSD) before any RPC call', async () => {
    const { relayer, sent, rpc } = relayerWith();
    const seriesId = keccak256(toHex('series'));
    const dust = await signedAuthorization(generatePrivateKey(), seriesId, 999_999n, keccak256(toHex('d')));
    const r = await settle(relayer.relayMint(dust, 'net'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/between 1 and 500 AUSD/);
    expect(sent.length).toBe(0);
    expect(rpc.blockNumber).toBe(0);
  });

  it('offers authorization mode only for the v1 vault; permit requests are refused', async () => {
    const { relayer, sent } = relayerWith();
    expect(await relayer.relayModes()).toEqual(['authorization']);
    const r = await settle(
      relayer.relayMint({ mode: 'permit', chainId: 10143, seriesId: keccak256(toHex('s')), amount: '2000000', holder: privateKeyToAccount(generatePrivateKey()).address, deadline: String(Math.floor(Date.now() / 1000) + 600), signature: `0x${'11'.repeat(65)}` } as never, 'net'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/permit-mode relays are disabled/);
    expect(sent.length).toBe(0);
    // a vault without the EIP-3009 path gets permit only when explicitly allowed
    expect(await relayerWith({ vaultHasAuthorization: false }).relayer.relayModes()).toEqual([]);
    expect(await relayerWith({ vaultHasAuthorization: false }, { relayAllowPermit: true }).relayer.relayModes()).toEqual(['permit']);
  });

  it('a relay that reverts on chain still uses up quota (Monad bills the gas limit)', async () => {
    const { relayer, sent, store } = relayerWith({ receiptStatus: 'reverted' }, { relayPerAddressPerDay: 1, relayPerIpPerDay: 5, relayDailyCap: 5 });
    const seriesId = keccak256(toHex('series'));
    const key = generatePrivateKey();
    const first = await settle(relayer.relayMint(await signedAuthorization(key, seriesId, 1_000_000n, keccak256(toHex('a'))), 'net'));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.status).toBe(502);
    const again = await settle(relayer.relayMint(await signedAuthorization(key, seriesId, 1_000_000n, keccak256(toHex('b'))), 'net'));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(429);
    expect(sent.length).toBe(1);
    expect(await store.get('relay:total')).toBe(1);
  });

  it('never relays into the reserve: needs RELAY_COST_MON + RELAYER_MIN_MON on hand', async () => {
    const { relayer, sent } = relayerWith({ relayerMon: 130_000_000_000_000_000n }); // 0.13 MON
    const r = await settle(relayer.relayMint(await signedAuthorization(generatePrivateKey(), keccak256(toHex('series')), 1_000_000n, keccak256(toHex('r'))), 'net'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
    expect(sent.length).toBe(0);
    const info = await relayerWith({ relayerMon: 130_000_000_000_000_000n }).relayer.info();
    expect(info.relayReady).toBe(false); // 0.13 < 0.035 + 0.1
    expect(info.dripReady).toBe(false);
    expect(info.relayModes).toEqual(['authorization']);
    expect(info.limits).toMatchObject({ reserveMon: '0.1', dripDailyCap: 2, dripPerIpPerDay: 1, relayDailyCap: 5, relayPerIpPerDay: 2, relayPerAddressPerDay: 2, dripsToday: 0, relaysToday: 0 });
  });
});

describe('drip: reserve floor and counting on broadcast', () => {
  const user = () => privateKeyToAccount(generatePrivateKey()).address;
  it('refuses a drip that would dip into the reserve (DRIP_MON + DRIP_GAS_MON + RELAYER_MIN_MON)', async () => {
    const { relayer, sent } = relayerWith({ relayerMon: 250_000_000_000_000_000n, ausdOf: () => 0n }); // 0.25 < 0.15 + 0.011 + 0.1
    const r = await settle(relayer.drip(user(), 'net'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
    expect(sent.length).toBe(0);
  });

  it('a drip whose receipt never arrives still counts, and a retry sends nothing twice', async () => {
    const fake = relayerWith({ receiptThrows: true }, { dripPerIpPerDay: 1, dripDailyCap: 2 });
    const u = user();
    // user holds 1000 AUSD in this fake (balanceOf = 1000 for all), so only the MON leg is sent
    const r = await settle(fake.relayer.drip(u, 'net'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(504);
    expect(fake.sent).toEqual(['value']);
    expect(await fake.store.get('drip:total')).toBe(1);
    // same address again: cooldown (no new MON); another address on the same network: per-network limit
    const again = await settle(fake.relayer.drip(u, 'net'));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(429);
    const sameNet = await settle(fake.relayer.drip(user(), 'net'));
    expect(sameNet.ok).toBe(false);
    if (!sameNet.ok) expect(sameNet.message).toMatch(/this network/);
    expect(fake.sent).toEqual(['value']);
  });
});

describe('snapshot: maker sizes pass through; "reason" is the current decision, not the last change', () => {
  const strike = {
    strike: 30,
    fair: 0.4079,
    pm: 0.4079,
    guard: 0.5907,
    mode: 'quoting',
    reason: 'bid 0.36 -> 0.34; ask 0.49 -> 0.47; fair moved 0.4278 -> 0.406',
    bid: 0.34,
    bidSize: 100,
    ask: 0.47,
    askSize: 100,
    quote: { bid: 0.34, bidSize: 100, ask: 0.47, askSize: 100, at: 1791353266 },
    resting: { bid: { id: 3, price: 0.34, remaining: 100 }, ask: { id: 4, price: 0.47, remaining: 76.923076 } },
    lastAction: { kind: 'none', reasons: ['quote still good'], tx: null, error: null },
  };
  const snap = (s: Record<string, unknown>) => ({ ladders: [{ station: 'RCSS', date: '2026-10-08', series: [s] }] });
  it('maps lastAction -> action/reason and the persisted reason -> lastChangeReason', () => {
    const k = normalizeSnapshot(snap(strike)).ladders[0].strikes[0];
    expect(k).toMatchObject({
      k: 30,
      bid: 0.34,
      ask: 0.47,
      bidSize: 100,
      askSize: 100,
      bidRemaining: 100,
      askRemaining: 76.923076,
      action: 'none',
      reason: 'quote still good',
      lastChangeReason: 'bid 0.36 -> 0.34; ask 0.49 -> 0.47; fair moved 0.4278 -> 0.406',
      lastQuoteAt: 1791353266,
    });
  });
  it('no current decision -> reason null (never the stale one); no resting orders -> remaining 0; unknown -> null', () => {
    const k = normalizeSnapshot(snap({ ...strike, lastAction: null, resting: {}, bid: null, bidSize: 0 })).ladders[0].strikes[0];
    expect(k.reason).toBeNull();
    expect(k.action).toBeNull();
    expect(k.lastChangeReason).toContain('fair moved');
    expect(k.bidSize).toBe(0);
    expect(k.bidRemaining).toBe(0);
    expect(k.askRemaining).toBe(0);
    const u = normalizeSnapshot(snap({ strike: 29, fair: 0.8 })).ladders[0].strikes[0];
    expect([u.bidSize, u.askSize, u.bidRemaining, u.askRemaining, u.reason, u.lastChangeReason]).toEqual([null, null, null, null, null, null]);
  });
  it('the real maker example snapshot normalises with sizes', () => {
    const file = join(__dirname, '../../../../packages/maker/examples/snapshot.example.json');
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const rows = raw.ladders[0].strikes as { strike: number; bidSize: number; askSize: number }[];
    const got = normalizeSnapshot(raw).ladders[0].strikes;
    for (const r of rows) {
      const g = got.find((x) => x.k === r.strike)!;
      expect(g.bidSize).toBe(r.bidSize);
      expect(g.askSize).toBe(r.askSize);
    }
  });
});

describe('health: ready flags respect the daily caps', () => {
  it('dripReady / relayReady turn false once today\'s cap is used, even with MON on hand', async () => {
    const { relayer, store } = relayerWith({}, { dripDailyCap: 2, relayDailyCap: 5 });
    const { dayKey } = await import('../../src/util');
    expect((await relayer.info()).dripReady).toBe(true);
    await store.put(`drip:day:${dayKey()}`, 2);
    await store.put(`relay:day:${dayKey()}`, 5);
    const c = fakeChain(); // a new relayer instance: info() is memoised for 5 s
    const fresh = createRelayer({ cfg: { ...configFrom({} as Env), dripDailyCap: 2, relayDailyCap: 5 }, dep: DEPLOYMENTS, pub: c.pub as never, wallet: c.wallet as never, store });
    const i = await fresh.info();
    expect(i.monBalance).toBe('5'); // MON is not the reason
    expect(i.dripReady).toBe(false);
    expect(i.relayReady).toBe(false);
    expect(i.limits).toMatchObject({ dripsToday: 2, relaysToday: 5 });
  });
});

describe('per-network request window (Durable Object memory)', () => {
  it('allows N per minute per key, then 429 with a retry hint; other keys and the next window are unaffected', async () => {
    const { WindowLimiter } = await import('../../src/limits');
    const w = new WindowLimiter(3, 60_000);
    const t = 1_000_000;
    expect([1, 2, 3].map((i) => w.hit('a', t + i).ok)).toEqual([true, true, true]);
    const r = w.hit('a', t + 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBe(60);
    expect(w.hit('b', t + 10).ok).toBe(true);
    expect(w.hit('a', t + 60_001).ok).toBe(true);
  });
});
