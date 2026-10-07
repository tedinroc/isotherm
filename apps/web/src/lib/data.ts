// Loads ladders, strikes, books, results and the viewer's balances from chain (Multicall3), merged with the maker's
// snapshot from the API. The chain is the source of truth for anything that moves money: series, canonical
// markets (v1 Zap registry), books, results. The snapshot only adds fair value / Polymarket-implied / observed max.
import { getAddress, type Address, type Hex } from 'viem';
import { DEPLOYMENTS } from './deployments';
import {
  SELECTORS,
  ausdAbi,
  bookAbi,
  bytecodeHasSelector,
  decodeResult,
  decodeSeries,
  erc20Abi,
  multicallAbi,
  resolverAbi,
  routerAbi,
  station4,
  vaultAbi,
  zapAbi,
  type ResultInfo,
} from './abi';
import { EMPTY_BOOK, decodeL2, type Book } from './book';
import { dec, enc, multicall, pub, type Call } from './chain';
import type { Snapshot, SnapshotLadder, SnapshotStrike } from './api';
import { stationMeta } from './stations';

export interface StrikeView {
  seriesId: Hex;
  k: number;
  yes: Address;
  no: Address;
  closeTime: number;
  gated: boolean;
  market: Address | null;
  marketSource: 'zap-registry' | 'snapshot' | 'deployments' | null;
  takerFeeBps: number;
  book: Book;
  fair: number | null;
  pmImplied: number | null;
  model: number | null;
  flags: string[];
  makerMode: string | null;
  divergence: number | null;
}

export interface LadderView {
  key: string; // RCSS-20261008
  station: string;
  date: number;
  dayEnd: number;
  closeTime: number;
  result: ResultInfo | null;
  strikes: StrikeView[];
  snap: SnapshotLadder | null;
  test: boolean;
}

export interface Capabilities {
  canonicalRegistry: boolean; // v1 Zap: canonicalMarket(seriesId), min-out required
  mintWithAuthorization: boolean; // v1 vault: EIP-3009 relayed mint
  mintWithPermit: boolean;
  challengeWindow: number; // seconds (0 on the feasibility resolver, which has no window)
}

/**
 * Challenge window to show while the resolver's own value has not been read: the deployed value recorded in
 * deployments/testnet.json (`params.challengeWindow`, 900 s on v1), never 0 (which would read as "no window").
 */
export const DEFAULT_CHALLENGE_WINDOW = DEPLOYMENTS.challengeWindow ?? 0;

// Only a complete, successful read is cached. A failed read is never frozen into the cache: getCode failures throw
// (the caller's next refresh asks again), and a failed challengeWindow read falls back to DEFAULT_CHALLENGE_WINDOW
// for this call only. Before this, an RPC hiccup on first load cached "no canonical registry" / "window 0" for the
// whole session.
let capsCache: Capabilities | null = null;
let capsInflight: Promise<Capabilities> | null = null;
export function capabilities(): Promise<Capabilities> {
  if (capsCache) return Promise.resolve(capsCache);
  capsInflight ??= readCapabilities().finally(() => {
    capsInflight = null;
  });
  return capsInflight;
}

async function readCapabilities(): Promise<Capabilities> {
  // No .catch here: a transport error must not read as "this contract lacks the function".
  const [zapCode, vaultCode, resolverCode] = await Promise.all([
    pub.getCode({ address: DEPLOYMENTS.zap }),
    pub.getCode({ address: DEPLOYMENTS.vault }),
    pub.getCode({ address: DEPLOYMENTS.resolver }),
  ]);
  let complete = true;
  let challengeWindow = 0; // feasibility resolver: the function does not exist, so 0 is the real answer
  if (bytecodeHasSelector(resolverCode ?? '0x', SELECTORS.challengeWindow)) {
    try {
      challengeWindow = Number(await pub.readContract({ address: DEPLOYMENTS.resolver, abi: resolverAbi, functionName: 'challengeWindow' }));
    } catch {
      challengeWindow = DEFAULT_CHALLENGE_WINDOW;
      complete = false;
    }
  }
  const caps: Capabilities = {
    canonicalRegistry: bytecodeHasSelector(zapCode ?? '0x', SELECTORS.canonicalMarket),
    mintWithAuthorization: bytecodeHasSelector(vaultCode ?? '0x', SELECTORS.mintSetWithAuthorization),
    mintWithPermit: bytecodeHasSelector(vaultCode ?? '0x', SELECTORS.mintSetWithPermit),
    challengeWindow,
  };
  if (complete) capsCache = caps;
  return caps;
}


/** Chain clock (anvil forks can be ahead of the wall clock after time travel). */
let clockOffset = 0;
export const chainNow = () => Math.floor(Date.now() / 1000) + clockOffset;
async function syncClock(): Promise<void> {
  const ts = (await pub.readContract({ address: DEPLOYMENTS.multicall3, abi: multicallAbi, functionName: 'getCurrentBlockTimestamp' })) as bigint;
  clockOffset = Number(ts) - Math.floor(Date.now() / 1000);
}

function snapLadder(snapshot: Snapshot | null, station: string, date: number): SnapshotLadder | null {
  return snapshot?.ladders?.find((l) => l.station === station && Number(l.date) === date) ?? null;
}
function snapStrike(l: SnapshotLadder | null, k: number, seriesId: string): SnapshotStrike | null {
  if (!l) return null;
  return l.strikes.find((s) => (s.seriesId && s.seriesId.toLowerCase() === seriesId.toLowerCase()) || s.k === k) ?? null;
}

/** Ladders known to the vault (newest `limit`), with series, canonical books, results. */
export async function loadLadders(snapshot: Snapshot | null, limit = 24): Promise<LadderView[]> {
  const caps = await capabilities();
  await syncClock().catch(() => undefined);
  const V = DEPLOYMENTS.vault;
  const R = DEPLOYMENTS.resolver;
  const [countRaw] = await multicall([{ target: V, callData: enc(vaultAbi, 'ladderCount') }]);
  const count = Number(dec<bigint>(vaultAbi, 'ladderCount', countRaw) ?? 0n);
  const from = Math.max(0, count - limit);
  const refs = await multicall(Array.from({ length: count - from }, (_, i) => ({ target: V, callData: enc(vaultAbi, 'ladderAt', [BigInt(from + i)]) })));
  const ladders = refs
    .map((r) => dec<readonly [Hex, number]>(vaultAbi, 'ladderAt', r))
    .filter((x): x is readonly [Hex, number] => !!x)
    .map(([st, date]) => ({ stHex: st, station: hexStation(st), date: Number(date) }));

  // per ladder: series ids, result, dayEnd
  const perLadder: Call[] = [];
  for (const l of ladders) {
    perLadder.push({ target: V, callData: enc(vaultAbi, 'ladderSeries', [l.stHex, l.date]) });
    perLadder.push({ target: R, callData: enc(resolverAbi, 'resultOf', [l.stHex, l.date]) });
    perLadder.push({ target: R, callData: enc(resolverAbi, 'dayEnd', [l.stHex, l.date]) });
  }
  const r1 = await multicall(perLadder);
  const ids: Hex[][] = [];
  const results: (ResultInfo | null)[] = [];
  const dayEnds: number[] = [];
  ladders.forEach((_, i) => {
    ids.push([...(dec<readonly Hex[]>(vaultAbi, 'ladderSeries', r1[i * 3]) ?? [])]);
    results.push(r1[i * 3 + 1] ? decodeResult(r1[i * 3 + 1]!) : null);
    dayEnds.push(Number(dec<bigint>(resolverAbi, 'dayEnd', r1[i * 3 + 2]) ?? 0n));
  });

  // per series: struct + canonical market (v1)
  const allIds = ids.flat();
  const perSeries: Call[] = [];
  for (const id of allIds) {
    perSeries.push({ target: V, callData: enc(vaultAbi, 'getSeries', [id]) });
    if (caps.canonicalRegistry) perSeries.push({ target: DEPLOYMENTS.zap, callData: enc(zapAbi, 'canonicalMarket', [id]) });
  }
  const r2 = await multicall(perSeries);
  const step = caps.canonicalRegistry ? 2 : 1;
  const series = new Map<string, { info: ReturnType<typeof decodeSeries>; market: Address | null }>();
  allIds.forEach((id, i) => {
    const info = r2[i * step] ? decodeSeries(r2[i * step]!) : null;
    let market: Address | null = null;
    if (caps.canonicalRegistry) {
      const m = dec<Address>(zapAbi, 'canonicalMarket', r2[i * step + 1]);
      if (m && !/^0x0{40}$/i.test(m)) market = getAddress(m);
    }
    series.set(id.toLowerCase(), { info, market });
  });

  const views: LadderView[] = ladders.map((l, li) => {
    const snap = snapLadder(snapshot, l.station, l.date);
    const strikes: StrikeView[] = [];
    for (const id of ids[li]) {
      const s = series.get(id.toLowerCase());
      if (!s?.info) continue;
      const ss = snapStrike(snap, s.info.strikeC, id);
      let market = s.market;
      let marketSource: StrikeView['marketSource'] = market ? 'zap-registry' : null;
      if (!market && !caps.canonicalRegistry) {
        const dm = DEPLOYMENTS.markets[id.toLowerCase()];
        if (dm) {
          market = dm;
          marketSource = 'deployments';
        } else if (ss?.market) {
          market = getAddress(ss.market);
          marketSource = 'snapshot';
        }
      }
      strikes.push({
        seriesId: id,
        k: s.info.strikeC,
        yes: s.info.yes,
        no: s.info.no,
        closeTime: s.info.closeTime,
        gated: s.info.gated,
        market,
        marketSource,
        takerFeeBps: 10,
        book: EMPTY_BOOK,
        fair: ss?.fair ?? null,
        pmImplied: ss?.pmImplied ?? null,
        model: ss?.model ?? null,
        flags: ss?.flags ?? [],
        makerMode: ss?.mode ?? null,
        divergence: ss?.divergence ?? null,
      });
    }
    strikes.sort((a, b) => a.k - b.k);
    return {
      key: `${l.station}-${l.date}`,
      station: l.station,
      date: l.date,
      dayEnd: dayEnds[li],
      closeTime: strikes.length ? Math.min(...strikes.map((s) => s.closeTime)) : dayEnds[li],
      result: results[li],
      strikes,
      snap,
      test: !!stationMeta(l.station).test,
    };
  });

  // Verify non-registry markets against Kuru's router (base = YES, quote = AUSD) before showing them.
  const unverified = views.flatMap((v) => v.strikes).filter((s) => s.market && s.marketSource !== 'zap-registry');
  if (unverified.length) {
    const r3 = await multicall(unverified.map((s) => ({ target: DEPLOYMENTS.kuruRouter, callData: enc(routerAbi, 'verifiedMarket', [s.market]) })));
    unverified.forEach((s, i) => {
      const vm = dec<readonly [number, bigint, Address, bigint, Address, bigint, number, bigint, bigint, bigint, bigint]>(routerAbi, 'verifiedMarket', r3[i]);
      if (!vm || getAddress(vm[2]) !== getAddress(s.yes) || getAddress(vm[4]) !== getAddress(DEPLOYMENTS.ausd)) {
        s.market = null;
        s.marketSource = null;
      } else {
        s.takerFeeBps = Number(vm[9]);
      }
    });
  }
  await refreshBooks(views);
  return views.reverse(); // newest first
}

export function hexStation(h: Hex): string {
  let s = '';
  for (let i = 2; i < 10; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16);
    if (c) s += String.fromCharCode(c);
  }
  return s;
}

/** Refresh all books of the given ladders in one multicall (plus fees for registry markets on first load). */
export async function refreshBooks(views: LadderView[]): Promise<void> {
  const strikes = views.flatMap((v) => v.strikes).filter((s) => s.market);
  if (!strikes.length) return;
  const calls: Call[] = strikes.map((s) => ({ target: s.market!, callData: enc(bookAbi, 'getL2Book') }));
  const needFee = strikes.filter((s) => s.marketSource === 'zap-registry' && s.takerFeeBps === 10 && !(s as { feeChecked?: boolean }).feeChecked);
  for (const s of needFee) calls.push({ target: DEPLOYMENTS.kuruRouter, callData: enc(routerAbi, 'verifiedMarket', [s.market]) });
  const res = await multicall(calls);
  strikes.forEach((s, i) => {
    const raw = dec<Hex>(bookAbi, 'getL2Book', res[i]);
    s.book = raw ? decodeL2(raw) : EMPTY_BOOK;
  });
  needFee.forEach((s, j) => {
    const vm = dec<readonly unknown[]>(routerAbi, 'verifiedMarket', res[strikes.length + j]);
    if (vm) s.takerFeeBps = Number(vm[9] as bigint);
    (s as { feeChecked?: boolean }).feeChecked = true;
  });
}

export interface Holding {
  ladder: LadderView;
  strike: StrikeView;
  yes: bigint;
  no: bigint;
}

export interface Balances {
  mon: bigint;
  ausd: bigint;
  ausdAllowanceZap: bigint;
  ausdAllowanceVault: bigint; // Buy No mints the set in the vault (mintSet), so it needs its own allowance
  holdings: Holding[];
  yesAllowanceZap: Record<string, bigint>;
}

export async function loadBalances(user: Address, ladders: LadderView[]): Promise<Balances> {
  const strikes = ladders.flatMap((l) => l.strikes.map((s) => ({ l, s })));
  const calls: Call[] = [
    { target: DEPLOYMENTS.ausd, callData: enc(ausdAbi, 'balanceOf', [user]) },
    { target: DEPLOYMENTS.ausd, callData: enc(ausdAbi, 'allowance', [user, DEPLOYMENTS.zap]) },
    { target: DEPLOYMENTS.ausd, callData: enc(ausdAbi, 'allowance', [user, DEPLOYMENTS.vault]) },
  ];
  const H = 3; // header calls before the per-strike triples
  for (const { s } of strikes) {
    calls.push({ target: s.yes, callData: enc(erc20Abi, 'balanceOf', [user]) });
    calls.push({ target: s.no, callData: enc(erc20Abi, 'balanceOf', [user]) });
    calls.push({ target: s.yes, callData: enc(erc20Abi, 'allowance', [user, DEPLOYMENTS.zap]) });
  }
  const [res, mon] = await Promise.all([multicall(calls), pub.getBalance({ address: user })]);
  const holdings: Holding[] = [];
  const yesAllowanceZap: Record<string, bigint> = {};
  strikes.forEach(({ l, s }, i) => {
    const yes = dec<bigint>(erc20Abi, 'balanceOf', res[H + i * 3]) ?? 0n;
    const no = dec<bigint>(erc20Abi, 'balanceOf', res[H + 1 + i * 3]) ?? 0n;
    yesAllowanceZap[s.seriesId] = dec<bigint>(erc20Abi, 'allowance', res[H + 2 + i * 3]) ?? 0n;
    if (yes > 0n || no > 0n) holdings.push({ ladder: l, strike: s, yes, no });
  });
  return {
    mon,
    ausd: dec<bigint>(ausdAbi, 'balanceOf', res[0]) ?? 0n,
    ausdAllowanceZap: dec<bigint>(ausdAbi, 'allowance', res[1]) ?? 0n,
    ausdAllowanceVault: dec<bigint>(ausdAbi, 'allowance', res[2]) ?? 0n,
    holdings,
    yesAllowanceZap,
  };
}

export const stationHex = station4;
