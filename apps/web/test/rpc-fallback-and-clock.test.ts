/// <reference path="../src/vite-env.d.ts" />
// The read/dev-wallet transport holds on to RPC_URL (one retry, a cooldown after a hang or a second failure), then falls
// back to Ankr, then thirdweb (only for the public testnet RPC, never for a fork), and "max so far" shows the observation
// time as station-local HH:MM.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { FALLBACK_RPC_URLS, rpcUrlsFor } from '../src/config';
import { chain, devWalletClient, explainError, pub, rpcTransport } from '../src/lib/chain';
import { observedClock } from '../src/lib/stations';
import { translate } from '../src/i18n';

const OFFICIAL = 'https://testnet-rpc.monad.xyz';
const [ANKR, THIRDWEB] = FALLBACK_RPC_URLS;

describe('rpcUrlsFor', () => {
  it('the public Monad testnet RPC: RPC_URL first, then Ankr, then thirdweb', () => {
    expect(rpcUrlsFor(OFFICIAL, 10143)).toEqual([OFFICIAL, ANKR, THIRDWEB]);
    expect(rpcUrlsFor(`${OFFICIAL}/`, 10143)).toEqual([`${OFFICIAL}/`, ANKR, THIRDWEB]);
    expect(ANKR).toBe('https://rpc.ankr.com/monad_testnet');
    expect(THIRDWEB).toBe('https://10143.rpc.thirdweb.com');
  });
  it('a fork on any host (anvil keeps chain id 10143), another RPC or another chain keeps its single endpoint', () => {
    for (const u of [
      'http://127.0.0.1:19201',
      'http://localhost:8545',
      'http://[::1]:8545/',
      'https://localhost',
      'http://0.0.0.0:8545',
      'http://127.0.0.2:8545',
      'http://anvil.localhost:8545',
      'http://192.168.1.5:8545',
      'http://host.docker.internal:8545',
      'http://testnet-rpc.monad.xyz',
      'https://monad-testnet.example.org/rpc',
      'not a url',
    ]) {
      expect(rpcUrlsFor(u, 10143)).toEqual([u]);
    }
    expect(rpcUrlsFor(OFFICIAL, 31337)).toEqual([OFFICIAL]);
  });
  it('a fallback named as RPC_URL is not listed twice', () => {
    expect(rpcUrlsFor(ANKR, 10143)).toEqual([ANKR, THIRDWEB]);
  });
});

type Reply = { status?: number; hang?: true; result?: unknown; error?: { code: number; message: string; data?: string } };
function stubRpc(byUrl: Record<string, (method: string, n: number) => Reply>) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string; signal?: AbortSignal | null }) => {
      const { id, method } = JSON.parse(init.body) as { id: number; method: string };
      const u = String(url).replace(/\/$/, ''); // viem sends the URL with a trailing slash
      seen.push(`${u} ${method}`);
      const r = byUrl[u](method, seen.filter((s) => s.startsWith(`${u} `)).length);
      if (r.hang) {
        // never answers; viem's timeout aborts the request
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
        );
      }
      if (r.status && r.status !== 200) return new Response('unavailable', { status: r.status });
      const body = r.error ? { jsonrpc: '2.0', id, error: r.error } : { jsonrpc: '2.0', id, result: r.result };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return seen;
}
const FAST = { primaryTimeoutMs: 150, retryDelayMs: 5, cooldownMs: 300 };
const client = (urls: string[], timing = FAST) => createPublicClient({ chain, transport: rpcTransport(urls, timing) });
const URLS = [OFFICIAL, ANKR, THIRDWEB];
const asked = (seen: string[], url: string) => seen.filter((s) => s.startsWith(`${url} `)).length;

describe('rpcTransport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('one 429 on the official RPC is retried there, so the request stays on the freshest node', async () => {
    const seen = stubRpc({
      [OFFICIAL]: (_, n) => (n === 1 ? { status: 429 } : { result: '0x2a' }),
      [ANKR]: () => ({ result: '0x99' }),
      [THIRDWEB]: () => ({ result: '0x99' }),
    });
    expect(await client(URLS).getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(seen).toEqual([`${OFFICIAL} eth_blockNumber`, `${OFFICIAL} eth_blockNumber`]);
  });

  it('the official JSON-RPC rate-limit replies ("requests limited to 15/sec" as -32007 or -32603) are retried there too', async () => {
    for (const code of [-32007, -32603]) {
      const seen = stubRpc({
        [OFFICIAL]: (_, n) => (n === 1 ? { error: { code, message: 'requests limited to 15/sec' } } : { result: '0x2a' }),
        [ANKR]: () => ({ result: '0x99' }),
        [THIRDWEB]: () => ({ result: '0x99' }),
      });
      expect(await client(URLS).getBlockNumber({ cacheTime: 0 })).toBe(42n);
      expect(seen).toEqual([`${OFFICIAL} eth_blockNumber`, `${OFFICIAL} eth_blockNumber`]);
      vi.unstubAllGlobals();
    }
  });

  it('a primary that fails twice hands the request to Ankr and is skipped until its cooldown ends', async () => {
    const seen = stubRpc({ [OFFICIAL]: () => ({ status: 429 }), [ANKR]: () => ({ result: '0x2a' }), [THIRDWEB]: () => ({ result: '0x99' }) });
    const c = client(URLS);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(seen).toEqual([`${OFFICIAL} eth_blockNumber`, `${OFFICIAL} eth_blockNumber`, `${ANKR} eth_blockNumber`]);
    seen.length = 0;
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(seen).toEqual([`${ANKR} eth_blockNumber`]); // cooling: no second wait on the primary
    seen.length = 0;
    await new Promise((r) => setTimeout(r, FAST.cooldownMs + 50));
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(asked(seen, OFFICIAL)).toBe(2); // tried again after the cooldown
  });

  it('a hung primary costs one timeout, then is skipped for the cooldown', async () => {
    const seen = stubRpc({ [OFFICIAL]: () => ({ hang: true }), [ANKR]: () => ({ result: '0x2a' }), [THIRDWEB]: () => ({ result: '0x99' }) });
    const c = client(URLS);
    const t0 = Date.now();
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FAST.primaryTimeoutMs - 10);
    expect(seen).toEqual([`${OFFICIAL} eth_blockNumber`, `${ANKR} eth_blockNumber`]); // a timeout is not retried
    seen.length = 0;
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(seen).toEqual([`${ANKR} eth_blockNumber`]);
  });

  it('the order is fixed: a healthy primary is always asked first', async () => {
    const seen = stubRpc({ [OFFICIAL]: () => ({ result: '0x1' }), [ANKR]: () => ({ result: '0x2' }), [THIRDWEB]: () => ({ result: '0x3' }) });
    const c = client(URLS);
    for (let i = 0; i < 3; i++) expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(1n);
    expect(seen.every((s) => s.startsWith(OFFICIAL))).toBe(true);
  });

  it('a revert is thrown at once (not re-sent elsewhere) and still decodes to a friendly reason', async () => {
    const revert = { code: 3, message: 'execution reverted', data: '0xd93c0665' }; // EnforcedPause()
    const seen = stubRpc({ [OFFICIAL]: () => ({ error: revert }), [ANKR]: () => ({ result: '0x' }), [THIRDWEB]: () => ({ result: '0x' }) });
    const err = await client(URLS)
      .call({ to: '0x0000000000000000000000000000000000000001', data: '0x12345678' })
      .catch((e: unknown) => e);
    expect(seen).toEqual([`${OFFICIAL} eth_call`]);
    expect(explainError(err)).toBe('Minting is paused by the guardian right now.');
  });

  it('a deterministic -32000 (insufficient balance, nonce too low) is thrown at once and the user data stays on the primary', async () => {
    for (const [method, message] of [
      ['eth_estimateGas', 'insufficient balance'],
      ['eth_sendRawTransaction', 'nonce too low'],
    ]) {
      const seen = stubRpc({
        [OFFICIAL]: () => ({ error: { code: -32000, message } }),
        [ANKR]: () => ({ result: '0x5208' }),
        [THIRDWEB]: () => ({ result: '0x5208' }),
      });
      const err = await client(URLS)
        .request({ method, params: [method === 'eth_estimateGas' ? { to: '0x0000000000000000000000000000000000000001', value: '0x1' } : '0xc0'] } as never)
        .catch((e: unknown) => e);
      expect(seen).toEqual([`${OFFICIAL} ${method}`]);
      expect((err as { details?: string }).details).toBe(message);
      vi.unstubAllGlobals();
    }
  });

  it('a short sender\'s estimate ("insufficient balance") is explained as missing MON, not "Missing or invalid parameters."', async () => {
    const seen = stubRpc({
      [OFFICIAL]: () => ({ error: { code: -32000, message: 'insufficient balance' } }),
      [ANKR]: () => ({ result: '0x5208' }),
      [THIRDWEB]: () => ({ result: '0x5208' }),
    });
    const err = await client(URLS)
      .estimateGas({ account: '0x7a3b9c2d1e0f4a5b6c7d8e9f0a1b2c3d4e5f6a7b', to: '0x0000000000000000000000000000000000000001', value: 10n ** 18n })
      .catch((e: unknown) => e);
    expect(seen).toEqual([`${OFFICIAL} eth_estimateGas`]);
    expect(explainError(err)).toBe('Not enough MON for the network fee. Tap "Get test funds".');
    // a contract's own revert text is not a missing-MON node reply
    expect(explainError({ shortMessage: 'Execution reverted.', details: 'execution reverted: insufficient balance' })).toBe('Execution reverted.');
  });

  it('any other node error moves on at once, without a retry or a cooldown of the primary', async () => {
    const seen = stubRpc({
      [OFFICIAL]: (_, n) => (n === 1 ? { error: { code: -32000, message: 'header not found' } } : { result: '0x1' }),
      [ANKR]: () => ({ result: '0x2a' }),
      [THIRDWEB]: () => ({ result: '0x99' }),
    });
    const c = client(URLS);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(seen).toEqual([`${OFFICIAL} eth_blockNumber`, `${ANKR} eth_blockNumber`]);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(1n); // not cooling
  });

  it('when every endpoint is down: the primary twice, then the fallbacks; the retried rounds skip the cooling primary', async () => {
    const seen = stubRpc({ [OFFICIAL]: () => ({ status: 503 }), [ANKR]: () => ({ status: 503 }), [THIRDWEB]: () => ({ status: 503 }) });
    // the default 30 s cooldown outlasts the transport's own retry delays (0.4 s, then 0.8 s)
    await expect(client(URLS, { ...FAST, cooldownMs: 30_000 }).getBlockNumber({ cacheTime: 0 })).rejects.toThrow(/HTTP request failed/);
    const fb = [`${ANKR} eth_blockNumber`, `${THIRDWEB} eth_blockNumber`];
    expect(seen).toEqual([`${OFFICIAL} eth_blockNumber`, `${OFFICIAL} eth_blockNumber`, ...fb, ...fb, ...fb]);
  });

  it('a single URL (local fork) is a plain http transport that never leaves it', async () => {
    const fork = 'http://127.0.0.1:19201';
    const seen = stubRpc({ [fork]: () => ({ result: '0x5' }) });
    const c = client([fork]);
    expect(c.transport.type).toBe('http');
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(5n);
    expect(seen).toEqual([`${fork} eth_blockNumber`]);
  });
});

describe('the app clients (default RPC_URL)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the dev wallet broadcasts through the fallback transport, and shares the primary cooldown with reads', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const seen = stubRpc({
      [OFFICIAL]: () => ({ status: 503 }),
      [ANKR]: (m) => (m === 'eth_sendRawTransaction' ? { result: hash } : { result: '0x2a' }),
      [THIRDWEB]: () => ({ status: 503 }),
    });
    const wallet = devWalletClient(privateKeyToAccount(generatePrivateKey()));
    expect(wallet.transport.type).toBe('fallback');
    expect(await wallet.sendRawTransaction({ serializedTransaction: '0xc0' })).toBe(hash);
    expect(seen).toEqual([`${OFFICIAL} eth_sendRawTransaction`, `${OFFICIAL} eth_sendRawTransaction`, `${ANKR} eth_sendRawTransaction`]);
    seen.length = 0;
    expect(await pub.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(seen).toEqual([`${ANKR} eth_blockNumber`]); // pub skips the cooling primary too
  });
});

describe('observedClock (max-so-far time, station-local)', () => {
  it('converts an instant to the station clock', () => {
    expect(observedClock('2026-10-14T02:30:00.000Z', 480)).toBe('10:30'); // Taipei
    expect(observedClock('2026-10-14T02:30:00.000Z', 540)).toBe('11:30'); // Tokyo
    expect(observedClock('2026-10-13T16:30:00Z', 480)).toBe('00:30'); // UTC is still the previous date
    expect(observedClock('2026-10-14T10:30:00+08:00', 480)).toBe('10:30');
  });
  it('keeps an already-local HH:MM', () => {
    expect(observedClock('12:30', 480)).toBe('12:30');
    expect(observedClock('9:05', 540)).toBe('09:05');
  });
  it('hides anything it cannot place on the station clock', () => {
    for (const v of [null, undefined, '', 'soon', '25:00', '2026-10-14T10:30:00', '2026-10-14']) expect(observedClock(v, 480)).toBeNull();
  });
  it('is labelled as station-local time, so it never reads as the viewer clock ("Book updated" below uses that one)', () => {
    expect(translate('en', 'mk.asOf', { t: '11:30' })).toBe('as of 11:30 local');
    expect(translate('zh', 'mk.asOf', { t: '11:30' })).toBe('截至當地 11:30');
  });
});
