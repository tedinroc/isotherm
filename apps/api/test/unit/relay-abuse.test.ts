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

const io = () => new Promise((r) => setTimeout(r, 2));

function fakeChain() {
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
  let nonce = 0;
  const sent: string[] = [];
  const rpc = { blockNumber: 0 };
  const pub = {
    call: async () => (await io(), { data: series }),
    readContract: async ({ functionName }: { functionName: string }) => {
      await io();
      if (functionName === 'balanceOf') return 1_000_000_000n;
      if (functionName === 'authorizationState') return false;
      if (functionName === 'nonces') return 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    getCode: async () => (await io(), `0x63${SELECTORS.mintSetWithAuthorization.slice(2)}63${SELECTORS.mintSetWithPermit.slice(2)}` as Hex),
    getBalance: async () => (await io(), 5n * 10n ** 18n),
    estimateContractGas: async () => (await io(), 310_000n),
    getTransactionCount: async () => (await io(), nonce),
    getBlockNumber: async () => (await io(), (rpc.blockNumber += 1), 100n),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => (await io(), { status: 'success', blockNumber: 100n, gasUsed: 309_470n, transactionHash: hash }),
  };
  const account = privateKeyToAccount(generatePrivateKey());
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
      Array.from({ length: 8 }, (_, i) => signedAuthorization(holderKey, seriesId, 1n, keccak256(toHex(`salt${i}`)))),
    );
    const results = await Promise.allSettled(reqs.map((r) => relayer.relayMint(r)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(sent.filter((f) => f === 'mintSetWithAuthorization').length).toBe(ok);
    expect(ok).toBe(2); // per-address cap; before the fix all 8 passed the check and were broadcast
    // a second holder can use the remaining global slot, then the daily cap holds
    const other = generatePrivateKey();
    const more = await Promise.all(Array.from({ length: 5 }, (_, i) => signedAuthorization(other, seriesId, 1n, keccak256(toHex(`o${i}`)))));
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
