// The RPC pool (src/rpc.ts) and the relayer's broadcast (src/sender.ts), against fake JSON-RPC endpoints served by an
// injected fetch. No network, no keys of value: every account here is generated for the test.
import { describe, expect, it } from 'vitest';
import { createPublicClient, defineChain, keccak256, parseTransaction, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configFrom, type Env } from '../../src/env';
import { MemStore } from '../../src/limits';
import {
  DEFAULT_RPC_URLS,
  EndpointSkipError,
  Pacer,
  chooseRpcUrls,
  classifyRpcError,
  createRpc,
  endpointLabel,
  type RpcOptions,
} from '../../src/rpc';
import { BroadcastError, createSender, nonceFloorKey } from '../../src/sender';
import { scanOnce } from '../../src/scan';
import { scanBackoffMs } from '../../src/relayer-do';

const A = 'https://a.example/rpc';
const B = 'https://b.example/rpc';
const CHAIN_HEX = '0x279f'; // 10143

type Reply = { status?: number; body?: Record<string, unknown>; headers?: Record<string, string> } | 'network-error';
type Handler = (req: { method: string; params: any[] }) => Reply | Promise<Reply>;

const ok = (result: unknown): Reply => ({ body: { result } });
const rpcErr = (code: number, message: string, status = 200, headers?: Record<string, string>): Reply => ({ status, body: { error: { code, message } }, headers });

/** A healthy Monad-like node: chain 10143, head `head`, empty logs. */
const node =
  (head: bigint, extra: Partial<Record<string, Handler>> = {}): Handler =>
  (req) => {
    const h = extra[req.method];
    if (h) return h(req);
    if (req.method === 'eth_chainId') return ok(CHAIN_HEX);
    if (req.method === 'eth_blockNumber') return ok(`0x${head.toString(16)}`);
    if (req.method === 'eth_getLogs') return ok([]);
    return ok('0x');
  };

function fakeNet(handlers: Record<string, Handler>) {
  const calls: { url: string; method: string; params: any[] }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const req = JSON.parse(String(init?.body));
    calls.push({ url, method: req.method, params: req.params });
    const r = await handlers[url](req);
    if (r === 'network-error') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...(r.body ?? {}) }), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  const count = (url: string, method?: string) => calls.filter((c) => c.url === url && (!method || c.method === method)).length;
  return { fetchFn, calls, count };
}

/** Fake clock: sleeps return at once and move time forward, so cooldowns and backoff are deterministic. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    sleeps,
  };
}

function pool(handlers: Record<string, Handler>, over: Partial<RpcOptions> = {}) {
  const net = fakeNet(handlers);
  const clock = fakeClock();
  const rpc = createRpc({ urls: Object.keys(handlers), chainId: 10143, fetchFn: net.fetchFn, now: clock.now, sleep: clock.sleep, ...over });
  const t = rpc.transport({});
  const req = (method: string, params: unknown[] = []) => t.request({ method, params } as never) as Promise<unknown>;
  return { rpc, net, clock, req };
}

describe('RPC endpoints: which, in what order', () => {
  it('defaults to Ankr, thirdweb, official (official last: 15 req/s per client IP, shared Worker egress)', () => {
    expect(DEFAULT_RPC_URLS).toEqual(['https://rpc.ankr.com/monad_testnet', 'https://10143.rpc.thirdweb.com', 'https://testnet-rpc.monad.xyz']);
    expect(chooseRpcUrls({})).toMatchObject({ urls: [...DEFAULT_RPC_URLS], source: 'default', ignored: [] });
  });

  it('parses RPC_URLS in order, drops duplicates and invalid entries (reported by position only)', () => {
    const r = chooseRpcUrls({ RPC_URLS: ` ${B}, ${A},${B},http://evil.example/rpc,not a url,https://user:pw@c.example/x, http://127.0.0.1:8545 ` });
    expect(r.urls).toEqual([B, A, 'http://127.0.0.1:8545']);
    expect(r.ignored).toEqual(['entry 4', 'entry 5', 'entry 6']);
    expect(r.source).toBe('RPC_URLS');
  });

  it('RPC_URL (one endpoint, for anvil forks) wins over RPC_URLS; nothing valid -> the defaults', () => {
    expect(chooseRpcUrls({ RPC_URL: 'http://127.0.0.1:19200', RPC_URLS: A }).urls).toEqual(['http://127.0.0.1:19200']);
    expect(chooseRpcUrls({ RPC_URLS: 'ftp://x, http://example.com' })).toMatchObject({ urls: [...DEFAULT_RPC_URLS], source: 'default', ignored: ['entry 1', 'entry 2'] });
  });

  it('labels only the known public endpoints and loopback by host; anything else by position (a key in a URL never leaks)', () => {
    expect(endpointLabel('https://rpc.ankr.com/monad_testnet', 0)).toBe('rpc.ankr.com');
    expect(endpointLabel('http://127.0.0.1:19200', 2)).toBe('127.0.0.1:19200');
    expect(endpointLabel('https://secret-key.provider.example/v2/abcdef', 1)).toBe('endpoint-2');
  });

  it('wrangler.toml: production uses the RPC_URLS list (no RPC_URL override), every entry valid, scan lag 5 blocks', () => {
    const toml = readFileSync(join(__dirname, '../../wrangler.toml'), 'utf8');
    const vars: Record<string, string> = {};
    for (const m of toml.slice(toml.indexOf('[vars]')).matchAll(/^([A-Z_0-9]+)\s*=\s*"([^"]*)"/gm)) vars[m[1]] = m[2];
    expect(vars.RPC_URL).toBeUndefined();
    const cfg = configFrom(vars as unknown as Env);
    expect(cfg.rpcSource).toBe('RPC_URLS');
    expect(cfg.rpcIgnored).toEqual([]);
    expect(cfg.rpcUrls).toEqual([...DEFAULT_RPC_URLS]);
    expect(cfg.rpcMaxRps).toBeGreaterThan(0);
    expect(cfg.rpcMaxRps).toBeLessThan(15);
    expect(cfg.statsScanLagBlocks).toBe(5n);
    expect(cfg.chainId).toBe(10143);
    // a loopback fork scans to the head (anvil mines only on demand)
    expect(configFrom({ RPC_URL: 'http://127.0.0.1:19200' } as Env).statsScanLagBlocks).toBe(0n);
  });
});

describe('RPC error classification', () => {
  const pick = async (reply: Reply) => {
    const { req } = pool({ [A]: node(1n, { eth_blockNumber: () => reply }) }, { maxAttempts: 1 });
    await req('eth_chainId'); // verify the chain first
    return req('eth_blockNumber').then(
      () => 'resolved',
      (e) => classifyRpcError(e),
    );
  };
  it('HTTP 429 / 403, JSON-RPC limit codes and "requests limited to 15/sec" are rate limits', async () => {
    expect(await pick({ status: 429, body: {} })).toBe('rate-limited');
    expect(await pick({ status: 403, body: {} })).toBe('rate-limited');
    expect(await pick(rpcErr(-32007, 'requests limited to 15/sec'))).toBe('rate-limited');
    expect(await pick(rpcErr(-32603, 'requests limited to 15/sec', 429))).toBe('rate-limited');
    expect(await pick(rpcErr(-32005, 'limit exceeded'))).toBe('rate-limited');
    expect(await pick(rpcErr(-32000, 'slow down', 429))).toBe('rate-limited'); // the status alone decides
  });
  it('5xx and network failures are transient; reverts, bad params and 413 (range too large) are deterministic', async () => {
    expect(await pick({ status: 503, body: {} })).toBe('transient');
    expect(await pick('network-error')).toBe('transient');
    expect(await pick(rpcErr(3, 'execution reverted'))).toBe('deterministic');
    expect(await pick(rpcErr(-32602, 'Invalid params'))).toBe('deterministic');
    expect(await pick(rpcErr(-32614, 'eth_getLogs is limited to a 100 range', 413))).toBe('deterministic');
    expect(await pick(rpcErr(-32000, 'nonce too low'))).toBe('deterministic');
    expect(classifyRpcError(new EndpointSkipError('x', 'busy', 'client-side throttle queue is full'))).toBe('skip');
  });
});

describe('client-side throttle', () => {
  it('lets `burst` requests through, then paces to `rps`; refuses a wait longer than the queue limit', () => {
    const p = new Pacer(4, 2); // 250 ms apart after a burst of 2
    expect([p.reserve(0, 10_000), p.reserve(0, 10_000), p.reserve(0, 10_000), p.reserve(0, 10_000)]).toEqual([0, 0, 250, 500]);
    expect(p.reserve(0, 600)).toBeNull(); // would wait 750 ms
    expect(p.reserve(0, 10_000)).toBe(750); // the refused one reserved nothing
    expect(new Pacer(0).reserve(0, 0)).toBe(0); // 0 = off
  });

  it('a full queue on one endpoint spills to the next instead of waiting', async () => {
    const { req, net, clock } = pool({ [A]: node(10n), [B]: node(10n) }, { maxRps: 2, maxQueueMs: 0 });
    await req('eth_blockNumber'); // A: chain probe + this request use its burst of 2
    await req('eth_blockNumber'); // A would have to wait 500 ms: B serves it now
    expect(net.count(A, 'eth_blockNumber')).toBe(1);
    expect(net.count(B, 'eth_blockNumber')).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });
});

describe('RPC pool: fallback, cooldown, chain id, retries', () => {
  it('a rate-limited endpoint cools down and the next one serves; while cooling it is not contacted', async () => {
    const limited = (): Reply => rpcErr(-32007, 'requests limited to 15/sec', 429, { 'retry-after': '5' });
    const { req, net, rpc, clock } = pool({ [A]: node(10n, { eth_blockNumber: limited }), [B]: node(11n) });
    expect(await req('eth_blockNumber')).toBe('0xb');
    const aCalls = net.count(A);
    for (let i = 0; i < 5; i++) expect(await req('eth_blockNumber')).toBe('0xb');
    expect(net.count(A)).toBe(aCalls); // skipped while cooling
    const st = rpc.status();
    expect(st[0]).toMatchObject({ endpoint: 'endpoint-1', state: 'cooling', rateLimited: 1, lastError: 'rate-limited (HTTP 429)' });
    expect(st[0].coolingForSec).toBe(5); // Retry-After honoured (above the 2 s base)
    expect(st[1]).toMatchObject({ endpoint: 'endpoint-2', state: 'ok', head: '11' });
    clock.advance(6_000);
    await req('eth_blockNumber');
    expect(net.count(A)).toBe(aCalls + 1); // tried again after the cooldown (and limited again: longer cooldown)
    expect(rpc.status()[0].coolingForSec).toBeGreaterThanOrEqual(4);
  });

  it('a burst: requests queued in the throttle skip an endpoint that started cooling, and concurrent 429s are one strike', async () => {
    // real clock here: what matters is the order of events in time
    let gate: () => void = () => undefined;
    const held = new Promise<void>((r) => (gate = r));
    // A answers its burst slowly with 429s (as thirdweb did on 2026-10-09); B is healthy
    const { req, net, rpc } = pool(
      { [A]: node(1n, { eth_blockNumber: async () => (await held, rpcErr(-32000, 'Too Many Requests', 429)) }), [B]: node(2n) },
      { maxRps: 4, maxQueueMs: 5_000, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    );
    await req('eth_chainId'); // verifies A (1 of its 4 burst tokens)
    const all = Promise.all(Array.from({ length: 6 }, () => req('eth_blockNumber')));
    await new Promise((r) => setTimeout(r, 100)); // 3 in flight on A, 3 waiting 250 / 500 / 750 ms in A's queue
    gate();
    expect(await all).toEqual(Array(6).fill('0x2'));
    const a = rpc.status()[0];
    expect(a).toMatchObject({ state: 'cooling', rateLimited: 3 });
    expect(a.coolingForSec).toBeLessThanOrEqual(2); // one strike: the 2 s base, not doubled per concurrent 429
    expect(net.count(A, 'eth_blockNumber')).toBe(3); // the queued three never went out to a cooling A
  });

  it('never uses an endpoint that serves another chain; eth_chainId is answered from the verified cache', async () => {
    const { req, net, rpc } = pool({ [A]: node(5n, { eth_chainId: () => ok('0x1') }), [B]: node(7n) });
    expect(await req('eth_blockNumber')).toBe('0x7');
    expect(await req('eth_blockNumber')).toBe('0x7');
    expect(net.count(A)).toBe(1); // one probe, then never again
    expect(rpc.status()[0]).toMatchObject({ state: 'wrong-chain', lastError: 'chain id 1, expected 10143' });
    const before = net.calls.length;
    for (let i = 0; i < 5; i++) expect(await req('eth_chainId')).toBe(CHAIN_HEX);
    expect(net.calls.length).toBe(before); // no network for eth_chainId once verified
    // a pool where every endpoint is on the wrong chain fails, it never falls back to an unverified answer
    const bad = pool({ [A]: node(5n, { eth_chainId: () => ok('0x1') }) });
    await expect(bad.req('eth_blockNumber')).rejects.toThrow();
  });

  it('a revert is thrown at once: no second endpoint, no cooldown, no retry', async () => {
    const { req, net, rpc } = pool({ [A]: node(1n, { eth_call: () => rpcErr(3, 'execution reverted') }), [B]: node(1n) });
    await expect(req('eth_call', [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, 'latest'])).rejects.toThrow(/execution reverted/);
    expect(net.count(B)).toBe(0);
    expect(net.count(A, 'eth_call')).toBe(1);
    expect(rpc.status()[0].state).toBe('ok');
  });

  it('when every endpoint is rate-limited or down, retries with backoff (waiting for the first cooldown to end)', async () => {
    let n = 0;
    const flaky = (): Reply => (++n <= 2 ? { status: 503, body: {} } : ok('0x2a'));
    const { req, clock } = pool({ [A]: node(1n, { eth_blockNumber: () => rpcErr(-32007, 'requests limited to 15/sec') }), [B]: node(1n, { eth_blockNumber: flaky }) });
    expect(await req('eth_blockNumber')).toBe('0x2a');
    expect(clock.sleeps.length).toBeGreaterThanOrEqual(2);
    expect(clock.sleeps.every((ms) => ms > 0 && ms <= 4_000)).toBe(true);
  });

  it('gives up after maxAttempts and surfaces the error', async () => {
    const { req, clock } = pool({ [A]: node(1n, { eth_blockNumber: () => ({ status: 502, body: {} }) }) }, { maxAttempts: 3 });
    await expect(req('eth_blockNumber')).rejects.toThrow();
    expect(clock.sleeps.length).toBe(2);
  });

  it('eth_getLogs goes only to an endpoint whose head covers toBlock (a lagging node returns truncated logs, no error)', async () => {
    const { req, net } = pool({ [A]: node(100n), [B]: node(120n) });
    await req('eth_blockNumber'); // A at 100
    const logs = await req('eth_getLogs', [{ fromBlock: '0x5a', toBlock: '0x6e' }]); // 90..110
    expect(logs).toEqual([]);
    expect(net.count(A, 'eth_getLogs')).toBe(0); // A re-checked its head (still 100 < 110) and was skipped
    expect(net.count(A, 'eth_blockNumber')).toBe(2);
    expect(net.count(B, 'eth_getLogs')).toBe(1);
    await req('eth_getLogs', [{ fromBlock: '0x50', toBlock: '0x64' }]); // 80..100: A has it
    expect(net.count(A, 'eth_getLogs')).toBe(1);
  });

  it('a broadcast that fails on one endpoint is resent byte for byte to the next (same hash, same nonce)', async () => {
    const raws: string[] = [];
    const take = (status?: number) => (r: { params: any[] }): Reply => {
      raws.push(r.params[0]);
      return status ? { status, body: {} } : ok(keccak256(r.params[0]));
    };
    const { req, net } = pool({ [A]: node(1n, { eth_sendRawTransaction: take(504) }), [B]: node(1n, { eth_sendRawTransaction: take() }) });
    const raw = '0x02f86d82279f80843b9aca0085174876e800825208940000000000000000000000000000000000000001808080c080a0' + '11'.repeat(32) + 'a0' + '22'.repeat(32);
    expect(await req('eth_sendRawTransaction', [raw])).toBe(keccak256(raw as Hex));
    expect(raws).toEqual([raw, raw]);
    expect(net.count(A, 'eth_sendRawTransaction') + net.count(B, 'eth_sendRawTransaction')).toBe(2);
  });
});

// ------------------------------------------------------------------------------------------------ sender
describe('relayer broadcast: one signature per nonce, the hash decides what happened', () => {
  type SendBehaviour = 'ok' | 'already-known' | 'timeout-landed' | 'timeout-lost' | 'nonce-low' | 'insufficient';
  function fakePub(behaviour: SendBehaviour, rpcCount = 7) {
    const known = new Set<Hex>();
    const raws: Hex[] = [];
    let lookups = 0;
    const pub = {
      getChainId: async () => 10143,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 122_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }),
      getTransactionCount: async () => rpcCount,
      sendRawTransaction: async ({ serializedTransaction: raw }: { serializedTransaction: Hex }) => {
        raws.push(raw);
        const h = keccak256(raw);
        if (behaviour === 'ok') return known.add(h), h;
        if (behaviour === 'already-known') throw Object.assign(new Error('x'), { details: 'already known' });
        if (behaviour === 'timeout-landed') throw (known.add(h), Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
        if (behaviour === 'timeout-lost') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        if (behaviour === 'nonce-low') throw Object.assign(new Error('x'), { code: -32000, details: 'nonce too low' });
        throw Object.assign(new Error('x'), { code: -32000, details: 'insufficient funds for gas * price + value' });
      },
      getTransaction: async ({ hash }: { hash: Hex }) => {
        lookups++;
        if (!known.has(hash)) throw new Error('TransactionNotFoundError');
        return { hash };
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: 'success', blockNumber: 1n, transactionHash: hash }),
    };
    return { pub, raws, lookups: () => lookups };
  }
  const key = generatePrivateKey();
  const make = (behaviour: SendBehaviour, rpcCount = 7, store = new MemStore(), k: Hex = key) => {
    const f = fakePub(behaviour, rpcCount);
    const account = privateKeyToAccount(k);
    const sender = createSender({ pub: f.pub as never, wallet: { account } as never, store, chainId: 10143, findPolls: 3, findDelayMs: 1 });
    return { ...f, sender, store };
  };
  const tx = (nonce: number) => ({ to: '0x0000000000000000000000000000000000000001' as const, value: 1n, gas: 21_000n, nonce });

  it('signs a 10143 EIP-1559 tx with the given nonce and returns its hash', async () => {
    const { sender, raws } = make('ok');
    const h = await sender.send(tx(7));
    expect(h).toBe(keccak256(raws[0]));
    const parsed = parseTransaction(raws[0]);
    expect(parsed).toMatchObject({ chainId: 10143, nonce: 7, type: 'eip1559', gas: 21_000n });
  });

  it('"already known" from the RPC, or the tx found by hash after a timeout, is a successful broadcast', async () => {
    expect(await make('already-known').sender.send(tx(7))).toMatch(/^0x[0-9a-f]{64}$/);
    const t = make('timeout-landed');
    expect(await t.sender.send(tx(7))).toBe(keccak256(t.raws[0]));
  });

  it('nonce too low and not found: stale-nonce (nothing of ours went out); a provider rejection: rejected after one lookup', async () => {
    const s = make('nonce-low');
    await expect(s.sender.send(tx(7))).rejects.toMatchObject({ kind: 'stale-nonce' });
    const r = make('insufficient');
    await expect(r.sender.send(tx(7))).rejects.toMatchObject({ kind: 'rejected' });
    expect(r.lookups()).toBe(1);
  });

  it('a timeout with the tx nowhere to be found is uncertain, and carries the hash so the caller never resends it', async () => {
    const u = make('timeout-lost');
    const e = await u.sender.send(tx(7)).catch((x) => x);
    expect(e).toBeInstanceOf(BroadcastError);
    expect(e).toMatchObject({ kind: 'uncertain', hash: keccak256(u.raws[0]) });
    expect(u.raws.length).toBe(1); // signed and sent once
    expect(u.lookups()).toBe(3);
  });

  it('next nonce = max(RPC count, floor of our own mined txs); only a receipt raises the floor', async () => {
    const store = new MemStore();
    const s = make('ok', 7, store);
    expect(await s.sender.nextNonce()).toBe(7);
    const h = await s.sender.send(tx(7));
    const fk = nonceFloorKey(privateKeyToAccount(key).address);
    expect(await store.get(fk)).toBeUndefined(); // broadcast alone does not move it
    await s.sender.wait(h);
    expect(await store.get(fk)).toBe(8);
    // the next job reads a lagging endpoint that still says 7: the floor wins
    const lagging = make('ok', 7, store);
    expect(await lagging.sender.nextNonce()).toBe(8);
    // an RPC ahead of the floor (another sender used the key) wins too
    expect(await make('ok', 12, store).sender.nextNonce()).toBe(12);
    // a different relayer key (rotated RELAYER_KEY) never inherits the old key's floor
    expect(await make('ok', 2, store, generatePrivateKey()).sender.nextNonce()).toBe(2);
  });
});

// ------------------------------------------------------------------------------------------------ scan
describe('stats scan: 100-block pages, a lag behind the head, partial progress on a rate limit', () => {
  const resolver = '0x00000000000000000000000000000000000005e5' as const;
  function scanPub(head: bigint, failFrom: bigint | null) {
    const windows: [bigint, bigint][] = [];
    const pub = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (failFrom !== null && fromBlock >= failFrom) throw Object.assign(new Error('x'), { code: -32007, details: 'requests limited to 15/sec' });
        windows.push([fromBlock, toBlock]);
        return [];
      },
    };
    return { pub, windows };
  }
  const opts = (pub: unknown, store: MemStore, lag = 5n) => ({
    pub: pub as never,
    store,
    resolver,
    zap: null,
    multicall: resolver,
    startBlock: 1000n,
    maxWindows: 20,
    realStations: [],
    lagBlocks: lag,
  });

  it('reads at most 100 blocks per call and stops lagBlocks short of the head', async () => {
    const store = new MemStore();
    const { pub, windows } = scanPub(1404n, null);
    const r = await scanOnce(opts(pub, store));
    expect(r.stopped).toBeNull();
    expect(windows.every(([f, t]) => t - f + 1n <= 100n)).toBe(true);
    expect(windows.at(-1)![1]).toBe(1399n); // head 1404 - lag 5
    expect(r.cursor).toBe(1400n);
    expect(await store.get('scan:cursor')).toBe('1400');
  });

  it('a rate-limited window stops the run, keeps the completed windows and resumes exactly there', async () => {
    const store = new MemStore();
    const first = scanPub(2000n, 1200n);
    const r1 = await scanOnce(opts(first.pub, store));
    expect(r1.stopped).toMatchObject({ kind: 'rate-limited', at: 'blocks 1200..1299' });
    expect(r1.cursor).toBe(1200n);
    expect(await store.get('scan:cursor')).toBe('1200');
    const second = scanPub(2000n, null);
    const r2 = await scanOnce(opts(second.pub, store));
    expect(second.windows[0]).toEqual([1200n, 1299n]); // nothing skipped, nothing scanned twice
    expect(r2.stopped).toBeNull();
  });

  it("a rate limit inside a backfill job keeps that job's progress and every later job", async () => {
    const store = new MemStore();
    const m1 = '0x0000000000000000000000000000000000000111';
    const m2 = '0x0000000000000000000000000000000000000222';
    await store.put('scan:cursor', '1500');
    await store.put('scan:backfill', [
      { market: m1, from: '1000', to: '1399' },
      { market: m2, from: '1100', to: '1199' },
    ]);
    const { pub } = scanPub(1600n, 1100n);
    const r = await scanOnce(opts(pub, store));
    expect(r.stopped?.kind).toBe('rate-limited');
    expect(await store.get('scan:backfill')).toEqual([
      { market: m1, from: '1100', to: '1399' },
      { market: m2, from: '1100', to: '1199' },
    ]);
    expect(await store.get('scan:cursor')).toBe('1500'); // the live cursor did not move past anything unscanned
  });

  it('the Durable Object then skips cron ticks: about 2, 4, then at most 8 minutes', () => {
    expect([1, 2, 3, 4, 9].map(scanBackoffMs)).toEqual([115_000, 235_000, 475_000, 475_000, 475_000]);
  });
});

// ------------------------------------------------------------------------------------------------ end to end in-process
describe('pool + sender together: a broadcast that times out on one endpoint and lands through another', () => {
  it('one transaction on chain, and the floor follows its receipt', async () => {
    const chainTxs = new Map<string, string>(); // hash -> raw
    const accept = (r: { params: any[] }): Reply => {
      const h = keccak256(r.params[0]);
      if (chainTxs.has(h)) return rpcErr(-32000, 'already known');
      chainTxs.set(h, r.params[0]);
      return ok(h);
    };
    const acceptButTimeout = (r: { params: any[] }): Reply => (accept(r), { status: 504, body: {} }); // it went out, the answer did not
    const base = (extra: Partial<Record<string, Handler>>) =>
      node(50n, {
        eth_getTransactionCount: () => ok('0x3'),
        eth_getBlockByNumber: () => ok({ number: '0x32', baseFeePerGas: '0x174876e800', hash: `0x${'ab'.repeat(32)}`, timestamp: '0x1', transactions: [] }),
        eth_maxPriorityFeePerGas: () => ok('0x77359400'),
        eth_getTransactionByHash: (r) => (chainTxs.has(r.params[0]) ? ok({ hash: r.params[0], nonce: '0x3', blockHash: null, blockNumber: null, from: `0x${'00'.repeat(20)}`, gas: '0x5208', input: '0x', value: '0x1', type: '0x2', v: '0x0', r: '0x1', s: '0x1', to: null, transactionIndex: null }) : ok(null)),
        eth_getTransactionReceipt: (r) => (chainTxs.has(r.params[0]) ? ok({ transactionHash: r.params[0], blockNumber: '0x32', blockHash: `0x${'cd'.repeat(32)}`, status: '0x1', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`, transactionIndex: '0x0', from: `0x${'00'.repeat(20)}`, to: null, contractAddress: null, type: '0x2' }) : ok(null)),
        ...extra,
      });
    const net = fakeNet({ [A]: base({ eth_sendRawTransaction: acceptButTimeout }), [B]: base({ eth_sendRawTransaction: accept }) });
    const clock = fakeClock();
    const rpc = createRpc({ urls: [A, B], chainId: 10143, fetchFn: net.fetchFn, now: clock.now, sleep: clock.sleep });
    const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [A, B] } } });
    const pub = createPublicClient({ chain, transport: rpc.transport, pollingInterval: 5 });
    const store = new MemStore();
    const account = privateKeyToAccount(generatePrivateKey());
    const sender = createSender({ pub: pub as never, wallet: { account } as never, store, chainId: 10143, findPolls: 2, findDelayMs: 1, receiptPollMs: 5 });
    const nonce = await sender.nextNonce();
    expect(nonce).toBe(3);
    const hash = await sender.send({ to: '0x0000000000000000000000000000000000000001', value: 1n, gas: 21_000n, nonce });
    expect(chainTxs.size).toBe(1);
    expect(chainTxs.has(hash)).toBe(true);
    await sender.wait(hash);
    expect(await store.get(nonceFloorKey(account.address))).toBe(4);
    expect(await sender.nextNonce()).toBe(4); // the RPC still says 3; our mined floor says 4
  });
});
