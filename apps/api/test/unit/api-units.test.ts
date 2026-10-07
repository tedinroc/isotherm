import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  padHex,
  stringToHex,
  toFunctionSelector,
  type Hex,
  type Log,
} from 'viem';
import { LADDER_RESOLVED_EVENT, SELECTORS, TRADE_EVENT, decodeResult, decodeSeries, vaultV1Abi } from '../../src/abi';
import { normalizeDeployments } from '../../src/deployments';
import { MemStore, checkDrip, checkRelay, recordDrip, recordRelay, secondsToUtcMidnight } from '../../src/limits';
import { authorizationNonce, bytecodeHasSelector } from '../../src/relayer';
import { applyLogs, discoveredMarkets, emptyCounters, publicStats, type ScanBatch } from '../../src/scan';
import { CANONICAL_MARKET_SET_EVENT } from '../../src/abi';
import { marketsOf, normalizeSnapshot } from '../../src/snapshot';
import { HttpError, originAllowed, safeEqual } from '../../src/util';
import { versionInfo } from '../../src/version';
import buildJson from '../../src/generated/build.json';
import bundle from '../../src/generated/abi-bundle.json';
import deployed from '../../src/generated/deployments.json';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

describe('CORS origin patterns', () => {
  const pats = ['https://isotherm.pages.dev', 'https://*.isotherm.pages.dev', 'http://localhost:*'];
  it('allows the Pages origin, preview subdomains and localhost on any port', () => {
    expect(originAllowed('https://isotherm.pages.dev', pats)).toBe(true);
    expect(originAllowed('https://abc123.isotherm.pages.dev', pats)).toBe(true);
    expect(originAllowed('http://localhost:5173', pats)).toBe(true);
  });
  it('rejects look-alikes, other schemes and missing origins', () => {
    expect(originAllowed('https://isotherm.pages.dev.evil.com', pats)).toBe(false);
    expect(originAllowed('https://evilisotherm.pages.dev', pats)).toBe(false);
    expect(originAllowed('http://isotherm.pages.dev', pats)).toBe(false);
    expect(originAllowed('https://localhost:5173', pats)).toBe(false);
    expect(originAllowed(null, pats)).toBe(false);
    expect(originAllowed('not a url', pats)).toBe(false);
  });
});

describe('bearer compare', () => {
  it('is exact', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abcd')).toBe(false);
    expect(await safeEqual('', 'x')).toBe(false);
  });
});

describe('drip rate limits', () => {
  const lim = { dailyCap: 3, perIpPerDay: 2, addressCooldownMs: 24 * 3600_000 };
  it('one drip per address per cooldown, N per IP per day, global daily cap', async () => {
    const s = new MemStore();
    const t = Date.UTC(2026, 9, 7, 5);
    expect((await checkDrip(s, lim, A(1), 'ip1', t)).ok).toBe(true);
    await recordDrip(s, A(1), 'ip1', { at: t, monTx: '0x1' }, true, t);
    const again = await checkDrip(s, lim, A(1), 'ip9', t + 1000);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(429);
    await recordDrip(s, A(2), 'ip1', { at: t }, true, t);
    const ipFull = await checkDrip(s, lim, A(3), 'ip1', t);
    expect(ipFull.ok).toBe(false);
    expect((await checkDrip(s, lim, A(3), 'ip2', t)).ok).toBe(true);
    await recordDrip(s, A(3), 'ip2', { at: t }, true, t);
    const cap = await checkDrip(s, lim, A(4), 'ip3', t);
    expect(cap.ok).toBe(false);
    // next UTC day: IP and global counters reset, address cooldown still applies for 24 h
    const t2 = Date.UTC(2026, 9, 8, 1);
    expect((await checkDrip(s, lim, A(4), 'ip1', t2)).ok).toBe(true);
    expect((await checkDrip(s, lim, A(1), 'ip1', t2)).ok).toBe(false);
    expect((await checkDrip(s, lim, A(1), 'ip1', t + 24 * 3600_000 + 1)).ok).toBe(true);
    expect(await s.get('drip:total')).toBe(3);
  });
  it('an address whose AUSD leg is pending may retry without using new quota', async () => {
    const s = new MemStore();
    const t = Date.UTC(2026, 9, 7, 5);
    await recordDrip(s, A(7), 'ip1', { at: t, monTx: '0x1', ausdPending: true }, true, t);
    const d = await checkDrip(s, lim, A(7), 'ip1', t + 70_000);
    expect(d.ok && d.retryOfPending).toBe(true);
  });
  it('relay caps per address and per day', async () => {
    const s = new MemStore();
    const l = { perAddressPerDay: 2, dailyCap: 3 };
    await recordRelay(s, A(1));
    await recordRelay(s, A(1));
    expect((await checkRelay(s, l, A(1))).ok).toBe(false);
    expect((await checkRelay(s, l, A(2))).ok).toBe(true);
    await recordRelay(s, A(2));
    expect((await checkRelay(s, l, A(3))).ok).toBe(false);
  });
  it('seconds to UTC midnight', () => {
    expect(secondsToUtcMidnight(Date.UTC(2026, 9, 7, 23, 59, 0))).toBe(60);
  });
});

describe('struct decoders tolerate the feasibility and v1 layouts', () => {
  const yes = A(0xaa);
  const no = A(0xbb);
  it('Series: 7 words (feasibility) and 8 words (v1, gated flag)', () => {
    const st = stringToHex('RCSS', { size: 4 });
    const v0 = encodeAbiParameters(
      [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'uint64' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [st, 20261008, 30, 1791385200n, yes, no, 5n],
    );
    const v1 = encodeAbiParameters(
      [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'uint64' }, { type: 'bool' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [st, 20261008, -3, 1791385200n, true, yes, no, 5n],
    );
    expect(decodeSeries(v0)).toMatchObject({ station: 'RCSS', date: 20261008, strikeC: 30, gated: false, yes, no });
    expect(decodeSeries(v1)).toMatchObject({ station: 'RCSS', strikeC: -3, gated: true, yes, no, collateral: 5n });
    expect(decodeSeries('0x')).toBeNull();
  });
  it('Result: 4 words (feasibility) and 5 words (v1, finalAt)', () => {
    const h = keccak256('0x01');
    const r0 = encodeAbiParameters([{ type: 'uint8' }, { type: 'int16' }, { type: 'uint64' }, { type: 'bytes32' }], [1, 29, 100n, h]);
    const r1 = encodeAbiParameters([{ type: 'uint8' }, { type: 'int16' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }], [2, 0, 100n, 7300n, h]);
    expect(decodeResult(r0)).toEqual({ status: 1, tmaxC: 29, resolvedAt: 100, finalAt: 100, sourcesHash: h });
    expect(decodeResult(r1)).toEqual({ status: 2, tmaxC: 0, resolvedAt: 100, finalAt: 7300, sourcesHash: h });
  });
});

describe('deployments normaliser', () => {
  it('finds addresses by key name in any nesting, roles, markets and the deploy block', () => {
    const d = normalizeDeployments({
      chainId: 10143,
      deployBlock: 69000000,
      contracts: {
        Resolver: { address: A(1), block: 69000001 },
        CollateralVault: A(2),
        IsothermZap: A(3),
        OutcomeTokenImplementation: A(9),
      },
      external: { AUSD: A(4), kuruRouter: A(5) },
      roles: { maker: A(6), deployer: A(7), attester: A(8) },
      markets: { [keccak256('0x01')]: A(10) },
    });
    expect(d.resolver).toBe(A(1));
    expect(d.vault).toBe(A(2));
    expect(d.zap).toBe(A(3));
    expect(d.ausd).toBe(A(4));
    expect(d.kuruRouter).toBe(A(5));
    expect(d.makers).toEqual([A(6)]);
    expect(d.team).toEqual(expect.arrayContaining([A(7), A(8)]));
    expect(d.deployBlock).toBe(69000000n);
    expect(d.markets[keccak256('0x01')]).toBe(A(10));
  });
  it('reads the real v1 deployments/testnet.json (when present)', () => {
    const d = normalizeDeployments(deployed);
    if ((deployed as { source?: string }).source !== 'deployments/testnet.json') return;
    const raw = deployed as unknown as Record<string, string> & { roles: Record<string, string>; deployBlock: number };
    expect(d.resolver).toBe(getAddress(raw.resolver));
    expect(d.vault).toBe(getAddress(raw.vault));
    expect(d.zap).toBe(getAddress(raw.zap));
    expect(d.marginAccount).toBe(getAddress(raw.kuruMarginAccount));
    expect(d.deployBlock).toBe(BigInt(raw.deployBlock));
    for (const a of Object.values(raw.roles)) expect(d.team).toContain(getAddress(a));
  });
  it('falls back to the feasibility deployment', () => {
    const d = normalizeDeployments({ source: 'feasibility-fallback' });
    expect(d.vault).toBe(getAddress('0xc83fe722eb5bd29a0355c090f14ccb0605153713'));
    expect(d.ausd).toBe(getAddress('0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC'));
  });
});

describe('maker snapshot', () => {
  it('normalises field-name variants and percentages', () => {
    const s = normalizeSnapshot({
      generatedAt: '2026-10-07T05:00:00Z',
      ladders: [
        {
          station: 'RCSS',
          date: '2026-10-08',
          observedMax: 27,
          polymarket: { slug: 'highest-temperature-in-taipei-on-october-8-2026', volume: 1234 },
          strikes: [
            { strike: 30, fairValue: 0.5, polymarket: 48, v0: 0.63, market: A(11).toLowerCase(), seriesId: keccak256('0x02') },
            { k: 29, fair: 0.8, pmImplied: { p: 0.81 }, model: 0.875 },
            { k: 'x' },
          ],
        },
      ],
    });
    expect(s.ladders[0].date).toBe(20261008);
    expect(s.ladders[0].observedMaxC).toBe(27);
    expect(s.ladders[0].strikes.map((x) => x.k)).toEqual([29, 30]);
    expect(s.ladders[0].strikes[1]).toMatchObject({ fair: 0.5, pmImplied: 0.48, model: 0.63, market: A(11) });
    expect(s.ladders[0].strikes[0].pmImplied).toBe(0.81);
    expect(s.ladders[0].polymarketUrl).toContain('polymarket.com/event/highest-temperature-in-taipei');
    expect(marketsOf(s)).toEqual([{ market: A(11), fromBlock: undefined }]);
  });
  it('accepts the maker package schema (isotherm.snapshot/v1: series[], observed{}, v0{})', () => {
    const file = join(__dirname, '../../../../packages/maker/examples/snapshot.example.json');
    if (!existsSync(file)) return; // maker package not present
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const s = normalizeSnapshot(raw);
    const l = s.ladders[0];
    expect(l.station).toBe('RCSS');
    expect(l.date).toBe(Number(String(raw.ladders[0].date).replace(/-/g, '')));
    const rows = (raw.ladders[0].series ?? raw.ladders[0].strikes) as { strike: number; fair: number; pm: number; guard: number; market: string }[];
    expect(l.strikes.length).toBe(rows.length);
    const src = rows[1];
    const got = l.strikes.find((x) => x.k === src.strike)!;
    expect(got.fair).toBeCloseTo(src.fair, 6);
    expect(got.pmImplied).toBeCloseTo(src.pm, 6);
    expect(got.model).toBeCloseTo(src.guard, 6);
    expect(got.market?.toLowerCase()).toBe(src.market.toLowerCase());
    expect(l.observedMaxC).toBe(raw.ladders[0].observedMaxC ?? raw.ladders[0].observed.tmaxC);
    expect(l.polymarketUrl).toBe(raw.ladders[0].polymarket.url);
    expect(marketsOf(s).length).toBe(rows.filter((x) => x.market).length);
    expect(JSON.stringify(s)).not.toContain('budget');
  });
  it('passes fairSource / guardSource through (provenance of fair and of the model guardrail)', () => {
    const file = join(__dirname, '../../../../packages/maker/examples/snapshot.example.json');
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const rows = raw.ladders[0].strikes as { strike: number; fairSource: string; guardSource: string }[];
      const got = normalizeSnapshot(raw).ladders[0].strikes;
      expect(rows.some((r) => r.fairSource === 'polymarket')).toBe(true);
      for (const r of rows) expect(got.find((x) => x.k === r.strike)).toMatchObject({ fairSource: r.fairSource, guardSource: r.guardSource });
    }
    const one = (st: Record<string, unknown>) => normalizeSnapshot({ ladders: [{ station: 'RCSS', date: 20261008, series: [{ strike: 30, fair: 0.4, ...st }] }] }).ladders[0].strikes[0];
    expect(one({ fairSource: 'fallback-v0', guardSource: 'v0-truncated' })).toMatchObject({ fairSource: 'fallback-v0', guardSource: 'v0-truncated' });
    expect(one({ fairSource: 'fallback-intraday', guardSource: 'intraday' })).toMatchObject({ fairSource: 'fallback-intraday', guardSource: 'intraday' });
    // not reported, or not a short lowercase label -> null (never passed through raw)
    expect(one({})).toMatchObject({ fairSource: null, guardSource: null });
    expect(one({ fairSource: '<img src=x onerror=alert(1)>', guardSource: 'V0' })).toMatchObject({ fairSource: null, guardSource: null });
    expect(one({ fairSource: 'x'.repeat(41), guardSource: 7 })).toMatchObject({ fairSource: null, guardSource: null });
  });
  it('rejects malformed input', () => {
    expect(() => normalizeSnapshot([])).toThrow(HttpError);
    expect(() => normalizeSnapshot({ ladders: [{ station: 'taipei', date: 20261008, strikes: [] }] })).toThrow(/ICAO/);
    expect(() => normalizeSnapshot({ ladders: 'x' })).toThrow(/array/);
  });
});

describe('log scan aggregation', () => {
  const resolver = A(0x5e5);
  const market = A(0x111);
  const maker = A(0x222);
  const team = A(0x333);
  const zap = A(0x444);
  const trade = (origin: string, size: bigint, price: bigint, isBuy = true, n = 1): Log =>
    ({
      address: market,
      topics: encodeEventTopics({ abi: [TRADE_EVENT], eventName: 'Trade' }),
      data: encodeAbiParameters(
        [{ type: 'uint40' }, { type: 'address' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint96' }, { type: 'address' }, { type: 'address' }, { type: 'uint96' }],
        [5, maker, isBuy, price, 0n, zap, origin as Hex, size],
      ),
      transactionHash: padHex(`0x${n.toString(16)}`, { size: 32 }),
      blockNumber: BigInt(100 + n),
      logIndex: 0,
    }) as unknown as Log;
  const resolved = (station: string, date: number, status: number, tmax: number): Log =>
    ({
      address: resolver,
      topics: encodeEventTopics({ abi: [LADDER_RESOLVED_EVENT], eventName: 'LadderResolved', args: { station: stringToHex(station, { size: 4 }), date } }),
      data: encodeAbiParameters([{ type: 'uint8' }, { type: 'int16' }, { type: 'bytes32' }, { type: 'address' }], [status, tmax, keccak256('0x99'), A(1)]),
      transactionHash: padHex('0xabc', { size: 32 }),
      blockNumber: 999n,
      logIndex: 1,
    }) as unknown as Log;

  it('attributes fills to tx.origin and keeps maker/team out of the public wallet count', () => {
    const b: ScanBatch = { counters: emptyCounters(), wallets: {}, teamWallets: {}, trades: [], settlements: {} };
    const ext1 = A(0x901);
    const ext2 = A(0x902);
    applyLogs(
      b,
      [
        trade(ext1, 45_454_545n, 440_000_000_000_000_000n, true, 1),
        trade(ext1, 10_000_000n, 500_000_000_000_000_000n, false, 2),
        trade(ext2, 1_000_000n, 100_000_000_000_000_000n, true, 3),
        trade(team, 2_000_000n, 100_000_000_000_000_000n, true, 4),
        trade(maker, 2_000_000n, 100_000_000_000_000_000n, true, 5),
        resolved('RCSS', 20261008, 1, 29),
        resolved('ZZZZ', 20261006, 1, 29),
        resolved('RJTT', 20261008, 2, 0),
      ],
      { makers: new Set([maker.toLowerCase()]), team: new Set([team.toLowerCase()]) },
      resolver,
    );
    expect(b.counters.fills).toBe(5);
    expect(b.counters.externalFills).toBe(3);
    expect(b.counters.teamFills).toBe(1);
    expect(b.counters.makerTakerFills).toBe(1);
    expect(Object.keys(b.wallets).sort()).toEqual([ext1.toLowerCase(), ext2.toLowerCase()].sort());
    // 45.454545 YES @ 0.44 = 19.999999 AUSD (6 dp, floored)
    expect(b.trades.find((t) => t.size === 45.454545)?.price).toBe(0.44);
    expect(BigInt(b.counters.externalVolumeAusd6)).toBe(19_999_999n + 5_000_000n + 100_000n);
    const st = publicStats(b, ['RCSS', 'RJTT'], { head: 1000n, cursor: 990n, drips: 4, relayed: 1 });
    expect(st.nonMakerWallets).toBe(2);
    expect(st.nonMakerFills).toBe(3);
    expect(st.settledCityDays).toBe(1);
    expect(st.voidCityDays).toBe(1);
    expect(st.testLadders).toBe(1);
    expect(st.lagBlocks).toBe(11);
  });
});

describe('market discovery from the v1 Zap registry', () => {
  it('reads CanonicalMarketSet(seriesId, market, setBy) logs from the zap only', () => {
    const zap = A(0x2a9);
    const mk = A(0x777);
    const log = (address: string) =>
      ({
        address,
        topics: encodeEventTopics({ abi: [CANONICAL_MARKET_SET_EVENT], eventName: 'CanonicalMarketSet', args: { seriesId: keccak256('0x01'), market: mk, setBy: A(5) } }),
        data: '0x',
        transactionHash: padHex('0x1', { size: 32 }),
        blockNumber: 1n,
        logIndex: 0,
      }) as unknown as Log;
    expect(discoveredMarkets([log(zap)], zap)).toEqual([mk]);
    expect(discoveredMarkets([log(A(0x123))], zap)).toEqual([]);
    expect(discoveredMarkets([log(zap)], null)).toEqual([]);
  });
});

describe('v1 vault interface', () => {
  it('mintSetWithAuthorization nonce = keccak256(abi.encode(seriesId, amount, salt))', () => {
    const sid = keccak256('0x01');
    const salt = keccak256('0x02');
    expect(authorizationNonce(sid, 25_000_000n, salt)).toBe(
      keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }], [sid, 25_000_000n, salt])),
    );
  });
  it('selector detection in runtime bytecode (PUSH4 and PUSH3 forms)', () => {
    const sel = SELECTORS.mintSetWithAuthorization;
    expect(bytecodeHasSelector(`0x6080${'63' + sel.slice(2)}14`, sel)).toBe(true);
    expect(bytecodeHasSelector('0x608060405200', sel)).toBe(false);
    expect(bytecodeHasSelector('0x62abcdef14', '0x00abcdef')).toBe(true);
  });
  it('matches the exported ABI when packages/abi provides one', () => {
    const vaultAbi = (bundle as Record<string, { type: string; name?: string }[]>).CollateralVault;
    if (!vaultAbi) return; // not exported yet: the built-in fragment is used
    const fn = vaultAbi.find((x) => x.type === 'function' && x.name === 'mintSetWithAuthorization');
    if (!fn) return;
    expect(toFunctionSelector(fn as never)).toBe(toFunctionSelector(vaultV1Abi[0]));
  });
});

describe('/api/health version', () => {
  it('reports the build id baked in by scripts/build-info.mjs', () => {
    const v = versionInfo(null);
    expect(v.app).toBe('1.0.0');
    expect(v.build).toBe(buildJson.build);
    expect(v.build).toMatch(/^([0-9a-f]{7,}|nogit)(-dirty)?\.[0-9a-f]{12}$/);
    expect(Number.isFinite(Date.parse(v.builtAt))).toBe(true);
    expect([v.workerVersionId, v.deployedAt]).toEqual([null, null]); // outside Cloudflare
  });
  it('adds the Cloudflare version id and its upload (deploy) time from the version_metadata binding', () => {
    const v = versionInfo({ id: 'ce5bfc02-7145-4d8f-b9f0-501e2f9ddcdf', timestamp: '2026-10-07T08:30:01.123Z' });
    expect(v.workerVersionId).toBe('ce5bfc02-7145-4d8f-b9f0-501e2f9ddcdf');
    expect(v.deployedAt).toBe('2026-10-07T08:30:01.123Z');
  });
  it('wrangler dev (no timestamp) and junk metadata give nulls, never a made-up deploy time', () => {
    expect(versionInfo({ id: 'ce5bfc02-7145-4d8f-b9f0-501e2f9ddcdf' }).deployedAt).toBeNull();
    expect(versionInfo({ id: '<b>', timestamp: 'yesterday' })).toMatchObject({ workerVersionId: null, deployedAt: null });
    expect(versionInfo(null, {})).toMatchObject({ app: 'unknown', build: 'unknown', commit: null, dirty: null });
  });
});
