// The per-strike view shared by `weather quote` and `weather edge`:
// our Kuru book (bid/ask/depth) | Polymarket-implied P(Tmax >= k) | v0-lite guardrail | observed max so far.
import type { Address } from "viem";
import type { City } from "./config.js";
import { findLadder, type Env } from "./cmd.js";
import { readBooks, resolveMarket, type Ladder, type MarketCheck } from "./isotherm.js";
import { humanBook, type L2 } from "./kuru.js";
import { GUARDRAIL_GAP, impliedAt, isoOf, localDate, observedMax, parseDateArg, polymarketImplied, v0Forecast, v0Prob, type Observed, type PmLadder, type V0 } from "./weather.js";
import { isoUtc, round3, round4 } from "./util.js";

export type StrikeRow = {
  strike: string;
  strikeC: number;
  seriesId: string | null;
  market: Address | null;
  canonical: boolean;
  book: { bestBid: number | null; bestAsk: number | null; bidSize: number | null; askSize: number | null; mid: number | null; spread: number | null } | null;
  polymarketImplied: number | null;
  v0Guardrail: number | null;
  observedLocked: boolean; // observed max so far already >= k (pending official settlement)
  guardrailFlag: boolean; // |v0 - Polymarket| > 0.15
  takerFeeBps: number | null;
};

export type QuoteView = {
  city: string;
  station: string;
  date: string;
  ladder: { state: Ladder["state"]; closeTime: string; dayEnd: string; result: unknown } | null;
  polymarket: { slug: string; url: string; volumeUsd: number; sumMid: number; closed: boolean } | null;
  v0: Pick<V0, "name" | "mu" | "sigma" | "models"> | null;
  observed: Observed | null;
  rows: StrikeRow[];
  notes: string[];
};

export async function buildQuoteView(env: Env, city: City, rawDate: unknown): Promise<QuoteView> {
  const notes: string[] = [];
  const ladder = await findLadder(env, city, rawDate);
  const date = ladder?.date ?? parseDateArg(rawDate ? String(rawDate) : "tomorrow", city) ?? localDate(Date.now(), city.utcOffsetMin);
  if (!ladder) notes.push(`No Isotherm ladder is listed for ${city.station} ${isoOf(date)}; showing reference prices only.`);

  const [pmR, v0R, obsR] = await Promise.all([polymarketImplied(city, date), v0Forecast(city, date), observedMax(city, date)]);
  for (const e of [pmR.error, v0R.error, obsR.error]) if (e) notes.push(e);
  const pm: PmLadder | null = pmR.pm;
  const v0 = v0R.v0;
  const obs = obsR.obs;
  const obsMax = obs && obs.status !== "future" ? obs.maxC : null;

  let strikes: number[];
  let checks: MarketCheck[] = [];
  let books: (L2 | null)[] = [];
  if (ladder) {
    strikes = ladder.series.map((s) => s.strikeC);
    checks = await Promise.all(ladder.series.map((s) => resolveMarket(env.reader.client, env.dep, env.c, s)));
    const mk = checks.map((m) => m.market).filter((m): m is Address => !!m);
    const b = await readBooks(env.reader.client, env.dep, mk);
    let j = 0;
    books = checks.map((m) => (m.market ? b[j++] : null));
  } else {
    const grid = pm ? Object.keys(pm.ladder).map(Number) : [];
    const c = v0 ? Math.round(v0.mu) : 28;
    strikes = grid.length ? grid.sort((a, b) => a - b) : Array.from({ length: 7 }, (_, i) => c - 3 + i);
  }

  const rows: StrikeRow[] = strikes.map((k, idx) => {
    const m = checks[idx];
    const b = books[idx];
    const hb = b && m?.params ? humanBook(b, m.params, 1) : null;
    const bid = hb?.bestBid ?? null;
    const ask = hb?.bestAsk ?? null;
    const pmP = impliedAt(pm, k);
    const v0P = v0 ? v0Prob(v0.mu, v0.sigma, k, obsMax) : null;
    return {
      strike: `Tmax>=${k}C`,
      strikeC: k,
      seriesId: ladder ? ladder.series[idx].seriesId : null,
      market: m?.market ?? null,
      canonical: m?.canonical ?? false,
      book: hb
        ? {
            bestBid: bid,
            bestAsk: ask,
            bidSize: hb.bids[0]?.size ?? null,
            askSize: hb.asks[0]?.size ?? null,
            mid: bid !== null && ask !== null ? round4((bid + ask) / 2) : null,
            spread: bid !== null && ask !== null ? round4(ask - bid) : null,
          }
        : null,
      polymarketImplied: pmP === null ? null : round3(pmP),
      v0Guardrail: v0P === null ? null : round3(v0P),
      observedLocked: obsMax !== null && obsMax >= k,
      guardrailFlag: pmP !== null && v0P !== null && Math.abs(pmP - v0P) > GUARDRAIL_GAP,
      takerFeeBps: m?.params ? Number(m.params.takerFeeBps) : null,
    };
  });

  return {
    city: city.name,
    station: city.station,
    date: isoOf(date),
    ladder: ladder
      ? {
          state: ladder.state,
          closeTime: isoUtc(ladder.closeTime),
          dayEnd: isoUtc(ladder.dayEnd),
          result: ladder.result.status === "none" ? null : { status: ladder.result.status, tmaxC: ladder.result.tmaxC },
        }
      : null,
    polymarket: pm ? { slug: pm.slug, url: pm.url, volumeUsd: pm.volumeUsd, sumMid: pm.sumMid, closed: pm.closed } : null,
    v0: v0 ? { name: v0.name, mu: v0.mu, sigma: v0.sigma, models: v0.models } : null,
    observed: obs,
    rows,
    notes,
  };
}

export const DISCLAIMER = [
  "Testnet only: Monad testnet 10143 with faucet AUSD. Nothing here is real money or financial advice.",
  "Polymarket-implied P is the normalised mid of Polymarket's bucket prices summed over buckets >= k: a reference price from another venue, not a forecast.",
  "Isotherm's own v0 forecast loses to Polymarket in backtest (Brier 0.0656 vs 0.0594, 381 station-days); it is shown only as a guardrail. No forecasting edge is claimed.",
  "Settlement: official integer °C METAR max for the station-local day incl. SPECI and :30 reports; this rule matches Polymarket on 183/184 RCSS days and 209/209 RJTT days.",
];
