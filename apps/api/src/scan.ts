// Public stats from the chain itself: Kuru `Trade` logs on our strike books and `LadderResolved` logs from the
// Resolver, scanned in ≤100-block windows (the public RPC's eth_getLogs limit) with a persisted cursor.
// The scan stays `lagBlocks` behind the head (endpoints and load-balanced backends differ by a block or two, and a
// node returns a truncated, error-free result for blocks it has not seen yet). If a window fails (rate limit, outage),
// the run stops there and keeps every window it completed: the cursor moves to the first unscanned block, so nothing
// is skipped or counted twice; the Durable Object then backs off for a few cron ticks (relayer-do.ts).
// Trades are attributed to the transaction origin (a Zap trade's taker is the Zap; the person is tx.origin).
//
// The scan stores RAW per-origin data only (fills + volume for every tx.origin, whoever it is). Whether an origin is
// the maker, a team wallet or an external trader is decided when stats are published (`publicStats`), from the
// CURRENT maker/team lists, so adding a wallet to TEAM_ADDRESSES reclassifies its past fills too and the public number
// never counts our own wallets as traction. (v1 classified at scan time; its stored maps are migrated once, below.)
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type Log } from 'viem';
import { CANONICAL_MARKET_SET_EVENT, LADDER_RESOLVED_EVENT, TRADE_EVENT, bytes4ToString, decodeResult } from './abi';
import type { Pub } from './chain';
import type { Store } from './limits';
import { classifyRpcError, type RpcFailure } from './rpc';
import { errorMessage } from './util';

export type TradeKind = 'external' | 'team' | 'maker';

/** A fill as stored by the scan: no classification (that happens at publish time). */
export interface StoredTrade {
  tx: Hex;
  block: string;
  market: Address;
  origin: Address;
  side: 'buy' | 'sell'; // taker side on YES
  price: number; // AUSD per YES
  size: number; // YES
  /** v1 rows carry their scan-time kind; it is ignored and recomputed at publish time. */
  kind?: TradeKind;
}

/** A fill as published: `kind` from the current maker/team lists. */
export interface TradeRow extends StoredTrade {
  kind: TradeKind;
}

export interface SettlementRow {
  station: string;
  date: number;
  status: number; // 1 settled, 2 void (as logged; refreshed from resultOf on publish)
  tmaxC: number;
  sourcesHash: Hex;
  caller: Address;
  tx: Hex;
  block: string;
  finalAt?: number;
}

/** Raw aggregate for one tx.origin (lowercase key), whatever kind of wallet it is. */
export interface OriginAgg {
  fills: number;
  volumeAusd6: string; // AUSD, 6 dp, integer string
}

/** v1 data that had no per-origin split (only present after an approximate v1 migration, see migrateV1). */
export interface LegacyRemainder {
  makerFills: number; // v1 kept no per-origin map for maker fills
  externalVolumeAusd6: string; // v1 kept volume per class only: stays in the class it had at scan time
  otherVolumeAusd6: string; // team + maker volume
}

export interface ScanBatch {
  origins: Record<string, OriginAgg>;
  trades: StoredTrade[]; // newest first
  settlements: Record<string, SettlementRow>;
  legacy: LegacyRemainder | null;
}

export const emptyBatch = (): ScanBatch => ({ origins: {}, trades: [], settlements: {}, legacy: null });

export interface Classifier {
  makers: Set<string>;
  team: Set<string>;
}

/** Lowercased sets; an address in both lists is the maker. */
export function makeClassifier(makers: readonly string[], team: readonly string[]): Classifier {
  return { makers: new Set(makers.map((a) => a.toLowerCase())), team: new Set(team.map((a) => a.toLowerCase())) };
}

export function kindOf(origin: string, cls: Classifier): TradeKind {
  const o = origin.toLowerCase();
  if (cls.makers.has(o)) return 'maker';
  if (cls.team.has(o)) return 'team';
  return 'external';
}

/** Pure: fold decoded logs into the raw aggregates (no classification). */
export function applyLogs(b: ScanBatch, logs: Log[], resolver: Address): ScanBatch {
  for (const log of logs) {
    const addr = getAddress(log.address);
    if (addr === resolver) {
      try {
        const ev = decodeEventLog({ abi: [LADDER_RESOLVED_EVENT], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        const a = ev.args as { station: Hex; date: number; status: number; tmaxC: number; sourcesHash: Hex; caller: Address };
        const station = bytes4ToString(a.station);
        const key = `${station}-${a.date}`;
        b.settlements[key] = {
          station,
          date: Number(a.date),
          status: Number(a.status),
          tmaxC: Number(a.tmaxC),
          sourcesHash: a.sourcesHash,
          caller: a.caller,
          tx: log.transactionHash as Hex,
          block: String(log.blockNumber),
        };
      } catch {
        /* other resolver events */
      }
      continue;
    }
    let args: { makerAddress: Address; isBuy: boolean; price: bigint; takerAddress: Address; txOrigin: Address; filledSize: bigint };
    try {
      args = decodeEventLog({ abi: [TRADE_EVENT], data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args as typeof args;
    } catch {
      continue;
    }
    const origin = getAddress(args.txOrigin).toLowerCase();
    const notional = (args.filledSize * args.price) / 10n ** 18n; // size 1e6 units × price 1e18 -> AUSD 6 dp
    const agg = b.origins[origin] ?? { fills: 0, volumeAusd6: '0' };
    b.origins[origin] = { fills: agg.fills + 1, volumeAusd6: (BigInt(agg.volumeAusd6) + notional).toString() };
    b.trades.unshift({
      tx: log.transactionHash as Hex,
      block: String(log.blockNumber),
      market: addr,
      origin: getAddress(args.txOrigin),
      side: args.isBuy ? 'buy' : 'sell',
      price: Number(args.price) / 1e18,
      size: Number(args.filledSize) / 1e6,
    });
  }
  b.trades = b.trades.slice(0, 30);
  return b;
}

// ------------------------------------------------------------------------------------------------ classification
export interface Classified {
  fills: number;
  externalFills: number;
  teamFills: number;
  makerFills: number;
  externalWallets: string[];
  teamWallets: string[];
  makerWallets: string[];
  volumeAusd6: bigint;
  externalVolumeAusd6: bigint;
}

/** Pure: split the raw per-origin data by the CURRENT lists. Each origin is counted once, in exactly one class. */
export function classify(b: ScanBatch, cls: Classifier): Classified {
  const out: Classified = {
    fills: 0,
    externalFills: 0,
    teamFills: 0,
    makerFills: 0,
    externalWallets: [],
    teamWallets: [],
    makerWallets: [],
    volumeAusd6: 0n,
    externalVolumeAusd6: 0n,
  };
  for (const [origin, a] of Object.entries(b.origins)) {
    if (!(a.fills > 0)) continue;
    const vol = BigInt(a.volumeAusd6);
    out.fills += a.fills;
    out.volumeAusd6 += vol;
    const kind = kindOf(origin, cls);
    if (kind === 'external') {
      out.externalFills += a.fills;
      out.externalVolumeAusd6 += vol;
      out.externalWallets.push(origin);
    } else if (kind === 'team') {
      out.teamFills += a.fills;
      out.teamWallets.push(origin);
    } else {
      out.makerFills += a.fills;
      out.makerWallets.push(origin);
    }
  }
  if (b.legacy) {
    out.fills += b.legacy.makerFills;
    out.makerFills += b.legacy.makerFills;
    const ext = BigInt(b.legacy.externalVolumeAusd6);
    out.volumeAusd6 += ext + BigInt(b.legacy.otherVolumeAusd6);
    out.externalVolumeAusd6 += ext;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ v1 migration
/** What the v1 scanner stored (classified at scan time). Kept in storage untouched; read once by migrateV1. */
export interface V1Counters {
  fills: number;
  externalFills: number;
  teamFills: number;
  makerTakerFills: number;
  volumeAusd6: string;
  externalVolumeAusd6: string;
}
export interface V1Batch {
  counters: V1Counters;
  wallets: Record<string, number>; // external origin -> fills
  teamWallets: Record<string, number>; // team origin -> fills
  trades: StoredTrade[];
}

const wei18 = (price: number): bigint | null => {
  const nano = Math.round(price * 1e9);
  if (!Number.isSafeInteger(nano) || nano < 0) return null;
  const w = BigInt(nano) * 10n ** 9n;
  return Number(w) / 1e18 === price ? w : null;
};
const units6 = (size: number): bigint | null => {
  const u = Math.round(size * 1e6);
  if (!Number.isSafeInteger(u) || u < 0) return null;
  return Number(u) / 1e6 === size ? BigInt(u) : null;
};

/**
 * Pure: v1 -> raw per-origin data.
 * Exact when the v1 trade list still holds every fill (it kept the newest 30) and the per-origin fills and volumes
 * rebuilt from it reconcile with ALL of v1's stored counters and maps. Otherwise approximate: per-origin fills come
 * from v1's wallet maps (exact, so wallets and fills still reclassify), maker fills and volume stay in their
 * scan-time class as a LegacyRemainder. Either way the totals equal v1's, and nothing is counted twice.
 */
export function migrateV1(v: V1Batch): { origins: Record<string, OriginAgg>; legacy: LegacyRemainder | null; exact: boolean } {
  const c = v.counters;
  if (c.fills === v.trades.length) {
    const origins: Record<string, OriginAgg> = {};
    const byKind: Record<TradeKind, Record<string, number>> = { external: {}, team: {}, maker: {} };
    let vol = 0n;
    let extVol = 0n;
    let ok = true;
    for (const t of v.trades) {
      const p = wei18(t.price);
      const s = units6(t.size);
      if (p === null || s === null || !t.kind) {
        ok = false;
        break;
      }
      const o = t.origin.toLowerCase();
      const n = (s * p) / 10n ** 18n;
      const a = origins[o] ?? { fills: 0, volumeAusd6: '0' };
      origins[o] = { fills: a.fills + 1, volumeAusd6: (BigInt(a.volumeAusd6) + n).toString() };
      byKind[t.kind][o] = (byKind[t.kind][o] ?? 0) + 1;
      vol += n;
      if (t.kind === 'external') extVol += n;
    }
    const same = (x: Record<string, number>, y: Record<string, number>) => {
      const kx = Object.keys(x).map((k) => k.toLowerCase());
      const ky = Object.keys(y);
      return kx.length === ky.length && Object.entries(x).every(([k, n]) => y[k.toLowerCase()] === n);
    };
    const makerFills = Object.values(byKind.maker).reduce((s, n) => s + n, 0);
    if (
      ok &&
      vol.toString() === c.volumeAusd6 &&
      extVol.toString() === c.externalVolumeAusd6 &&
      makerFills === c.makerTakerFills &&
      same(v.wallets, byKind.external) &&
      same(v.teamWallets, byKind.team)
    ) {
      return { origins, legacy: null, exact: true };
    }
  }
  const origins: Record<string, OriginAgg> = {};
  for (const m of [v.wallets, v.teamWallets]) {
    for (const [k, n] of Object.entries(m)) {
      const o = k.toLowerCase();
      origins[o] = { fills: (origins[o]?.fills ?? 0) + n, volumeAusd6: '0' };
    }
  }
  const total = BigInt(c.volumeAusd6);
  const ext = BigInt(c.externalVolumeAusd6);
  return {
    origins,
    legacy: { makerFills: c.makerTakerFills, externalVolumeAusd6: ext.toString(), otherVolumeAusd6: (total - ext).toString() },
    exact: false,
  };
}

export async function fetchWindow(pub: Pub, addresses: Address[], from: bigint, to: bigint): Promise<Log[]> {
  if (!addresses.length) return [];
  return (await pub.getLogs({
    address: addresses,
    events: [TRADE_EVENT, LADDER_RESOLVED_EVENT, CANONICAL_MARKET_SET_EVENT],
    fromBlock: from,
    toBlock: to,
  })) as unknown as Log[];
}

/** Markets announced by the v1 Zap registry inside these logs. */
export function discoveredMarkets(logs: Log[], zap: Address | null): Address[] {
  if (!zap) return [];
  const out: Address[] = [];
  for (const l of logs) {
    if (getAddress(l.address) !== zap) continue;
    try {
      const ev = decodeEventLog({ abi: [CANONICAL_MARKET_SET_EVENT], data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      out.push(getAddress((ev.args as { market: Address }).market));
    } catch {
      /* other zap events */
    }
  }
  return out;
}

const multicallAbi = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);
const resolverReadAbi = parseAbi(['function resultOf(bytes4 station, uint32 date) view returns (bytes32)']);

/** Re-read every logged settlement from resultOf (a guardian challenge can turn Settled into Void in v1). */
export async function refreshSettlements(pub: Pub, multicall: Address, resolver: Address, rows: SettlementRow[]) {
  if (!rows.length) return rows;
  const calls = rows.map((r) => ({
    target: resolver,
    allowFailure: true,
    callData: encodeFunctionData({
      abi: resolverReadAbi,
      functionName: 'resultOf',
      args: [`0x${[...r.station].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(8, '0')}` as Hex, r.date],
    }),
  }));
  try {
    const { data } = await pub.call({ to: multicall, data: encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [calls] }) });
    const res = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: data ?? '0x' }) as readonly {
      success: boolean;
      returnData: Hex;
    }[];
    res.forEach((x, i) => {
      if (!x.success) return;
      const d = decodeResult(x.returnData);
      if (d && d.status !== 0) {
        rows[i].status = d.status;
        rows[i].tmaxC = d.tmaxC;
        rows[i].finalAt = d.finalAt;
      }
    });
  } catch {
    /* keep logged values */
  }
  return rows;
}

// ------------------------------------------------------------------------------------------------ runner
export interface ScanOptions {
  pub: Pub;
  store: Store;
  resolver: Address;
  zap: Address | null;
  multicall: Address;
  startBlock: bigint | null;
  maxWindows: number;
  realStations: string[];
  /** Scan only up to head - lagBlocks (default 0). */
  lagBlocks?: bigint;
}

/** Why a scan run stopped before its window budget or the head: the failing RPC error, classified. */
export interface ScanStop {
  kind: RpcFailure;
  error: string;
  /** The window that failed (it is scanned again on the next run). */
  at: string;
}

const stopOf = (e: unknown, at: string): ScanStop => ({ kind: classifyRpcError(e), error: errorMessage(e), at });

export interface MigrationInfo {
  from: 'v1';
  exact: boolean;
  at: string;
}

/**
 * Load the raw aggregates. A store written by the v1 scanner (no `scan:origins` yet) is migrated once and the result
 * persisted right away, inside this call (storage-only, so no other request runs in between); v1's own keys
 * (`scan:counters`, `scan:wallets`, `scan:teamWallets`) are left as they were and never read again.
 */
export async function loadBatch(store: Store): Promise<ScanBatch> {
  const trades = (await store.get<StoredTrade[]>('scan:trades')) ?? [];
  const settlements = (await store.get<Record<string, SettlementRow>>('scan:settlements')) ?? {};
  const origins = await store.get<Record<string, OriginAgg>>('scan:origins');
  if (origins) return { origins, trades, settlements, legacy: (await store.get<LegacyRemainder>('scan:legacy')) ?? null };
  const counters = await store.get<V1Counters>('scan:counters');
  if (!counters) return { origins: {}, trades, settlements, legacy: null };
  const m = migrateV1({
    counters,
    wallets: (await store.get<Record<string, number>>('scan:wallets')) ?? {},
    teamWallets: (await store.get<Record<string, number>>('scan:teamWallets')) ?? {},
    trades,
  });
  if (m.legacy) await store.put('scan:legacy', m.legacy);
  await store.put('scan:origins', m.origins);
  await store.put('scan:migration', { from: 'v1', exact: m.exact, at: new Date().toISOString() } satisfies MigrationInfo);
  return { origins: m.origins, trades, settlements, legacy: m.legacy };
}

export async function saveBatch(store: Store, b: ScanBatch) {
  await store.put('scan:origins', b.origins);
  await store.put('scan:trades', b.trades);
  await store.put('scan:settlements', b.settlements);
}

export async function getMarkets(store: Store): Promise<Address[]> {
  return (await store.get<Address[]>('scan:markets')) ?? [];
}

/** Add markets to watch; returns the ones that are new (they get a backfill from `fromBlock`). */
export async function addMarkets(store: Store, markets: { market: Address; fromBlock?: bigint }[], backfill = true) {
  const cur = await getMarkets(store);
  const seen = new Set(cur.map((m) => m.toLowerCase()));
  const fresh: { market: Address; fromBlock?: bigint }[] = [];
  for (const m of markets) {
    if (seen.has(m.market.toLowerCase())) continue;
    seen.add(m.market.toLowerCase());
    cur.push(getAddress(m.market));
    fresh.push(m);
  }
  if (fresh.length) {
    await store.put('scan:markets', cur.slice(-500));
    if (!backfill) return fresh;
    const jobs = (await store.get<{ market: Address; from: string; to: string | null }[]>('scan:backfill')) ?? [];
    for (const f of fresh) jobs.push({ market: getAddress(f.market), from: (f.fromBlock ?? -1n).toString(), to: null });
    await store.put('scan:backfill', jobs.slice(-50));
  }
  return fresh;
}

/** Lookback for a market announced without its creation block (the maker posts a snapshot right after creating). */
export const BACKFILL_LOOKBACK = 1500n;

export async function scanOnce(o: ScanOptions) {
  const head = await o.pub.getBlockNumber({ cacheTime: 0 });
  const top = head - (o.lagBlocks ?? 0n); // the last block this run may read
  const cursorRaw = await o.store.get<string>('scan:cursor');
  let from = cursorRaw ? BigInt(cursorRaw) : o.startBlock ?? top - 600n;
  const markets = await getMarkets(o.store);
  const addresses = [...markets, o.resolver];
  const b = await loadBatch(o.store);
  let windows = 0;
  let logsSeen = 0;
  let stopped: ScanStop | null = null;
  // backfill jobs for markets added after the cursor passed their first trades
  // Backfill gets at most half of this run's window budget so the live cursor never starves.
  const backfillBudget = Math.floor(o.maxWindows / 2);
  const jobs = (await o.store.get<{ market: Address; from: string; to: string | null }[]>('scan:backfill')) ?? [];
  const remaining: typeof jobs = [];
  for (const j of jobs) {
    let jf = BigInt(j.from);
    const jt = j.to ? BigInt(j.to) : from - 1n; // up to where the main cursor already is
    if (jf < 0n) jf = jt - BACKFILL_LOOKBACK; // unknown creation block: look back ~8 min of blocks
    if (o.startBlock !== null && jf < o.startBlock) jf = o.startBlock;
    if (!stopped) {
      try {
        while (jf <= jt && windows < backfillBudget) {
          const to = jf + 99n < jt ? jf + 99n : jt;
          const logs = await fetchWindow(o.pub, [j.market], jf, to);
          applyLogs(b, logs.filter((l) => getAddress(l.address) !== o.resolver), o.resolver);
          logsSeen += logs.length;
          jf = to + 1n;
          windows++;
        }
      } catch (e) {
        stopped = stopOf(e, `backfill ${j.market} from ${jf}`); // this job resumes at jf; later jobs are kept as they are
      }
    }
    if (jf <= jt) remaining.push({ market: j.market, from: jf.toString(), to: jt.toString() });
  }
  if (o.zap && !addresses.includes(o.zap)) addresses.push(o.zap);
  if (!stopped) {
    try {
      while (from <= top && windows < o.maxWindows) {
        const to = from + 99n < top ? from + 99n : top;
        const logs = await fetchWindow(o.pub, addresses, from, to);
        const fresh = discoveredMarkets(logs, o.zap).filter((m) => !addresses.includes(m));
        if (fresh.length) {
          // a book registered in this window: watch it from now on and pick up its trades in this same window
          await addMarkets(o.store, fresh.map((market) => ({ market, fromBlock: from })), false);
          addresses.splice(addresses.length - 1, 0, ...fresh);
          const extra = await fetchWindow(o.pub, fresh, from, to);
          logs.push(...extra.filter((l) => getAddress(l.address) !== o.zap));
          windows++;
        }
        // applied only once every fetch of this window succeeded, then the cursor moves past it
        applyLogs(b, logs.filter((l) => getAddress(l.address) !== o.zap), o.resolver);
        logsSeen += logs.length;
        from = to + 1n;
        windows++;
      }
    } catch (e) {
      stopped = stopOf(e, `blocks ${from}..${from + 99n < top ? from + 99n : top}`);
    }
  }
  await saveBatch(o.store, b);
  await o.store.put('scan:cursor', from.toString());
  await o.store.put('scan:backfill', remaining);
  return { head, top, cursor: from, windows, logsSeen, backfillPending: remaining.length, batch: b, stopped };
}

/** Scan an explicit historical range (admin backfill, e.g. the feasibility settlements). Does not move the cursor. */
export async function scanRange(o: ScanOptions, fromBlock: bigint, toBlock: bigint, extra: Address[] = []) {
  const markets = await getMarkets(o.store);
  const addresses = [...new Set([...markets, ...extra, o.resolver].map((a) => getAddress(a)))];
  if (o.zap) addresses.push(o.zap);
  const b = await loadBatch(o.store);
  let windows = 0;
  let logsSeen = 0;
  let from = fromBlock;
  while (from <= toBlock && windows < o.maxWindows) {
    const to = from + 99n < toBlock ? from + 99n : toBlock;
    const logs = await fetchWindow(o.pub, addresses, from, to);
    const fresh = discoveredMarkets(logs, o.zap).filter((m) => !addresses.includes(m));
    if (fresh.length) {
      await addMarkets(o.store, fresh.map((market) => ({ market, fromBlock: from })), false);
      addresses.push(...fresh);
      logs.push(...(await fetchWindow(o.pub, fresh, from, to)));
    }
    applyLogs(b, logs.filter((l) => !o.zap || getAddress(l.address) !== o.zap), o.resolver);
    logsSeen += logs.length;
    from = to + 1n;
    windows++;
  }
  await saveBatch(o.store, b);
  return { scannedTo: from - 1n, windows, logsSeen };
}

export interface PublishMeta {
  head: bigint;
  cursor: bigint;
  drips: number;
  relayed: number;
  migration?: MigrationInfo | null;
}

/** Pure: the public stats, classified NOW from `cls` (the current maker + team lists). */
export function publicStats(b: ScanBatch, realStations: string[], meta: PublishMeta, cls: Classifier) {
  const rows = Object.values(b.settlements);
  const real = rows.filter((r) => realStations.includes(r.station));
  const toAusd = (v: bigint) => Number(v) / 1e6;
  const c = classify(b, cls);
  const recentTrades: TradeRow[] = b.trades.slice(0, 12).map((t) => ({ ...t, kind: kindOf(t.origin, cls) }));
  return {
    nonMakerWallets: c.externalWallets.length,
    nonMakerFills: c.externalFills,
    fills: c.fills,
    teamFills: c.teamFills,
    teamWallets: c.teamWallets.length,
    makerTakerFills: c.makerFills,
    volumeAusd: toAusd(c.volumeAusd6),
    nonMakerVolumeAusd: toAusd(c.externalVolumeAusd6),
    settledCityDays: real.filter((r) => r.status === 1).length,
    voidCityDays: real.filter((r) => r.status === 2).length,
    testLadders: rows.length - real.length,
    drips: meta.drips,
    relayedMints: meta.relayed,
    scannedToBlock: (meta.cursor - 1n).toString(),
    headBlock: meta.head.toString(),
    lagBlocks: Math.max(0, Number(meta.head - (meta.cursor - 1n))), // includes the deliberate scan lag
    recentTrades,
    classification: {
      appliedAt: 'publish' as const,
      makerAddresses: cls.makers.size,
      teamAddresses: cls.team.size,
      v1Migration: meta.migration ? (meta.migration.exact ? 'exact' : 'approximate') : null,
    },
    updatedAt: new Date().toISOString(),
    definitions: {
      nonMakerWallets: 'distinct tx.origin addresses that filled against an Isotherm Kuru book, excluding the maker and team test wallets',
      classification:
        'maker / team / external is decided each time these stats are published, from the current MAKER_ADDRESSES and TEAM_ADDRESSES (plus deployment roles), over the raw per-origin fills the scan keeps; adding a wallet to the team list reclassifies its past fills',
      settledCityDays: 'ladders on real stations resolved Settled by the CRE workflow (test stations and voids excluded)',
      currency: 'testnet faucet AUSD (no real money)',
    },
  };
}
