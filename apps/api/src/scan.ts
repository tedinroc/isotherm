// Public stats from the chain itself: Kuru `Trade` logs on our strike books and `LadderResolved` logs from the
// Resolver, scanned in ≤100-block windows (the public RPC's eth_getLogs limit) with a persisted cursor.
// Trades are attributed to the transaction origin (a Zap trade's taker is the Zap; the person is tx.origin), and
// split into maker / team / external so the public number never counts our own wallets as traction.
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type Log } from 'viem';
import { CANONICAL_MARKET_SET_EVENT, LADDER_RESOLVED_EVENT, TRADE_EVENT, bytes4ToString, decodeResult } from './abi';
import type { Pub } from './chain';
import type { Store } from './limits';

export interface TradeRow {
  tx: Hex;
  block: string;
  market: Address;
  origin: Address;
  side: 'buy' | 'sell'; // taker side on YES
  price: number; // AUSD per YES
  size: number; // YES
  kind: 'external' | 'team' | 'maker';
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

export interface Counters {
  fills: number;
  externalFills: number;
  teamFills: number;
  makerTakerFills: number;
  volumeAusd6: string;
  externalVolumeAusd6: string;
}

export const emptyCounters = (): Counters => ({
  fills: 0,
  externalFills: 0,
  teamFills: 0,
  makerTakerFills: 0,
  volumeAusd6: '0',
  externalVolumeAusd6: '0',
});

export interface Classifier {
  makers: Set<string>;
  team: Set<string>;
}

export interface ScanBatch {
  counters: Counters;
  wallets: Record<string, number>; // external origin -> fills
  teamWallets: Record<string, number>;
  trades: TradeRow[]; // newest first
  settlements: Record<string, SettlementRow>;
}

/** Pure: fold decoded logs into the running aggregates. */
export function applyLogs(b: ScanBatch, logs: Log[], cls: Classifier, resolver: Address): ScanBatch {
  let vol = BigInt(b.counters.volumeAusd6);
  let extVol = BigInt(b.counters.externalVolumeAusd6);
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
    vol += notional;
    let kind: TradeRow['kind'] = 'external';
    if (cls.makers.has(origin)) kind = 'maker';
    else if (cls.team.has(origin)) kind = 'team';
    b.counters.fills++;
    if (kind === 'external') {
      b.counters.externalFills++;
      extVol += notional;
      b.wallets[origin] = (b.wallets[origin] ?? 0) + 1;
    } else if (kind === 'team') {
      b.counters.teamFills++;
      b.teamWallets[origin] = (b.teamWallets[origin] ?? 0) + 1;
    } else {
      b.counters.makerTakerFills++;
    }
    b.trades.unshift({
      tx: log.transactionHash as Hex,
      block: String(log.blockNumber),
      market: addr,
      origin: getAddress(args.txOrigin),
      side: args.isBuy ? 'buy' : 'sell',
      price: Number(args.price) / 1e18,
      size: Number(args.filledSize) / 1e6,
      kind,
    });
  }
  b.trades = b.trades.slice(0, 30);
  b.counters.volumeAusd6 = vol.toString();
  b.counters.externalVolumeAusd6 = extVol.toString();
  return b;
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
  classifier: Classifier;
  startBlock: bigint | null;
  maxWindows: number;
  realStations: string[];
}

export async function loadBatch(store: Store): Promise<ScanBatch> {
  return {
    counters: (await store.get<Counters>('scan:counters')) ?? emptyCounters(),
    wallets: (await store.get<Record<string, number>>('scan:wallets')) ?? {},
    teamWallets: (await store.get<Record<string, number>>('scan:teamWallets')) ?? {},
    trades: (await store.get<TradeRow[]>('scan:trades')) ?? [],
    settlements: (await store.get<Record<string, SettlementRow>>('scan:settlements')) ?? {},
  };
}

async function saveBatch(store: Store, b: ScanBatch) {
  await store.put('scan:counters', b.counters);
  await store.put('scan:wallets', b.wallets);
  await store.put('scan:teamWallets', b.teamWallets);
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
  const cursorRaw = await o.store.get<string>('scan:cursor');
  let from = cursorRaw ? BigInt(cursorRaw) : o.startBlock ?? head - 600n;
  const markets = await getMarkets(o.store);
  const addresses = [...markets, o.resolver];
  const b = await loadBatch(o.store);
  let windows = 0;
  let logsSeen = 0;
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
    while (jf <= jt && windows < backfillBudget) {
      const to = jf + 99n < jt ? jf + 99n : jt;
      const logs = await fetchWindow(o.pub, [j.market], jf, to);
      applyLogs(b, logs.filter((l) => getAddress(l.address) !== o.resolver), o.classifier, o.resolver);
      logsSeen += logs.length;
      jf = to + 1n;
      windows++;
    }
    if (jf <= jt) remaining.push({ market: j.market, from: jf.toString(), to: jt.toString() });
  }
  if (o.zap && !addresses.includes(o.zap)) addresses.push(o.zap);
  while (from <= head && windows < o.maxWindows) {
    const to = from + 99n < head ? from + 99n : head;
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
    applyLogs(b, logs.filter((l) => getAddress(l.address) !== o.zap), o.classifier, o.resolver);
    logsSeen += logs.length;
    from = to + 1n;
    windows++;
  }
  await saveBatch(o.store, b);
  await o.store.put('scan:cursor', from.toString());
  await o.store.put('scan:backfill', remaining);
  return { head, cursor: from, windows, logsSeen, backfillPending: remaining.length, batch: b };
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
    applyLogs(b, logs.filter((l) => !o.zap || getAddress(l.address) !== o.zap), o.classifier, o.resolver);
    logsSeen += logs.length;
    from = to + 1n;
    windows++;
  }
  await saveBatch(o.store, b);
  return { scannedTo: from - 1n, windows, logsSeen };
}

export function publicStats(b: ScanBatch, realStations: string[], meta: { head: bigint; cursor: bigint; drips: number; relayed: number }) {
  const rows = Object.values(b.settlements);
  const real = rows.filter((r) => realStations.includes(r.station));
  const toAusd = (s: string) => Number(BigInt(s)) / 1e6;
  return {
    nonMakerWallets: Object.keys(b.wallets).length,
    nonMakerFills: b.counters.externalFills,
    fills: b.counters.fills,
    teamFills: b.counters.teamFills,
    teamWallets: Object.keys(b.teamWallets).length,
    volumeAusd: toAusd(b.counters.volumeAusd6),
    nonMakerVolumeAusd: toAusd(b.counters.externalVolumeAusd6),
    settledCityDays: real.filter((r) => r.status === 1).length,
    voidCityDays: real.filter((r) => r.status === 2).length,
    testLadders: rows.length - real.length,
    drips: meta.drips,
    relayedMints: meta.relayed,
    scannedToBlock: (meta.cursor - 1n).toString(),
    headBlock: meta.head.toString(),
    lagBlocks: Number(meta.head - (meta.cursor - 1n)),
    recentTrades: b.trades.slice(0, 12),
    updatedAt: new Date().toISOString(),
    definitions: {
      nonMakerWallets: 'distinct tx.origin addresses that filled against an Isotherm Kuru book, excluding the maker and team test wallets',
      settledCityDays: 'ladders on real stations resolved Settled by the CRE workflow (test stations and voids excluded)',
      currency: 'testnet faucet AUSD (no real money)',
    },
  };
}
