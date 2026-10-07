// The maker's snapshot: what the web app shows next to the live Kuru book (fair value, Polymarket-implied
// probability, the v0 model guardrail, the observed max so far, the canonical market per strike).
// The maker posts it with a bearer token; the API normalises common field-name variants so the two workstreams
// do not have to agree on every key, and it never trusts it for money: the web app re-reads books and series
// on-chain and the Zap checks the market.
import { getAddress, isAddress, type Address } from 'viem';
import { HttpError } from './util';

export interface SnapshotStrike {
  k: number;
  seriesId: string | null;
  yes: Address | null;
  no: Address | null;
  market: Address | null;
  marketBlock: number | null;
  fair: number | null;
  pmImplied: number | null;
  model: number | null;
  bid: number | null;
  ask: number | null;
  flags: string[];
  mode: string | null; // maker state for this strike, e.g. "quoting", "certain", "pulled"
  reason: string | null;
  divergence: number | null; // |guard model − Polymarket| as computed by the maker
}

export interface SnapshotLadder {
  station: string;
  city: string | null;
  date: number;
  closeTime: number | null;
  dayEnd: number | null;
  observedMaxC: number | null;
  observedAt: string | null;
  polymarketUrl: string | null;
  polymarketVolume: number | null;
  forecastMu: number | null;
  status: string | null;
  strikes: SnapshotStrike[];
}

export interface Snapshot {
  version: 1;
  generatedAt: string;
  receivedAt: string;
  chainId: number;
  source: string | null;
  rpcKind: string | null;
  honesty: string[];
  ladders: SnapshotLadder[];
  maker: Record<string, unknown> | null;
}

const pickNum = (o: Record<string, unknown>, keys: string[]): number | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    if (v && typeof v === 'object' && 'p' in (v as object)) {
      const p = (v as { p: unknown }).p;
      if (typeof p === 'number' && Number.isFinite(p)) return p;
    }
  }
  return null;
};
const pickStr = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) if (typeof o[k] === 'string' && (o[k] as string).length) return (o[k] as string).slice(0, 300);
  return null;
};
const pickAddr = (o: Record<string, unknown>, keys: string[]): Address | null => {
  for (const k of keys) if (typeof o[k] === 'string' && isAddress(o[k] as string)) return getAddress(o[k] as string);
  return null;
};
const prob = (x: number | null) => (x === null ? null : x > 1 && x <= 100 ? x / 100 : x >= 0 && x <= 1 ? x : null);

export function parseDate(v: unknown): number | null {
  if (typeof v === 'number' && v > 19000101 && v < 21001231) return Math.floor(v);
  if (typeof v === 'string') {
    const s = v.replace(/-/g, '');
    if (/^\d{8}$/.test(s)) return Number(s);
  }
  return null;
}

export function normalizeSnapshot(input: unknown): Snapshot {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'snapshot must be a JSON object');
  const o = input as Record<string, unknown>;
  const laddersIn = Array.isArray(o.ladders) ? o.ladders : Array.isArray(o.markets) ? o.markets : null;
  if (!laddersIn) throw new HttpError(400, 'snapshot.ladders must be an array');
  if (laddersIn.length > 40) throw new HttpError(400, 'too many ladders');
  const ladders: SnapshotLadder[] = [];
  for (const l of laddersIn) {
    if (!l || typeof l !== 'object') continue;
    const lo = l as Record<string, unknown>;
    const station = pickStr(lo, ['station', 'icao']);
    const date = parseDate(lo.date ?? lo.localDate);
    if (!station || !/^[A-Z]{4}$/.test(station) || !date) throw new HttpError(400, 'each ladder needs station (ICAO) and date');
    // packages/maker "isotherm.snapshot/v1": `series` is the per-strike array and `strikes` a plain number list.
    const objs = (a: unknown) => (Array.isArray(a) && a.some((x) => x && typeof x === 'object') ? (a as unknown[]) : null);
    const strikesIn = objs(lo.series) ?? objs(lo.strikes) ?? objs(lo.ladder) ?? [];
    if (strikesIn.length > 40) throw new HttpError(400, 'too many strikes');
    const v0 = (lo.v0 && typeof lo.v0 === 'object' ? lo.v0 : {}) as Record<string, unknown>;
    const v0Ladder = (v0.ladder && typeof v0.ladder === 'object' ? v0.ladder : {}) as Record<string, unknown>;
    const strikes: SnapshotStrike[] = [];
    for (const s of strikesIn) {
      if (!s || typeof s !== 'object') continue;
      const so = s as Record<string, unknown>;
      const k = pickNum(so, ['k', 'strike', 'strikeC']);
      if (k === null || !Number.isInteger(k) || k < -90 || k > 70) continue;
      const sid = pickStr(so, ['seriesId', 'id']);
      const v0k = v0Ladder[String(k)];
      strikes.push({
        k,
        seriesId: sid && /^0x[0-9a-fA-F]{64}$/.test(sid) ? sid.toLowerCase() : null,
        yes: pickAddr(so, ['yes', 'yesToken']),
        no: pickAddr(so, ['no', 'noToken']),
        market: pickAddr(so, ['market', 'book', 'kuruMarket']),
        marketBlock: pickNum(so, ['marketBlock', 'createdBlock']),
        fair: prob(pickNum(so, ['fair', 'fairValue', 'fv', 'mid', 'quoteMid'])),
        pmImplied: prob(pickNum(so, ['pmImplied', 'polymarket', 'pm', 'pmProb', 'polymarketImplied'])),
        model: prob(pickNum(so, ['model', 'guard', 'v0', 'modelProb', 'forecast']) ?? (typeof v0k === 'number' ? v0k : null)),
        bid: prob(pickNum(so, ['bid', 'quoteBid'])),
        ask: prob(pickNum(so, ['ask', 'quoteAsk'])),
        flags: Array.isArray(so.flags) ? so.flags.filter((f): f is string => typeof f === 'string').slice(0, 8) : [],
        mode: pickStr(so, ['mode']),
        reason: pickStr(so, ['reason']),
        divergence: pickNum(so, ['divergence']),
      });
    }
    strikes.sort((a, b) => a.k - b.k);
    const pm = (lo.polymarket && typeof lo.polymarket === 'object' ? lo.polymarket : {}) as Record<string, unknown>;
    const fc = (lo.forecast && typeof lo.forecast === 'object' ? lo.forecast : {}) as Record<string, unknown>;
    const ob = (lo.observed && typeof lo.observed === 'object' ? lo.observed : {}) as Record<string, unknown>;
    const obsStarted = ob.dayStarted !== false;
    ladders.push({
      station,
      city: pickStr(lo, ['city', 'name']),
      date,
      closeTime: pickNum(lo, ['closeTime', 'close']),
      dayEnd: pickNum(lo, ['dayEnd']),
      observedMaxC:
        pickNum(lo, ['observedMaxC', 'observedMax', 'tmaxSoFar', 'obsMaxC']) ?? (obsStarted ? pickNum(ob, ['tmaxC', 'maxC']) : null),
      observedAt: pickStr(lo, ['observedAt', 'observedLast', 'lastObs']) ?? (obsStarted ? pickStr(ob, ['atLocal', 'lastLocal']) : null),
      polymarketUrl: polymarketLink(pickStr(pm, ['url']), pickStr(pm, ['slug'])),
      polymarketVolume: pickNum(pm, ['volume']),
      forecastMu: pickNum(fc, ['mu']) ?? pickNum(v0Of(lo), ['mu']),
      status: pickStr(lo, ['status']),
      strikes,
    });
  }
  return {
    version: 1,
    generatedAt: pickStr(o, ['generatedAt', 'asOf', 'ts']) ?? new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    chainId: pickNum(o, ['chainId']) ?? 10143,
    source: pickStr(o, ['source', 'schema']),
    rpcKind: pickStr(o, ['rpcKind']),
    honesty: Array.isArray(o.honesty) ? o.honesty.filter((x): x is string => typeof x === 'string').slice(0, 8) : [],
    ladders,
    maker: o.maker && typeof o.maker === 'object' ? (o.maker as Record<string, unknown>) : null,
  };
}

/** The web app renders this as an <a href> (React 18 does not block javascript: URLs), so only an https link to
 *  polymarket.com is passed through; a slug is URL-encoded into the canonical event path (security review v1). */
export function polymarketLink(url: string | null, slug: string | null): string | null {
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && (u.hostname === 'polymarket.com' || u.hostname.endsWith('.polymarket.com'))) return u.toString();
    } catch {
      /* not a URL */
    }
  }
  if (slug && /^[a-z0-9-]{1,200}$/i.test(slug)) return `https://polymarket.com/event/${encodeURIComponent(slug)}`;
  return null;
}

function v0Of(lo: Record<string, unknown>): Record<string, unknown> {
  return (lo.v0 && typeof lo.v0 === 'object' ? lo.v0 : {}) as Record<string, unknown>;
}

export function marketsOf(s: Snapshot): { market: Address; fromBlock?: bigint }[] {
  const out: { market: Address; fromBlock?: bigint }[] = [];
  for (const l of s.ladders)
    for (const k of l.strikes)
      if (k.market) out.push({ market: k.market, fromBlock: k.marketBlock ? BigInt(Math.floor(k.marketBlock)) : undefined });
  return out;
}
