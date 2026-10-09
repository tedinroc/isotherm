// Polymarket core (runtime-agnostic: no Node APIs, no file cache). Event/bucket parsing, the live implied ladder
// (ladderFromGamma, pure), the CLOB best-price batch (global fetch) and fetchLiveLadder() with an injected GET, so
// the Node maker (polymarket.ts, file-cached fetchText) and the Cloudflare Worker (apps/maker-worker) share one
// implementation. Moved verbatim from polymarket.ts, which re-exports everything here.
// The maker quotes around this ladder. Our own v0 forecast LOSES to Polymarket in backtest (Brier 0.0656 vs 0.0594),
// so it is only a guardrail / fallback. Never present this as a forecasting edge.
import type { TextGetter } from "./fetch-types.ts";
import { station as stationOf } from "./stations.ts";

export interface Bucket {
  label: string; // groupItemTitle, e.g. "21°C or below", "25°C", "31°C or higher"
  lo: number; // inclusive lower bound in integer °C (-Infinity for "or below")
  hi: number; // inclusive upper bound (Infinity for "or higher")
  yesToken: string;
  finalYes: number | null; // resolved YES price (1 = winner) when closed
  conditionId: string;
}

export interface PmEvent {
  id: string;
  slug: string;
  date: string; // local observation date YYYY-MM-DD parsed from slug
  title: string;
  startDate: string;
  endDate: string;
  closed: boolean;
  volume: number;
  resolutionSource: string;
  descriptionHead: string;
  unit: "C" | "F";
  buckets: Bucket[];
  winner: Bucket | null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function slugDate(slug: string): string | null {
  const m = slug.match(/-on-([a-z]+)-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]);
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Parse "21°C or below" | "25°C" | "31°C or higher" | "24-25°C" | "86-87°F" into an integer range. */
export function parseBucket(label: string): { lo: number; hi: number; unit: "C" | "F" } | null {
  const unit: "C" | "F" = /°?F\b/.test(label) && !/°C/.test(label) ? "F" : "C";
  const s = label.replace(/\s+/g, " ").trim();
  let m = s.match(/^(-?\d+)\s*°?[CF]? or (below|lower)$/i);
  if (m) return { lo: -Infinity, hi: Number(m[1]), unit };
  m = s.match(/^(-?\d+)\s*°?[CF]? or (higher|above|more)$/i);
  if (m) return { lo: Number(m[1]), hi: Infinity, unit };
  m = s.match(/^(-?\d+)\s*[-–]\s*(-?\d+)\s*°?[CF]?$/);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]), unit };
  m = s.match(/^(-?\d+)\s*°?[CF]?$/);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]), unit };
  return null;
}

export function toEvent(e: any): PmEvent | null {
  const date = slugDate(e.slug);
  if (!date) return null;
  const buckets: Bucket[] = [];
  let unit: "C" | "F" = "C";
  for (const m of e.markets ?? []) {
    const pb = parseBucket(m.groupItemTitle ?? "");
    if (!pb) continue;
    unit = pb.unit;
    const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
    const toks = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
    buckets.push({ label: m.groupItemTitle, lo: pb.lo, hi: pb.hi, yesToken: toks[0], finalYes: prices ? Number(prices[0]) : null, conditionId: m.conditionId });
  }
  buckets.sort((a, b) => a.lo - b.lo);
  const closed = Boolean(e.closed);
  const winners = closed ? buckets.filter((b) => b.finalYes === 1) : [];
  return {
    id: String(e.id),
    slug: e.slug,
    date,
    title: e.title,
    startDate: e.startDate,
    endDate: e.endDate,
    closed,
    volume: Number(e.volume ?? 0),
    resolutionSource: e.resolutionSource ?? "",
    descriptionHead: String(e.description ?? "").slice(0, 900),
    unit,
    buckets,
    winner: winners.length === 1 ? winners[0] : null,
  };
}

export function eventSlug(city: string, date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `highest-temperature-in-${city}-on-${MONTHS[m - 1]}-${d}-${y}`;
}

/** Which physical source settles this event, from its rule text. */
export function settlementSourceOf(ev: { resolutionSource: string; descriptionHead: string }, icao: string): { kind: "station" | "other"; label: string } {
  const txt = (ev.resolutionSource + " " + ev.descriptionHead).toLowerCase();
  const id = icao.toLowerCase();
  if (txt.includes("wunderground.com") && txt.includes(id)) return { kind: "station", label: `wunderground:${icao}` };
  if (txt.includes("weather.gov/wrh/timeseries") && txt.includes(id)) return { kind: "station", label: `noaa-timeseries:${icao}` };
  const m = txt.match(/https?:\/\/[^\s)]+/);
  return { kind: "other", label: m ? m[0] : "unknown" };
}

export interface PricePt {
  t: number;
  p: number;
}
export function priceAt(h: PricePt[], tsSec: number): number | null {
  let p: number | null = null;
  for (const x of h) {
    if (x.t <= tsSec) p = x.p;
    else break;
  }
  return p;
}

// ================================================================ LIVE implied ladder
export interface LiveBucket {
  label: string;
  lo: number | null; // null = -Infinity (JSON-safe)
  hi: number | null; // null = +Infinity
  yesToken: string;
  marketSlug: string;
  bestBid: number | null;
  bestAsk: number | null;
  last: number | null;
  outcome: number | null; // Gamma outcomePrices[0] (Polymarket's displayed price)
  spread: number | null;
  price: number; // the price used (before normalisation)
  priceSource: "mid" | "last" | "mid-wide" | "ask-half" | "bid-only" | "outcome" | "none";
  quoteSource: "clob" | "gamma";
  illiquid: boolean;
  acceptingOrders: boolean;
  liquidity: number;
  p: number; // normalised probability of this bucket
}

export interface LiveLadder {
  station: string;
  city: string;
  date: string;
  slug: string;
  url: string; // human page
  apiUrl: string;
  eventId: string;
  title: string;
  closed: boolean;
  volume: number;
  liquidity: number;
  endDate: string;
  settlementSource: string; // e.g. "wunderground:RCSS"
  unit: "C" | "F";
  fetchedAt: string;
  quoteSource: "clob" | "gamma" | "mixed";
  sumRaw: number; // sum of chosen bucket prices before normalisation
  buckets: LiveBucket[];
  ladder: Record<string, number>; // strike k -> P(Tmax >= k) for strikes the grid determines
  strikes: number[]; // determined strikes, ascending
  median: number | null; // integer m with P(>=m) >= 0.5 > P(>=m+1)
  mean: number | null;
  sd: number | null;
  ok: boolean;
  warnings: string[];
}

export interface LadderOpts {
  maxSpreadForMid?: number; // above this the bucket is "illiquid": use last trade if inside [bid,ask]
  sumMin?: number; // normalisation sanity band
  sumMax?: number;
}
const DEF: Required<LadderOpts> = { maxSpreadForMid: 0.1, sumMin: 0.85, sumMax: 1.25 };

const num = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/** Choose one price per bucket from its book. Pure. */
export function bucketPrice(bid: number | null, ask: number | null, last: number | null, outcome: number | null, maxSpread = DEF.maxSpreadForMid) {
  const b = bid !== null && bid > 0 ? bid : null;
  const a = ask !== null && ask > 0 && ask < 1 ? ask : null;
  if (b !== null && a !== null && a >= b) {
    const spread = a - b;
    if (spread <= maxSpread + 1e-12) return { price: (a + b) / 2, priceSource: "mid" as const, spread, illiquid: false };
    if (last !== null && last >= b && last <= a) return { price: last, priceSource: "last" as const, spread, illiquid: true };
    return { price: (a + b) / 2, priceSource: "mid-wide" as const, spread, illiquid: true };
  }
  if (b === null && a !== null) return { price: a / 2, priceSource: "ask-half" as const, spread: a, illiquid: a > maxSpread };
  if (b !== null && a === null) return { price: (b + 1) / 2, priceSource: "bid-only" as const, spread: 1 - b, illiquid: true };
  if (outcome !== null) return { price: outcome, priceSource: "outcome" as const, spread: null, illiquid: true };
  if (last !== null) return { price: last, priceSource: "last" as const, spread: null, illiquid: true };
  return { price: 0, priceSource: "none" as const, spread: null, illiquid: true };
}

/** Representative temperature of a bucket for mean/sd of the implied distribution. */
const repr = (lo: number, hi: number) => (Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(hi) ? hi - 1 : lo + 1);

/**
 * Pure: Gamma event JSON (+ optional CLOB best bid/ask by YES token) -> implied ladder.
 * P(>=k) = sum of normalised bucket probabilities with lower bound >= k, for every finite bucket lower bound k.
 */
export function ladderFromGamma(
  rawEvent: any,
  icao: string,
  clob: Map<string, { bid: number | null; ask: number | null }> | null,
  fetchedAt: string,
  o: LadderOpts = {},
): LiveLadder {
  const opts = { ...DEF, ...o };
  const st = stationOf(icao);
  const warnings: string[] = [];
  const ev = toEvent(rawEvent);
  if (!ev) throw new Error(`not a daily temperature event: ${rawEvent?.slug}`);
  const raw: (LiveBucket & { loN: number; hiN: number })[] = [];
  let nClob = 0;
  for (const m of rawEvent.markets ?? []) {
    const pb = parseBucket(m.groupItemTitle ?? "");
    if (!pb) {
      warnings.push(`unparsed bucket "${m.groupItemTitle}"`);
      continue;
    }
    const tok = (m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [])[0] as string;
    const c = clob?.get(tok);
    const bid = c ? c.bid : num(m.bestBid);
    const ask = c ? c.ask : num(m.bestAsk);
    if (c) nClob++;
    const outcome = m.outcomePrices ? num(JSON.parse(m.outcomePrices)[0]) : null;
    const last = num(m.lastTradePrice);
    const bp = bucketPrice(bid, ask, last, outcome, opts.maxSpreadForMid);
    if (m.closed || m.acceptingOrders === false) warnings.push(`bucket "${m.groupItemTitle}" not accepting orders`);
    raw.push({
      label: m.groupItemTitle,
      lo: Number.isFinite(pb.lo) ? pb.lo : null,
      hi: Number.isFinite(pb.hi) ? pb.hi : null,
      loN: pb.lo,
      hiN: pb.hi,
      yesToken: tok,
      marketSlug: m.slug ?? "",
      bestBid: bid,
      bestAsk: ask,
      last,
      outcome,
      spread: bp.spread === null ? null : +bp.spread.toFixed(6),
      price: bp.price,
      priceSource: bp.priceSource,
      quoteSource: c ? "clob" : "gamma",
      illiquid: bp.illiquid,
      acceptingOrders: m.acceptingOrders !== false && !m.closed,
      liquidity: num(m.liquidityNum) ?? 0,
      p: 0,
    });
  }
  raw.sort((a, b) => a.loN - b.loN);
  // contiguity of the integer grid
  for (let i = 1; i < raw.length; i++) if (raw[i - 1].hiN + 1 !== raw[i].loN) warnings.push(`grid gap between "${raw[i - 1].label}" and "${raw[i].label}"`);
  if (raw.length && Number.isFinite(raw[0].loN)) warnings.push(`no "or below" bucket (lowest is "${raw[0].label}")`);
  if (raw.length && Number.isFinite(raw[raw.length - 1].hiN)) warnings.push(`no "or higher" bucket (highest is "${raw[raw.length - 1].label}")`);
  const sumRaw = raw.reduce((s, b) => s + b.price, 0);
  if (!(sumRaw >= opts.sumMin && sumRaw <= opts.sumMax)) warnings.push(`bucket prices sum to ${sumRaw.toFixed(3)} (outside ${opts.sumMin}..${opts.sumMax})`);
  for (const b of raw) b.p = sumRaw > 0 ? b.price / sumRaw : 0;
  const ladder: Record<string, number> = {};
  const strikes = raw.map((b) => b.loN).filter((v) => Number.isFinite(v));
  for (const k of strikes) ladder[k] = +raw.filter((b) => b.loN >= k).reduce((s, b) => s + b.p, 0).toFixed(6);
  let median: number | null = null;
  if (strikes.length) {
    const above = strikes.filter((k) => ladder[k] >= 0.5);
    median = above.length ? Math.max(...above) : strikes[0] - 1;
  }
  const mean = raw.length ? raw.reduce((s, b) => s + b.p * repr(b.loN, b.hiN), 0) : null;
  const sd = mean === null ? null : Math.sqrt(raw.reduce((s, b) => s + b.p * (repr(b.loN, b.hiN) - mean) ** 2, 0));
  if (ev.unit !== "C") warnings.push(`unit is °${ev.unit}`);
  if (ev.closed) warnings.push("event closed");
  const src = settlementSourceOf(ev, icao);
  if (src.kind !== "station") warnings.push(`Polymarket settles this event on ${src.label}, not ${icao}`);
  const fatal = warnings.some((w) => /gap|outside|unit is|closed|settles this event on|unparsed/.test(w)) || raw.length < 3;
  return {
    station: icao,
    city: st.city,
    date: ev.date,
    slug: ev.slug,
    url: `https://polymarket.com/event/${ev.slug}`,
    apiUrl: `https://gamma-api.polymarket.com/events?slug=${ev.slug}`,
    eventId: ev.id,
    title: ev.title,
    closed: ev.closed,
    volume: Math.round(ev.volume),
    liquidity: Math.round(num(rawEvent.liquidity) ?? 0),
    endDate: ev.endDate,
    settlementSource: src.label,
    unit: ev.unit,
    fetchedAt,
    quoteSource: nClob === raw.length && raw.length ? "clob" : nClob ? "mixed" : "gamma",
    sumRaw: +sumRaw.toFixed(6),
    buckets: raw.map(({ loN: _l, hiN: _h, ...b }) => ({ ...b, p: +b.p.toFixed(6) })),
    ladder,
    strikes,
    median,
    mean: mean === null ? null : +mean.toFixed(3),
    sd: sd === null ? null : +sd.toFixed(3),
    ok: !fatal,
    warnings,
  };
}

/** Live CLOB best bid/ask for many YES tokens in one request. Returns null on failure (caller falls back to Gamma). */
export async function clobBestPrices(tokens: string[], ttlSec = 30): Promise<Map<string, { bid: number | null; ask: number | null }> | null> {
  if (!tokens.length) return new Map();
  try {
    // POST is not cacheable through fetchText, so use fetch directly (tiny body, ~1 req per tick)
    const res = await fetch("https://clob.polymarket.com/prices", {
      method: "POST",
      headers: { "content-type": "application/json", "User-Agent": "isotherm/1.0" },
      body: JSON.stringify(tokens.flatMap((t) => [{ token_id: t, side: "BUY" }, { token_id: t, side: "SELL" }])),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, { BUY?: string; SELL?: string }>;
    void ttlSec;
    const out = new Map<string, { bid: number | null; ask: number | null }>();
    for (const t of tokens) {
      const r = j[t];
      if (!r) continue;
      // CLOB "BUY" price = best bid (what a buyer pays is the ask; the BUY side of the book holds bids)
      out.set(t, { bid: num(r.BUY), ask: num(r.SELL) });
    }
    return out;
  } catch {
    return null;
  }
}

/** Live Polymarket-implied ladder for a station-local date, or null when Polymarket has no such event. The Gamma
 *  GET goes through `get` (Node: the file-cached fetchText; Worker: its own cache), the CLOB batch through fetch. */
export async function fetchLiveLadder(get: TextGetter, icao: string, date: string, opts: LadderOpts & { gammaTtlSec?: number; useClob?: boolean } = {}): Promise<LiveLadder | null> {
  const st = stationOf(icao);
  const slug = eventSlug(st.polymarketSlugCity, date);
  const body = await get(`https://gamma-api.polymarket.com/events?slug=${slug}`, { ttlSec: opts.gammaTtlSec ?? 60, timeoutMs: 20_000, retries: 2 });
  const arr = JSON.parse(body) as any[];
  if (!arr.length) return null;
  const tokens = (arr[0].markets ?? []).map((m: any) => (m.clobTokenIds ? JSON.parse(m.clobTokenIds)[0] : null)).filter(Boolean);
  const clob = opts.useClob === false ? null : await clobBestPrices(tokens);
  const l = ladderFromGamma(arr[0], icao, clob, new Date().toISOString(), opts);
  if (opts.useClob !== false && !clob) l.warnings.push("CLOB /prices unavailable; used Gamma best bid/ask (can lag the book)");
  return l;
}

// ---------------------------------------------------------------- helpers over a ladder
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** P(Tmax >= k): exact where the grid determines it, else a bounded normal-fit extrapolation (determined=false). */
export function pAtLeast(l: Pick<LiveLadder, "ladder" | "strikes" | "mean" | "sd">, k: number): { p: number; determined: boolean } {
  if (l.ladder[k] !== undefined) return { p: l.ladder[k], determined: true };
  if (!l.strikes.length || l.mean === null || l.sd === null) return { p: NaN, determined: false };
  const lo = l.strikes[0], hi = l.strikes[l.strikes.length - 1];
  const nrm = 1 - normalCdf((k - 0.5 - l.mean) / Math.max(l.sd, 0.5));
  if (k < lo) return { p: Math.max(l.ladder[lo], nrm), determined: false };
  if (k > hi) return { p: Math.min(l.ladder[hi], nrm), determined: false };
  return { p: nrm, determined: false }; // inside a multi-degree bucket
}

export interface StrikePolicy {
  count: number; // target number of strikes (4..6); in mode "nearest" the MAXIMUM
  minCount: number; // never go below this when trimming edge strikes (not used by mode "nearest")
  /** "window": the most uncertain consecutive window, then edge trimming down to minCount. "offsets": median + offsets.
   *  "nearest": at most `count` strikes nearest the Polymarket median among those whose implied P(>=k) lies inside
   *  [minP, maxP]; strikes outside the band are skipped even if fewer than minCount remain (a near-certain strike
   *  costs a Kuru market, mints and margin for quotes that would be pulled). */
  mode: "window" | "offsets" | "nearest";
  offsets?: number[]; // relative to the median, for mode "offsets"
  minP: number; // trim edge strikes whose implied P is outside [minP, maxP]
  maxP: number;
}
export const DEFAULT_STRIKE_POLICY: StrikePolicy = { count: 5, minCount: 4, mode: "window", minP: 0.03, maxP: 0.97 };

/** Integer strikes around the Polymarket median. Window mode: the `count` consecutive determined strikes that
 *  maximise sum p(1-p) (most uncertain), ties toward the median; then trim edges outside [minP, maxP]. Nearest mode:
 *  at most `count` in-band strikes nearest the median (see StrikePolicy.mode). */
export function pickStrikes(l: Pick<LiveLadder, "ladder" | "strikes" | "median">, pol: Partial<StrikePolicy> = {}): number[] {
  const P = { ...DEFAULT_STRIKE_POLICY, ...pol };
  const ks = l.strikes;
  if (!ks.length) return [];
  let pick: number[];
  if (P.mode === "nearest") {
    // in-band strikes, nearest the median first (ties: the more uncertain one, i.e. larger p(1-p)). P(>=k) is monotone
    // in k, so the in-band strikes are consecutive and the nearest `count` of them are consecutive too.
    const m = l.median ?? ks[Math.floor(ks.length / 2)];
    const band = ks.filter((k) => Number.isFinite(l.ladder[k]) && l.ladder[k] >= P.minP && l.ladder[k] <= P.maxP);
    const unc = (k: number) => l.ladder[k] * (1 - l.ladder[k]);
    return band
      .sort((a, b) => Math.abs(a - m) - Math.abs(b - m) || unc(b) - unc(a) || a - b)
      .slice(0, Math.max(0, P.count))
      .sort((a, b) => a - b);
  }
  if (P.mode === "offsets" && P.offsets?.length) {
    const m = l.median ?? ks[Math.floor(ks.length / 2)];
    pick = P.offsets.map((d) => m + d).filter((k) => l.ladder[k] !== undefined);
  } else {
    const n = Math.min(P.count, ks.length);
    let best: { s: number; d: number; w: number[] } | null = null;
    for (let i = 0; i + n <= ks.length; i++) {
      const w = ks.slice(i, i + n);
      if (w[w.length - 1] - w[0] !== n - 1) continue; // consecutive integers only
      const s = w.reduce((a, k) => a + l.ladder[k] * (1 - l.ladder[k]), 0);
      const d = Math.abs((w[0] + w[w.length - 1]) / 2 - (l.median ?? 0));
      if (!best || s > best.s + 1e-9 || (Math.abs(s - best.s) <= 1e-9 && d < best.d)) best = { s, d, w };
    }
    pick = best?.w ?? ks.slice(0, n);
  }
  const inBand = (k: number) => l.ladder[k] >= P.minP && l.ladder[k] <= P.maxP;
  while (pick.length > P.minCount) {
    const a = pick[0], b = pick[pick.length - 1];
    const badA = !inBand(a), badB = !inBand(b);
    if (!badA && !badB) break;
    // drop the edge that is further outside the band
    const dist = (k: number) => (l.ladder[k] < P.minP ? P.minP - l.ladder[k] : l.ladder[k] > P.maxP ? l.ladder[k] - P.maxP : 0);
    if (dist(a) >= dist(b)) pick = pick.slice(1);
    else pick = pick.slice(0, -1);
  }
  return pick;
}
