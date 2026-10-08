// Polymarket daily "Highest temperature in <city> on <date>?" events.
//   - history (spike, unchanged): gamma events, bucket parsing, CLOB price history, implied ladder at a past time
//   - LIVE: livePolymarketLadder(station, date) -> Polymarket-implied P(Tmax >= k) for every strike the bucket grid
//     determines, from live CLOB best bid/ask (one batched POST /prices), Gamma as structure + fallback quotes.
// The maker quotes around this ladder. Our own v0 forecast LOSES to Polymarket in backtest (Brier 0.0656 vs 0.0594),
// so it is only a guardrail / fallback. Never present this as a forecasting edge.
// The pure parts (parsing, the live implied ladder, strike picking) live in polymarket-core.ts and are re-exported
// here, so importers of this module are unchanged; this file keeps the Node-only fetchers (file-cached fetchText).
import { fetchJson, fetchText, pmap } from "./http.ts";
import { fetchLiveLadder, toEvent, type LadderOpts, type LiveLadder, type PmEvent, type PricePt } from "./polymarket-core.ts";

export * from "./polymarket-core.ts";

export async function seriesEvents(seriesId: string): Promise<PmEvent[]> {
  const out: PmEvent[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await fetchJson<any[]>(`https://gamma-api.polymarket.com/events?series_id=${seriesId}&limit=100&offset=${offset}&order=endDate&ascending=true`, { ttlSec: 3600 });
    for (const e of page) {
      const ev = toEvent(e);
      if (ev) out.push(ev);
    }
    if (page.length < 100) break;
  }
  const byDate = new Map<string, PmEvent>();
  for (const e of out) byDate.set(e.date, e);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------- price history (spike)
export async function priceHistory(token: string, startTs: number, endTs: number, closed: boolean): Promise<PricePt[]> {
  const url = `https://clob.polymarket.com/prices-history?market=${token}&startTs=${startTs}&endTs=${endTs}&fidelity=60`;
  const r = await fetchJson<{ history: PricePt[] }>(url, { ttlSec: closed ? Infinity : 900 });
  return r.history ?? [];
}
export async function eventPriceHistories(ev: PmEvent): Promise<Map<string, PricePt[]>> {
  const start = Math.floor(Date.parse(ev.startDate) / 1000) - 3600;
  const end = Math.floor(Date.parse(ev.endDate) / 1000) + 2 * 86400;
  const hs = await pmap(ev.buckets, 4, (b) => priceHistory(b.yesToken, start, end, ev.closed));
  return new Map(ev.buckets.map((b, i) => [b.label, hs[i]]));
}

/** Live Polymarket-implied ladder for a station-local date, or null when Polymarket has no such event. */
export async function livePolymarketLadder(icao: string, date: string, opts: LadderOpts & { gammaTtlSec?: number; useClob?: boolean } = {}): Promise<LiveLadder | null> {
  return fetchLiveLadder(fetchText, icao, date, opts);
}
