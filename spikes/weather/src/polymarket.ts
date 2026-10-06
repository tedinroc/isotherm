// Polymarket daily "Highest temperature in <city> on <date>?" events (gamma API) + CLOB price history.
import { fetchJson, pmap } from "./http.ts";

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
  descriptionHead: string; // first ~900 chars (resolution rule text)
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

function toEvent(e: any): PmEvent | null {
  const date = slugDate(e.slug);
  if (!date) return null;
  const buckets: Bucket[] = [];
  let unit: "C" | "F" = "C";
  for (const m of e.markets ?? []) {
    const pb = parseBucket(m.groupItemTitle ?? "");
    if (!pb) {
      console.warn(`[pm] unparsed bucket "${m.groupItemTitle}" in ${e.slug}`);
      continue;
    }
    unit = pb.unit;
    const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
    const toks = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
    buckets.push({
      label: m.groupItemTitle,
      lo: pb.lo,
      hi: pb.hi,
      yesToken: toks[0],
      finalYes: prices ? Number(prices[0]) : null,
      conditionId: m.conditionId,
    });
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

/** Every event in a recurring series (paged). Closed events are immutable -> cached forever by date-bounded queries. */
export async function seriesEvents(seriesId: string): Promise<PmEvent[]> {
  const out: PmEvent[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const url = `https://gamma-api.polymarket.com/events?series_id=${seriesId}&limit=100&offset=${offset}&order=endDate&ascending=true`;
    // pages near the end change daily; keep TTL short for all pages (cheap: ~4 calls)
    const page = await fetchJson<any[]>(url, { ttlSec: 3600 });
    for (const e of page) {
      const ev = toEvent(e);
      if (ev) out.push(ev);
    }
    if (page.length < 100) break;
  }
  const byDate = new Map<string, PmEvent>();
  for (const e of out) byDate.set(e.date, e); // one event per date
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function eventBySlug(slug: string, ttlSec = 600): Promise<PmEvent | null> {
  const r = await fetchJson<any[]>(`https://gamma-api.polymarket.com/events?slug=${slug}`, { ttlSec });
  return r.length ? toEvent(r[0]) : null;
}

export function eventSlug(city: string, date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `highest-temperature-in-${city}-on-${MONTHS[m - 1]}-${d}-${y}`;
}

/** Which physical source settles this event, from its rule text. */
export function settlementSourceOf(ev: PmEvent, icao: string): { kind: "station" | "other"; label: string } {
  const txt = (ev.resolutionSource + " " + ev.descriptionHead).toLowerCase();
  const id = icao.toLowerCase();
  if (txt.includes("wunderground.com") && txt.includes(id)) return { kind: "station", label: `wunderground:${icao}` };
  if (txt.includes("weather.gov/wrh/timeseries") && txt.includes(id)) return { kind: "station", label: `noaa-timeseries:${icao}` };
  const m = txt.match(/https?:\/\/[^\s)]+/);
  return { kind: "other", label: m ? m[0] : "unknown" };
}

// ---------------------------------------------------------------- prices
export interface PricePt {
  t: number; // unix seconds
  p: number;
}

/** Hourly YES price history for one bucket. Immutable once the event is closed. */
export async function priceHistory(token: string, startTs: number, endTs: number, closed: boolean): Promise<PricePt[]> {
  const url = `https://clob.polymarket.com/prices-history?market=${token}&startTs=${startTs}&endTs=${endTs}&fidelity=60`;
  const r = await fetchJson<{ history: PricePt[] }>(url, { ttlSec: closed ? Infinity : 900 });
  return r.history ?? [];
}

/** Last price at or before tsSec (null if the market has no print yet). */
export function priceAt(h: PricePt[], tsSec: number): number | null {
  let p: number | null = null;
  for (const x of h) {
    if (x.t <= tsSec) p = x.p;
    else break;
  }
  return p;
}

export async function eventPriceHistories(ev: PmEvent): Promise<Map<string, PricePt[]>> {
  const start = Math.floor(Date.parse(ev.startDate) / 1000) - 3600;
  const end = Math.floor(Date.parse(ev.endDate) / 1000) + 2 * 86400;
  const hs = await pmap(ev.buckets, 4, (b) => priceHistory(b.yesToken, start, end, ev.closed));
  return new Map(ev.buckets.map((b, i) => [b.label, hs[i]]));
}

/**
 * Polymarket-implied ladder at time tsSec: bucket YES prices normalised to sum 1, then
 * P(Tmax >= k) for every k whose value is fully determined by the bucket grid.
 */
export function impliedLadder(ev: PmEvent, hist: Map<string, PricePt[]>, tsSec: number) {
  const raw = ev.buckets.map((b) => ({ b, p: priceAt(hist.get(b.label) ?? [], tsSec) }));
  if (raw.some((x) => x.p === null)) return null;
  const sum = raw.reduce((s, x) => s + (x.p as number), 0);
  if (!(sum > 0.5 && sum < 1.6)) return null; // broken snapshot
  const probs = raw.map((x) => ({ lo: x.b.lo, hi: x.b.hi, label: x.b.label, p: (x.p as number) / sum }));
  const ladder: Record<number, number> = {};
  const finiteLos = probs.map((x) => x.lo).filter((v) => Number.isFinite(v));
  for (const k of finiteLos) ladder[k] = probs.filter((x) => x.lo >= k).reduce((s, x) => s + x.p, 0);
  return { sumRaw: sum, buckets: probs, ladder };
}
