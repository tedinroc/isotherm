// End-to-end test of the Worker (wrangler dev / Miniflare: real Durable Object + KV) against an ANVIL FORK of the
// live Monad testnet, with the real v1 contracts, AUSD + faucet, Kuru router and the CRE MockKeystoneForwarder.
// Nothing touches the live chain: anvil impersonation stands in for the owner/maker, and the relayer is a throwaway
// key generated here. Ports: anvil 19200, wrangler dev 8782, inspector 8783 by default; override with
// ISO_ANVIL_PORT / ISO_API_PORT / ISO_INSPECTOR_PORT so parallel workstreams do not collide.
// The Worker gets THREE RPC endpoints (RPC_URLS), as in production: first a plain anvil on another chain id (must be
// refused by the chain-id check), then a port nobody listens on (network errors -> cooldown), then the fork. Every
// call below therefore exercises the fallback transport, the chain-id check and the cooldown in workerd.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  maxUint256,
  parseAbi,
  parseEther,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { DEPLOYMENTS as D } from '../../src/deployments';
import { decodeResult, decodeSeries } from '../../src/abi';
import buildJson from '../../src/generated/build.json';

const ANVIL_PORT = Number(process.env.ISO_ANVIL_PORT ?? 19200);
const WRONG_CHAIN_PORT = Number(process.env.ISO_WRONG_CHAIN_PORT ?? ANVIL_PORT + 1);
const API_PORT = Number(process.env.ISO_API_PORT ?? 8782);
const INSPECTOR_PORT = Number(process.env.ISO_INSPECTOR_PORT ?? 8783);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const SNAP = 'test-snapshot-token';
const ADMIN = 'test-admin-token';
const ANVIL = `${process.env.HOME}/.foundry/bin/anvil`;

const chain = defineChain({ id: 10143, name: 'fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const transport = http(RPC, { timeout: 120_000, retryCount: 2 });
const pub = createPublicClient({ chain, transport });
const testc = createTestClient({ chain, transport, mode: 'anvil' });

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const ownable = parseAbi(['function owner() view returns (address)']);
const vaultAbi = parseAbi([
  'function createLadder(bytes4 station, uint32 date, int16[] strikesC, uint64 closeTime) returns (bytes32[])',
  'function ladderSeries(bytes4 station, uint32 date) view returns (bytes32[])',
  'function getSeries(bytes32) view returns (bytes32)',
  'function mintSet(bytes32 seriesId, uint256 amount)',
]);
const resolverAbi = parseAbi([
  'function dayEnd(bytes4, uint32) view returns (uint256)',
  'function setAttester(address)',
  'function resultOf(bytes4,uint32) view returns (bytes32)',
]);
const routerAbi = parseAbi([
  'function deployProxy(uint8, address, address, uint96, uint32, uint32, uint96, uint96, uint256, uint256, uint96) returns (address)',
  'event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)',
]);
const zapAbi = parseAbi([
  'function canonicalMarket(bytes32) view returns (address)',
  'function setCanonicalMarket(bytes32, address)',
  'function buyYes(bytes32 seriesId, address market, uint256 ausdIn, uint256 minYesOut, address to) returns (uint256, uint256)',
]);
const marginAbi = parseAbi(['function deposit(address _user, address _token, uint256 _amount) payable']);
const bookAbi = parseAbi(['function batchUpdate(uint32[], uint96[], uint32[], uint96[], uint40[], bool)']);
const forwarderAbi = parseAbi([
  'function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)',
  'event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)',
]);

const procs: ChildProcess[] = [];
let stateDir = '';
let relayer: PrivateKeyAccount;
let relayerKey: Hex;
const RCSS = stringToHex('RCSS', { size: 4 });
let date = 0;
let seriesId: Hex;
let series: ReturnType<typeof decodeSeries>;
let market: Address;

/** A loopback port with nothing listening on it (bound, then released). */
async function deadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}
let DEAD_PORT = 0;

async function waitFor(url: string, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function rpcUp() {
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('anvil did not start');
}

async function as(from: Address, to: Address, abi: any, functionName: string, args: readonly unknown[]) {
  await testc.impersonateAccount({ address: from });
  const w = createWalletClient({ chain, transport, account: from });
  const hash = await w.writeContract({ address: to, abi, functionName, args, chain, account: from } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  await testc.stopImpersonatingAccount({ address: from });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
}

async function authorization(user: PrivateKeyAccount, amount: bigint) {
  const salt = keccak256(stringToHex(`salt-${Date.now()}-${Math.random()}`));
  const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }], [seriesId, amount, salt]));
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 900);
  const signature = await user.signTypedData({
    domain: { name: 'Agora Dollar', version: '1', chainId: 10143, verifyingContract: D.ausd },
    types: {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: user.address, to: D.vault, value: amount, validAfter: 0n, validBefore, nonce },
  });
  return { mode: 'authorization', chainId: 10143, seriesId, amount: amount.toString(), holder: user.address, validAfter: '0', validBefore: validBefore.toString(), salt, signature };
}

const api = (path: string, init?: RequestInit) => fetch(`${API}${path}`, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const tick = () => post('/api/admin/tick', {}, { authorization: `Bearer ${ADMIN}` });
const warp = async (s: number) => {
  await testc.increaseTime({ seconds: s });
  await testc.mine({ blocks: 1 });
};

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'isotherm-api-test-'));
  const anvil = spawn(ANVIL, ['--fork-url', 'https://testnet-rpc.monad.xyz', '--port', String(ANVIL_PORT), '--retries', '8', '--compute-units-per-second', '20', '--silent'], {
    stdio: 'ignore',
  });
  procs.push(anvil);
  // the wrong-chain endpoint: a fresh anvil (chain id 31337), no fork
  procs.push(spawn(ANVIL, ['--port', String(WRONG_CHAIN_PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' }));
  DEAD_PORT = await deadPort();
  await rpcUp();
  relayerKey = generatePrivateKey(); // throwaway, fork-only
  relayer = privateKeyToAccount(relayerKey);
  await testc.setBalance({ address: relayer.address, value: parseEther('20') });
  const wr = spawn(
    'npx',
    [
      'wrangler', 'dev', '--port', String(API_PORT), '--inspector-port', String(INSPECTOR_PORT), '--ip', '127.0.0.1', '--persist-to', stateDir,
      // production order: endpoints tried in turn; only the last one is a usable chain 10143
      '--var', `RPC_URLS:http://127.0.0.1:${WRONG_CHAIN_PORT},http://127.0.0.1:${DEAD_PORT},${RPC}`,
      '--var', `RELAYER_KEY:${relayerKey}`,
      '--var', `SNAPSHOT_TOKEN:${SNAP}`,
      '--var', `ADMIN_TOKEN:${ADMIN}`,
      // mechanics, not the live budget: 3 drips per network and room for every drip below; relays: 3 per network,
      // 2 per address, so both limits are hit for real below
      '--var', 'DRIP_PER_IP_PER_DAY:3',
      '--var', 'DRIP_DAILY_CAP:10',
      '--var', 'RELAY_PER_IP_PER_DAY:3',
      '--var', 'RELAY_PER_ADDRESS_PER_DAY:2',
      '--var', 'RELAY_DAILY_CAP:10',
      '--var', `STATS_START_BLOCK:${(await pub.getBlockNumber()) - 5n}`,
    ],
    { cwd: join(__dirname, '../..'), stdio: 'ignore' },
  );
  procs.push(wr);
  await waitFor(`${API}/api`, 90_000);
}, 180_000);

afterAll(async () => {
  for (const p of procs) p.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe('isotherm-api on a Monad testnet fork', () => {
  it('serves health with the relayer and v1 relay modes; CORS only for allowed origins', async () => {
    const h = await (await api('/api/health')).json<any>();
    expect(h.relayer).toBe(relayer.address);
    expect(h.vault).toBe(D.vault);
    expect(h.relayModes).toEqual(['authorization']); // permit relays are off for the v1 vault (security review v1)
    expect(h.relayMinAusd).toBe('1');
    expect(h.limits).toMatchObject({ reserveMon: '0.1', relayPerIpPerDay: 3, relayPerAddressPerDay: 2, dripsToday: 0, relaysToday: 0 });
    // the RPC pool: the wrong-chain endpoint is refused for good, the dead one failed and cools down, the fork serves
    expect(h.rpc.source).toBe('RPC_URLS');
    expect(h.rpc.endpoints.map((e: { endpoint: string }) => e.endpoint)).toEqual([`127.0.0.1:${WRONG_CHAIN_PORT}`, `127.0.0.1:${DEAD_PORT}`, `127.0.0.1:${ANVIL_PORT}`]);
    expect(h.rpc.endpoints[0]).toMatchObject({ state: 'wrong-chain', lastError: 'chain id 31337, expected 10143' });
    expect(h.rpc.endpoints[1].failed).toBeGreaterThanOrEqual(1);
    expect(h.rpc.endpoints[1].lastError).toBe('network error');
    expect(h.rpc.endpoints[2]).toMatchObject({ state: 'ok', rateLimited: 0, failed: 0 });
    expect(h.head).not.toBeNull();
    // build id baked in by scripts/build-info.mjs; wrangler dev has no upload time, so deployedAt stays null
    expect(h.version).toMatchObject({ app: '1.0.0', build: buildJson.build, builtAt: buildJson.builtAt, deployedAt: null });
    expect((await (await api('/api')).json<any>()).version.build).toBe(buildJson.build);
    const ok = await api('/api/health', { method: 'OPTIONS', headers: { origin: 'https://isotherm.pages.dev', 'access-control-request-method': 'POST' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://isotherm.pages.dev');
    const bad = await api('/api/health', { headers: { origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('admin endpoints need the bearer token; the cron tick refills the AUSD float from the faucet', async () => {
    expect((await post('/api/admin/tick', {})).status).toBe(401);
    expect((await post('/api/admin/tick', {}, { authorization: 'Bearer nope' })).status).toBe(401);
    await warp(120); // the faucet's global 60 s cooldown on the fork
    const r = await (await tick()).json<any>();
    expect(r.refill.ok).toBe(true);
    const float = await pub.readContract({ address: D.ausd, abi: erc20, functionName: 'balanceOf', args: [relayer.address] });
    expect(float).toBeGreaterThanOrEqual(10_000_000_000n);
  });

  it('drips MON + AUSD once per address, never to contracts, and enforces the per-IP limit', async () => {
    expect((await post('/api/drip', { address: 'nope' })).status).toBe(400);
    const c = await post('/api/drip', { address: D.vault });
    expect(c.status).toBe(400);
    expect((await c.json<any>()).error).toMatch(/contract/);

    const users = [0, 1, 2, 3].map(() => privateKeyToAccount(generatePrivateKey()).address);
    const r1 = await post('/api/drip', { address: users[0] });
    const b1 = await r1.json<any>();
    expect(r1.status).toBe(200);
    expect(b1.ausdSource).toBe('relayer-float');
    expect(await pub.getBalance({ address: users[0] })).toBe(parseEther('0.15'));
    expect(await pub.readContract({ address: D.ausd, abi: erc20, functionName: 'balanceOf', args: [users[0]] })).toBe(1_000_000_000n);
    const again = await post('/api/drip', { address: users[0] });
    expect(again.status).toBe(429);
    expect((await post('/api/drip', { address: users[1] })).status).toBe(200);
    expect((await post('/api/drip', { address: users[2] })).status).toBe(200);
    const ipCap = await post('/api/drip', { address: users[3] });
    expect(ipCap.status).toBe(429);
    expect((await ipCap.json<any>()).error).toMatch(/daily drip limit/);
  });

  it('accepts a maker snapshot only with the bearer token and serves it normalised', async () => {
    expect((await post('/api/snapshot', { ladders: [] })).status).toBe(401);
    expect((await post('/api/snapshot', { ladders: 'x' }, { authorization: `Bearer ${SNAP}` })).status).toBe(400);
    expect((await post('/api/snapshot', { ladders: [] }, { authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('relays a signed EIP-3009 mint for a user with no MON; refuses permit mode, dust, tampering and over-limit requests', async () => {
    // open a ladder on the fork (owner impersonated), far enough out that the live maker has not used it
    const now = Number((await pub.getBlock()).timestamp);
    const d = new Date((now + 8 * 3600 + 3 * 86400) * 1000);
    date = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    const owner = (await pub.readContract({ address: D.vault, abi: ownable, functionName: 'owner' })) as Address;
    await testc.setBalance({ address: owner, value: parseEther('10') });
    let ids = (await pub.readContract({ address: D.vault, abi: vaultAbi, functionName: 'ladderSeries', args: [RCSS, date] })) as Hex[];
    if (!ids.length) {
      const end = Number(await pub.readContract({ address: D.resolver, abi: resolverAbi, functionName: 'dayEnd', args: [RCSS, date] }));
      await as(owner, D.vault, vaultAbi, 'createLadder', [RCSS, date, [41], BigInt(end - 3600)]);
      ids = (await pub.readContract({ address: D.vault, abi: vaultAbi, functionName: 'ladderSeries', args: [RCSS, date] })) as Hex[];
    }
    seriesId = ids[0];
    series = decodeSeries((await pub.call({ to: D.vault, data: encodeFunctionData({ abi: vaultAbi, functionName: 'getSeries', args: [seriesId] }) })).data!);

    const user = privateKeyToAccount(generatePrivateKey());
    await warp(5);
    // give the user AUSD only (no MON at all), straight from the relayer's float
    await as(relayer.address, D.ausd, parseAbi(['function transfer(address,uint256) returns (bool)']), 'transfer', [user.address, 50_000_000n]);
    expect(await pub.getBalance({ address: user.address })).toBe(0n);

    const amount = 5_000_000n;
    const body = await authorization(user, amount);
    const tampered = await post('/api/relay/mint', { ...body, amount: '6000000' });
    expect(tampered.status).toBe(400);
    expect((await tampered.json<any>()).error).toMatch(/signature/);
    // a 1-unit (0.000001 AUSD) mint is refused before any RPC work (it would cost the relayer ~0.03 MON)
    const dust = await post('/api/relay/mint', await authorization(user, 1n));
    expect(dust.status).toBe(400);
    expect((await dust.json<any>()).error).toMatch(/between 1 and 500 AUSD/);
    const ok = await post('/api/relay/mint', body);
    const okBody = await ok.json<any>();
    expect(ok.status, JSON.stringify(okBody)).toBe(200);
    console.log(`[fork] relayed mintSetWithAuthorization: estimate ${okBody.estimate}, gas limit ${okBody.gasLimit}, gas used ${okBody.gasUsed}`);
    expect(await pub.readContract({ address: series!.yes, abi: erc20, functionName: 'balanceOf', args: [user.address] })).toBe(amount);
    expect(await pub.readContract({ address: series!.no, abi: erc20, functionName: 'balanceOf', args: [user.address] })).toBe(amount);
    expect(await pub.getBalance({ address: user.address })).toBe(0n); // the user paid no gas

    const replay = await post('/api/relay/mint', body);
    expect(replay.status).toBe(400);
    expect((await replay.json<any>()).error).toMatch(/already used/);
    // a second mint for the same holder is fine; the third hits the per-address cap (2) before any RPC read
    expect((await post('/api/relay/mint', await authorization(user, 2_000_000n))).status).toBe(200);
    const addrCap = await post('/api/relay/mint', await authorization(user, 2_000_000n));
    expect(addrCap.status).toBe(429);
    expect((await addrCap.json<any>()).error).toMatch(/this address/);
    // EIP-2612 permit path: disabled for the v1 vault (a front-runner can redirect a permit to another series)
    const pnonce = (await pub.readContract({ address: D.ausd, abi: parseAbi(['function nonces(address) view returns (uint256)']), functionName: 'nonces', args: [user.address] })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
    const psig = await user.signTypedData({
      domain: { name: 'Agora Dollar', version: '1', chainId: 10143, verifyingContract: D.ausd },
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Permit',
      message: { owner: user.address, spender: D.vault, value: 2_000_000n, nonce: pnonce, deadline },
    });
    const pr = await post('/api/relay/mint', { mode: 'permit', chainId: 10143, seriesId, amount: '2000000', holder: user.address, deadline: deadline.toString(), signature: psig });
    expect(pr.status).toBe(400);
    expect((await pr.json<any>()).error).toMatch(/permit-mode relays are disabled/);
    // caps
    const big = await post('/api/relay/mint', { ...body, amount: '600000000' });
    expect(big.status).toBe(400);

    // per-network limit (3 on this fork): a second holder on the same network relays once more, a third is refused
    const second = privateKeyToAccount(generatePrivateKey());
    const third = privateKeyToAccount(generatePrivateKey());
    for (const u of [second, third]) await as(relayer.address, D.ausd, parseAbi(['function transfer(address,uint256) returns (bool)']), 'transfer', [u.address, 10_000_000n]);
    const r2 = await post('/api/relay/mint', await authorization(second, 3_000_000n));
    expect(r2.status, await r2.clone().text()).toBe(200);
    const r3 = await post('/api/relay/mint', await authorization(third, 3_000_000n));
    expect(r3.status).toBe(429);
    const r3b = await r3.json<any>();
    expect(r3b.error).toMatch(/this network/);
    expect(r3b.retryAfterSec).toBeGreaterThan(0);
    expect(await pub.readContract({ address: series!.yes, abi: erc20, functionName: 'balanceOf', args: [third.address] })).toBe(0n);
    const h = await (await api('/api/health')).json<any>();
    expect(h.relayedTotal).toBe(3);
    expect(h.limits.relaysToday).toBe(3);

    // a flood of junk POSTs from one network: POST_LIMIT_PER_MIN (30) in the Durable Object answers 429
    const codes: number[] = [];
    for (let i = 0; i < 35; i++) codes.push((await post('/api/relay/mint', {})).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes.every((c) => c === 400 || c === 429)).toBe(true);
    const flooded = await post('/api/drip', { address: privateKeyToAccount(generatePrivateKey()).address });
    expect(flooded.status).toBe(429);
    expect((await flooded.json<any>()).error).toMatch(/too many requests/);
  });

  it('counts a non-maker Kuru fill and a CRE settlement in /api/stats and /api/settlements', async () => {
    const maker = getAddress('0xd572638F07829D1c3636400FB73CF34Ca6c7448a');
    const owner = (await pub.readContract({ address: D.vault, abi: ownable, functionName: 'owner' })) as Address;
    await testc.setBalance({ address: maker, value: parseEther('10') });
    await as(relayer.address, D.ausd, parseAbi(['function transfer(address,uint256) returns (bool)']), 'transfer', [maker, 200_000_000n]);
    let m = (await pub.readContract({ address: D.zap, abi: zapAbi, functionName: 'canonicalMarket', args: [seriesId] })) as Address;
    if (/^0x0{40}$/i.test(m)) {
      const r = await as(maker, D.kuruRouter, routerAbi, 'deployProxy', [0, series!.yes, D.ausd, 1_000_000n, 10_000, 10, 1_000_000n, 1_000_000_000_000n, 10n, 0n, 100n]);
      for (const l of r.logs) {
        try {
          const ev = decodeEventLog({ abi: routerAbi, data: l.data, topics: l.topics });
          if (ev.eventName === 'MarketRegistered') m = getAddress((ev.args as { market: Address }).market);
        } catch {
          /* other */
        }
      }
      await as(owner, D.zap, zapAbi, 'setCanonicalMarket', [seriesId, m]);
    }
    market = m;
    await as(maker, D.ausd, erc20, 'approve', [D.vault, maxUint256]);
    await as(maker, D.vault, vaultAbi, 'mintSet', [seriesId, 100_000_000n]);
    await as(maker, series!.yes, erc20, 'approve', [D.marginAccount, maxUint256]);
    await as(maker, D.marginAccount, marginAbi, 'deposit', [maker, series!.yes, 100_000_000n]);
    await as(maker, market, bookAbi, 'batchUpdate', [[], [], [500], [100_000_000n], [], false]); // ask 0.05

    // the snapshot deliberately omits the market: the scanner must discover it from the Zap's CanonicalMarketSet event
    const snap = { ladders: [{ station: 'RCSS', date, series: [{ strike: 41, seriesId, fair: 0.03, pm: 0.02, guard: 0.01 }] }] };
    const sr = await post('/api/snapshot', snap, { authorization: `Bearer ${SNAP}` });
    expect(sr.status).toBe(200);
    const got = await (await api('/api/snapshot')).json<any>();
    expect(got.ladders[0].strikes[0]).toMatchObject({ k: 41, pmImplied: 0.02, model: 0.01 });

    // an outside user buys YES through the Zap
    const taker = privateKeyToAccount(generatePrivateKey());
    await testc.setBalance({ address: taker.address, value: parseEther('1') });
    await as(relayer.address, D.ausd, parseAbi(['function transfer(address,uint256) returns (bool)']), 'transfer', [taker.address, 20_000_000n]);
    const tw = createWalletClient({ chain, transport, account: taker });
    await pub.waitForTransactionReceipt({ hash: await tw.writeContract({ address: D.ausd, abi: erc20, functionName: 'approve', args: [D.zap, maxUint256], chain }) });
    const buy = await tw.writeContract({ address: D.zap, abi: zapAbi, functionName: 'buyYes', args: [seriesId, market, 1_000_000n, 1n, taker.address], chain });
    expect((await pub.waitForTransactionReceipt({ hash: buy })).status).toBe('success');

    // settle the ladder through the real MockKeystoneForwarder with an attestation from a fork-only attester
    const end = Number(await pub.readContract({ address: D.resolver, abi: resolverAbi, functionName: 'dayEnd', args: [RCSS, date] }));
    await testc.setNextBlockTimestamp({ timestamp: BigInt(end + 60) });
    await testc.mine({ blocks: 1 });
    const att = privateKeyToAccount(generatePrivateKey());
    const rOwner = (await pub.readContract({ address: D.resolver, abi: ownable, functionName: 'owner' })) as Address;
    await testc.setBalance({ address: rOwner, value: parseEther('10') });
    await as(rOwner, D.resolver, resolverAbi, 'setAttester', [att.address]);
    const sourcesHash = keccak256(stringToHex('IEM:31:48|AWC:31:48'));
    const validUntil = BigInt(end + 3600);
    const sig = await att.signTypedData({
      domain: { name: 'Isotherm Resolver', version: '1', chainId: 10143, verifyingContract: D.resolver },
      types: { Settlement: [{ name: 'station', type: 'bytes4' }, { name: 'date', type: 'uint32' }, { name: 'tmaxC', type: 'int16' }, { name: 'isVoid', type: 'bool' }, { name: 'sourcesHash', type: 'bytes32' }, { name: 'validUntil', type: 'uint64' }] },
      primaryType: 'Settlement',
      message: { station: RCSS, date, tmaxC: 31, isVoid: false, sourcesHash, validUntil },
    });
    const payload = encodeAbiParameters(
      [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'bool' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes' }],
      [RCSS, date, 31, false, sourcesHash, validUntil, sig],
    );
    const raw = concat(['0x01', keccak256('0x1234'), toHex(100, { size: 4 }), toHex(1, { size: 4 }), toHex(1, { size: 4 }), `0x${'11'.repeat(32)}`, stringToHex('7721568293', { size: 10 }), '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x0001', payload]);
    const rep = await tw.writeContract({ address: D.mockForwarder, abi: forwarderAbi, functionName: 'report', args: [D.resolver, raw, toHex(new Uint8Array(96)), [toHex(new Uint8Array(65))]], gas: 400_000n, chain });
    await pub.waitForTransactionReceipt({ hash: rep });
    const res = decodeResult((await pub.call({ to: D.resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: 'resultOf', args: [RCSS, date] }) })).data!);
    expect(res?.status).toBe(1);

    const t = await (await tick()).json<any>();
    expect(t.scan.windows).toBeGreaterThan(0);
    const stats = await (await api("/api/stats")).json<any>();
    expect(stats.nonMakerFills).toBeGreaterThanOrEqual(1);
    expect(stats.nonMakerWallets).toBeGreaterThanOrEqual(1);
    expect(stats.recentTrades.find((x: { origin: string }) => x.origin === taker.address)?.kind).toBe('external');
    // classified when published, from the Worker's current lists; every fill lands in exactly one class
    expect(stats.classification).toMatchObject({ appliedAt: 'publish', v1Migration: null });
    expect(stats.classification.teamAddresses).toBeGreaterThanOrEqual(6);
    expect(stats.fills).toBe(stats.nonMakerFills + stats.teamFills + stats.makerTakerFills);
    expect(stats.settledCityDays).toBeGreaterThanOrEqual(1);
    expect(stats.drips).toBeGreaterThanOrEqual(3);
    expect(stats.relayedMints).toBeGreaterThanOrEqual(2);
    const st = await (await api('/api/settlements')).json<any>();
    const row = st.settlements.find((x: { station: string; date: number }) => x.station === 'RCSS' && x.date === date);
    expect(row).toMatchObject({ status: 1, tmaxC: 31, tx: rep });
    expect(row.finalAt).toBeGreaterThan(end);
    // maker-reported stats are kept separate and need the token
    expect((await post('/api/stats', { fills: 3 })).status).toBe(401);
    expect((await post('/api/stats', { makerFills: 3 }, { authorization: `Bearer ${SNAP}` })).status).toBe(200);
    expect((await (await api('/api/stats')).json<any>()).maker.makerFills).toBe(3);
  });
});
