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
import { applyLogs, discoveredMarkets, emptyBatch, loadBatch, makeClassifier, migrateV1, publicStats, saveBatch, type V1Batch } from '../../src/scan';
import { configFrom, type Env } from '../../src/env';
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

  const meta = { head: 1000n, cursor: 990n, drips: 4, relayed: 1 };

  it('attributes fills to tx.origin and keeps maker/team out of the public wallet count', () => {
    const b = emptyBatch();
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
      resolver,
    );
    // the scan keeps raw per-origin data for every origin, maker and team included, and no class
    expect(Object.keys(b.origins).sort()).toEqual([ext1, ext2, team, maker].map((a) => a.toLowerCase()).sort());
    expect(b.origins[ext1.toLowerCase()]).toEqual({ fills: 2, volumeAusd6: String(19_999_999 + 5_000_000) });
    expect(b.trades.every((t) => t.kind === undefined)).toBe(true);
    // 45.454545 YES @ 0.44 = 19.999999 AUSD (6 dp, floored)
    expect(b.trades.find((t) => t.size === 45.454545)?.price).toBe(0.44);
    const st = publicStats(b, ['RCSS', 'RJTT'], meta, makeClassifier([maker], [team]));
    expect(st.fills).toBe(5);
    expect(st.nonMakerFills).toBe(3);
    expect(st.teamFills).toBe(1);
    expect(st.makerTakerFills).toBe(1);
    expect(st.nonMakerWallets).toBe(2);
    expect(st.teamWallets).toBe(1);
    expect(st.nonMakerVolumeAusd).toBe((19_999_999 + 5_000_000 + 100_000) / 1e6);
    expect(st.settledCityDays).toBe(1);
    expect(st.voidCityDays).toBe(1);
    expect(st.testLadders).toBe(1);
    expect(st.lagBlocks).toBe(11);
    expect(st.classification).toMatchObject({ appliedAt: 'publish', makerAddresses: 1, teamAddresses: 1, v1Migration: null });
  });

  it('classifies at publish time: a wallet added to the team list later moves to team with all its past fills', () => {
    const b = emptyBatch();
    const ext = A(0x901);
    const late = A(0x903); // e.g. our own embedded wallet, identified after it traded
    applyLogs(b, [trade(ext, 1_000_000n, 500_000_000_000_000_000n, true, 1), trade(late, 5_050_505n, 990_000_000_000_000_000n, true, 2), trade(late, 1_000_000n, 990_000_000_000_000_000n, false, 3)], resolver);
    const before = publicStats(b, [], meta, makeClassifier([maker], [team]));
    expect(before).toMatchObject({ nonMakerWallets: 2, nonMakerFills: 3, teamFills: 0, teamWallets: 0, fills: 3 });
    expect(before.nonMakerVolumeAusd).toBe((500_000 + 4_999_999 + 990_000) / 1e6);
    const after = publicStats(b, [], meta, makeClassifier([maker], [team, late]));
    expect(after).toMatchObject({ nonMakerWallets: 1, nonMakerFills: 1, teamFills: 2, teamWallets: 1, makerTakerFills: 0, fills: 3 });
    expect(after.nonMakerVolumeAusd).toBe(0.5);
    expect(after.volumeAusd).toBe(before.volumeAusd); // moved, not added: nothing counted twice
    expect(after.recentTrades.filter((t) => t.origin === late).map((t) => t.kind)).toEqual(['team', 'team']);
    expect(after.recentTrades.find((t) => t.origin === ext)?.kind).toBe('external');
    // the stored rows are untouched (publishing is pure), and lowercase / checksum list entries behave the same
    expect(b.trades.every((t) => t.kind === undefined)).toBe(true);
    expect(publicStats(b, [], meta, makeClassifier([], [late.toLowerCase()])).nonMakerWallets).toBe(1);
    // an address on both lists is the maker; dropping a wallet from the team list makes it external again
    expect(publicStats(b, [], meta, makeClassifier([late], [late])).makerTakerFills).toBe(2);
    expect(publicStats(b, [], meta, makeClassifier([maker], [team])).nonMakerWallets).toBe(2);
  });
});

/** A Kuru Trade log (filled through the Zap) on market 0x…111, tx.origin = `origin`. */
const tradeLog = (origin: string, size: bigint, price: bigint, n: number, isBuy = true): Log =>
  ({
    address: A(0x111),
    topics: encodeEventTopics({ abi: [TRADE_EVENT], eventName: 'Trade' }),
    data: encodeAbiParameters(
      [{ type: 'uint40' }, { type: 'address' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint96' }, { type: 'address' }, { type: 'address' }, { type: 'uint96' }],
      [5, A(0x222), isBuy, price, 0n, A(0x444), origin as Hex, size],
    ),
    transactionHash: padHex(`0x${n.toString(16)}`, { size: 32 }),
    blockNumber: BigInt(100 + n),
    logIndex: 0,
  }) as unknown as Log;

describe('v1 stats store (classified at scan time) -> raw per-origin data', () => {
  // The live v1 store on 2026-10-07 13:17Z: one team fill (0xd42A smoke test, 76.923076 YES @ 0.13 = 9.999999 AUSD)
  // and the Dynamic embedded wallet's Zap buy (5.050505 YES @ 0.99 = 4.999999 AUSD), scanned as "external".
  const smoke = getAddress('0xd42A0b394F09df88BB2120D0973569b845f2D79c');
  const dyn = getAddress('0xF4a3377D1200584D8Ab7d7e64c6B17dc6c792427');
  const v1Live = (): V1Batch => ({
    counters: { fills: 2, externalFills: 1, teamFills: 1, makerTakerFills: 0, volumeAusd6: '14999998', externalVolumeAusd6: '4999999' },
    wallets: { [dyn.toLowerCase()]: 1 },
    teamWallets: { [smoke.toLowerCase()]: 1 },
    trades: [
      { tx: padHex('0x2', { size: 32 }), block: '68971890', market: A(0x171), origin: dyn, side: 'buy', price: 0.99, size: 5.050505, kind: 'external' },
      { tx: padHex('0x1', { size: 32 }), block: '68895232', market: A(0x4f5), origin: smoke, side: 'buy', price: 0.13, size: 76.923076, kind: 'team' },
    ],
  });
  const meta = { head: 2000n, cursor: 2001n, drips: 3, relayed: 1 };
  const oldTeam = makeClassifier([A(0x222)], [smoke]);
  const newTeam = makeClassifier([A(0x222)], [smoke, dyn]);
  const putV1 = async (st: MemStore, v: V1Batch) => {
    await st.put('scan:counters', v.counters);
    await st.put('scan:wallets', v.wallets);
    await st.put('scan:teamWallets', v.teamWallets);
    await st.put('scan:trades', v.trades);
    await st.put('scan:settlements', {});
  };

  it('migrates exactly when the trade list holds every fill: fills and volume per origin, reconciled with v1', () => {
    const m = migrateV1(v1Live());
    expect(m.exact).toBe(true);
    expect(m.legacy).toBeNull();
    expect(m.origins).toEqual({
      [dyn.toLowerCase()]: { fills: 1, volumeAusd6: '4999999' },
      [smoke.toLowerCase()]: { fills: 1, volumeAusd6: '9999999' },
    });
  });

  it('with the old lists it publishes what v1 published; with the embedded wallet on the team list it is team', async () => {
    const st = new MemStore();
    await putV1(st, v1Live());
    const b = await loadBatch(st);
    const old = publicStats(b, [], meta, oldTeam);
    expect(old).toMatchObject({ nonMakerWallets: 1, nonMakerFills: 1, fills: 2, teamFills: 1, teamWallets: 1, volumeAusd: 14.999998, nonMakerVolumeAusd: 4.999999 });
    const now = publicStats(b, [], { ...meta, migration: await st.get('scan:migration') }, newTeam);
    expect(now).toMatchObject({ nonMakerWallets: 0, nonMakerFills: 0, fills: 2, teamFills: 2, teamWallets: 2, makerTakerFills: 0, volumeAusd: 14.999998, nonMakerVolumeAusd: 0, relayedMints: 1 });
    expect(now.recentTrades.map((t) => [t.origin, t.kind])).toEqual([[dyn, 'team'], [smoke, 'team']]);
    expect(now.classification.v1Migration).toBe('exact');
  });

  it('migrates once, keeps the v1 keys as they were, and never counts a v1 fill twice', async () => {
    const st = new MemStore();
    const v1 = v1Live();
    await putV1(st, v1);
    const b = await loadBatch(st);
    expect(await st.get('scan:origins')).toEqual(b.origins); // persisted by the load itself
    expect(await st.get('scan:migration')).toMatchObject({ from: 'v1', exact: true });
    // a new fill from the embedded wallet, scanned and saved the v2 way
    applyLogs(b, [tradeLog(dyn, 1_000_000n, 500_000_000_000_000_000n, 3)], A(0x5e5));
    await saveBatch(st, b);
    const again = await loadBatch(st); // v2 store now: no second migration on top of the new data
    expect(again.origins[dyn.toLowerCase()]).toEqual({ fills: 2, volumeAusd6: '5499999' });
    const stats = publicStats(again, [], meta, newTeam);
    expect(stats).toMatchObject({ fills: 3, teamFills: 3, teamWallets: 2, nonMakerWallets: 0, volumeAusd: 15.499998 });
    // raw v1 data stays where it was
    expect(await st.get('scan:counters')).toEqual(v1.counters);
    expect(await st.get('scan:wallets')).toEqual(v1.wallets);
    expect(await st.get('scan:teamWallets')).toEqual(v1.teamWallets);
  });

  it('falls back when the trade list is incomplete: wallets and fills reclassify, volume stays in its v1 class', () => {
    const v = v1Live();
    v.counters = { fills: 41, externalFills: 30, teamFills: 6, makerTakerFills: 5, volumeAusd6: '100000000', externalVolumeAusd6: '70000000' };
    v.wallets = { [dyn.toLowerCase()]: 20, [A(0x901).toLowerCase()]: 10 };
    v.teamWallets = { [smoke.toLowerCase()]: 6 };
    const m = migrateV1(v);
    expect(m.exact).toBe(false);
    expect(m.legacy).toEqual({ makerFills: 5, externalVolumeAusd6: '70000000', otherVolumeAusd6: '30000000' });
    const b = { ...emptyBatch(), origins: m.origins, legacy: m.legacy };
    const old = publicStats(b, [], meta, oldTeam);
    expect(old).toMatchObject({ fills: 41, nonMakerFills: 30, nonMakerWallets: 2, teamFills: 6, makerTakerFills: 5, volumeAusd: 100, nonMakerVolumeAusd: 70 });
    const now = publicStats(b, [], meta, newTeam);
    expect(now).toMatchObject({ fills: 41, nonMakerFills: 10, nonMakerWallets: 1, teamFills: 26, teamWallets: 2, makerTakerFills: 5, volumeAusd: 100, nonMakerVolumeAusd: 70 });
  });

  it('an origin in both v1 maps (team list changed mid-scan) is one wallet with its fills summed once', () => {
    const v = v1Live();
    v.counters = { fills: 31, externalFills: 20, teamFills: 11, makerTakerFills: 0, volumeAusd6: '31000000', externalVolumeAusd6: '20000000' };
    v.wallets = { [dyn.toLowerCase()]: 20 };
    v.teamWallets = { [dyn.toLowerCase()]: 3, [smoke.toLowerCase()]: 8 };
    const m = migrateV1(v);
    expect(m.origins[dyn.toLowerCase()].fills).toBe(23);
    const b = { ...emptyBatch(), origins: m.origins, legacy: m.legacy };
    expect(publicStats(b, [], meta, newTeam)).toMatchObject({ fills: 31, teamFills: 31, teamWallets: 2, nonMakerWallets: 0 });
    expect(publicStats(b, [], meta, oldTeam)).toMatchObject({ fills: 31, nonMakerFills: 23, nonMakerWallets: 1, teamWallets: 1 });
  });

  it('does not trust a trade list that disagrees with the v1 counters (exact path needs a full reconciliation)', () => {
    const v = v1Live();
    v.counters = { ...v.counters, externalVolumeAusd6: '4999998' };
    expect(migrateV1(v).exact).toBe(false);
    const u = v1Live();
    u.counters = { ...u.counters, volumeAusd6: '14999999' };
    expect(migrateV1(u).exact).toBe(false);
    const x = v1Live();
    x.counters = { ...x.counters, makerTakerFills: 1 };
    expect(migrateV1(x).exact).toBe(false);
    const y = v1Live(); // counters agree, but v1's external map names a different wallet than the trade list
    y.wallets = { [A(0x901).toLowerCase()]: 1 };
    expect(migrateV1(y).exact).toBe(false);
    const z = v1Live(); // same for the team map
    z.teamWallets = { [smoke.toLowerCase()]: 2 };
    expect(migrateV1(z).exact).toBe(false);
    const w = v1Live();
    w.trades[0] = { ...w.trades[0], kind: 'team' };
    expect(migrateV1(w).exact).toBe(false);
  });

  it('a fresh store has nothing to migrate', async () => {
    const st = new MemStore();
    expect(await loadBatch(st)).toEqual(emptyBatch());
    expect(await st.get('scan:migration')).toBeUndefined();
  });

  it('wrangler.toml lists the Dynamic embedded wallet as team, so its Zap buy is not traction', () => {
    const toml = readFileSync(join(__dirname, '../../wrangler.toml'), 'utf8');
    const vars: Record<string, string> = {};
    for (const m of toml.slice(toml.indexOf('[vars]')).matchAll(/^([A-Z_0-9]+)\s*=\s*"([^"]*)"/gm)) vars[m[1]] = m[2];
    const cfg = configFrom(vars as unknown as Env);
    expect(cfg.teamAddresses).toContain(dyn);
    expect(cfg.teamAddresses).toContain(smoke);
    expect(cfg.makerAddresses).not.toContain(dyn);
    const b = { ...emptyBatch(), origins: migrateV1(v1Live()).origins, trades: v1Live().trades };
    expect(publicStats(b, [], meta, makeClassifier(cfg.makerAddresses, cfg.teamAddresses))).toMatchObject({ nonMakerWallets: 0, nonMakerFills: 0, teamWallets: 2 });
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
