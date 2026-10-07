// The per-strike view shared by `weather quote` and `weather edge`:
// our Kuru book (bid/ask/depth) | fair value (maker snapshot, else the plugin's live Polymarket read) |
// a clearly labelled guardrail (maker v0, else the plugin's v0-lite) | observed max so far.
import type { Address } from "viem";
import type { City } from "./config.js";
import { findLadder, type Env } from "./cmd.js";
import { readBooks, resolveMarket, type Ladder, type MarketCheck } from "./isotherm.js";
import { humanBook, type L2 } from "./kuru.js";
import { chooseReference, GUARDRAIL_MODELS, GUARDRAIL_ROLE, makerSnapshot, type MakerStrike, type Reference } from "./snapshot.js";
import { impliedAt, isoOf, localDate, observedMax, parseDateArg, polymarketImplied, v0Forecast, v0Prob, type Observed, type PmLadder } from "./weather.js";
import { isoUtc, round3, round4 } from "./util.js";

export type StrikeRow = {
  strike: string;
  strikeC: number;
  seriesId: string | null;
  market: Address | null;
  canonical: boolean;
  book: { bestBid: number | null; bestAsk: number | null; bidSize: number | null; askSize: number | null; mid: number | null; spread: number | null } | null;
  /** Preferred reference price: the fresh maker snapshot's fair value, else the plugin's own Polymarket-implied read. */
  fairValue: number | null;
  fairValueSource: Reference["fairValueSource"];
  fairValueBasis: string | null;
  /** The plugin's own live read of Polymarket's gamma API (normalised mids summed over buckets >= k). */
  polymarketImplied: number | null;
  /** What `edge` compares the book with (Polymarket-based only, never a model). */
  marketRef: number | null;
  marketRefSource: Reference["marketRefSource"];
  maker: { fair: number | null; fairSource: string | null; pmImplied: number | null; quoteBid: number | null; quoteAsk: number | null; mode: string | null; flags: string[] } | null;
  /** GUARDRAIL ONLY (not a forecast, not a fair value): maker v0 when the snapshot is fresh, else the plugin's v0-lite. */
  guardrail: { p: number | null; source: Reference["guardrail"]["source"]; basis: string | null; flag: boolean };
  observedLocked: boolean; // observed max so far already >= k (pending official settlement)
  takerFeeBps: number | null;
};

export type QuoteView = {
  city: string;
  station: string;
  date: string;
  ladder: { state: Ladder["state"]; closeTime: string; dayEnd: string; result: unknown } | null;
  polymarket: { slug: string; url: string; volumeUsd: number; sumMid: number; closed: boolean } | null;
  makerSnapshot: { url: string | null; used: boolean; generatedAt: string | null; ageS: number | null; stale: boolean | null; strikesUsed: number; note: string | null };
  guardrailModel: { role: string; usedFor: string[]; makerV0Mu: number | null; pluginV0Lite: { mu: number; sigma: number; models: Record<string, number>; label: string } | null };
  observed: Observed | null;
  rows: StrikeRow[];
  notes: string[];
};

export async function buildQuoteView(env: Env, city: City, rawDate: unknown): Promise<QuoteView> {
  const notes: string[] = [];
  const ladder = await findLadder(env, city, rawDate);
  const date = ladder?.date ?? parseDateArg(rawDate ? String(rawDate) : "tomorrow", city) ?? localDate(Date.now(), city.utcOffsetMin);
  if (!ladder) notes.push(`No Isotherm ladder is listed for ${city.station} ${isoOf(date)}; showing reference prices only.`);

  const [pmR, v0R, obsR, mkR] = await Promise.all([polymarketImplied(city, date), v0Forecast(city, date), observedMax(city, date), makerSnapshot(city.station, date)]);
  for (const e of [pmR.error, v0R.error, obsR.error]) if (e) notes.push(e);
  const mk = mkR.ladder;
  const mkFresh = mk && !mk.stale ? mk : null;
  let mkNote: string | null = mkR.error ?? null;
  if (mk && mk.stale) mkNote = `maker snapshot is ${mk.ageS}s old (> limit); using the plugin's live Polymarket read instead`;
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
    const mkts = checks.map((m) => m.market).filter((m): m is Address => !!m);
    const b = await readBooks(env.reader.client, env.dep, mkts);
    let j = 0;
    books = checks.map((m) => (m.market ? b[j++] : null));
  } else {
    const grid = pm ? Object.keys(pm.ladder).map(Number) : [];
    const c = v0 ? Math.round(v0.mu) : 28;
    strikes = grid.length ? grid.sort((a, b) => a - b) : Array.from({ length: 7 }, (_, i) => c - 3 + i);
  }

  const mismatched: number[] = [];
  const rows: StrikeRow[] = strikes.map((k, idx) => {
    const m = checks[idx];
    const b = books[idx];
    const hb = b && m?.params ? humanBook(b, m.params, 1) : null;
    const bid = hb?.bestBid ?? null;
    const ask = hb?.bestAsk ?? null;
    const pmP = impliedAt(pm, k);
    const v0P = v0 ? v0Prob(v0.mu, v0.sigma, k, obsMax) : null;
    // A snapshot strike counts only if it describes the same series and book the plugin read on-chain.
    let ms: MakerStrike | null = mkFresh?.strikes.find((x) => x.k === k) ?? null;
    if (ms && ladder) {
      const sid = ladder.series[idx].seriesId.toLowerCase();
      const sameSeries = ms.seriesId === null || ms.seriesId === sid;
      const sameBook = ms.market === null || !m?.market || ms.market.toLowerCase() === m.market.toLowerCase();
      if (!sameSeries || !sameBook) {
        mismatched.push(k);
        ms = null;
      }
    }
    const ref = chooseReference(ms, pmP, v0P);
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
      fairValue: ref.fairValue === null ? null : round4(ref.fairValue),
      fairValueSource: ref.fairValueSource,
      fairValueBasis: ref.fairValueBasis,
      polymarketImplied: pmP === null ? null : round3(pmP),
      marketRef: ref.marketRef === null ? null : round4(ref.marketRef),
      marketRefSource: ref.marketRefSource,
      maker: ms ? { fair: ms.fair, fairSource: ms.fairSource, pmImplied: ms.pmImplied, quoteBid: ms.bid, quoteAsk: ms.ask, mode: ms.mode, flags: ms.flags } : null,
      guardrail: { p: ref.guardrail.p === null ? null : round3(ref.guardrail.p), source: ref.guardrail.source, basis: ref.guardrail.basis, flag: ref.guardrail.flag },
      observedLocked: obsMax !== null && obsMax >= k,
      takerFeeBps: m?.params ? Number(m.params.takerFeeBps) : null,
    };
  });
  if (mismatched.length) notes.push(`maker snapshot ignored for strike(s) ${mismatched.join(", ")}: its seriesId/market differs from this deployment's on-chain series (another deployment or a fork)`);
  const strikesUsed = rows.filter((r) => r.fairValueSource === "maker-snapshot").length;
  const guardSources = [...new Set(rows.map((r) => r.guardrail.source).filter((x): x is NonNullable<typeof x> => !!x))];

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
    makerSnapshot: {
      url: mkR.url,
      used: strikesUsed > 0,
      generatedAt: mk?.generatedAt ?? null,
      ageS: mk?.ageS ?? null,
      stale: mk ? mk.stale : null,
      strikesUsed,
      note: mkNote,
    },
    guardrailModel: {
      role: GUARDRAIL_ROLE,
      usedFor: guardSources.map((g) => `${g}: ${GUARDRAIL_MODELS[g]}`),
      makerV0Mu: mkFresh?.forecastMu ?? null,
      pluginV0Lite: guardSources.includes("plugin-v0-lite") && v0 ? { mu: v0.mu, sigma: v0.sigma, models: v0.models, label: GUARDRAIL_MODELS["plugin-v0-lite"] } : null,
    },
    observed: obs,
    rows,
    notes,
  };
}

export const DISCLAIMER = [
  "Testnet only: Monad testnet 10143 with faucet AUSD. Nothing here is real money or financial advice.",
  "fairValue is the price the house maker quotes around: the Polymarket-implied P(Tmax >= k) from the maker's snapshot (or the plugin's own Polymarket read when the snapshot is missing or stale). fairValueBasis says when the maker fell back to its model because Polymarket had no usable price. It is a reference price, not a forecast.",
  "guardrail is GUARDRAIL ONLY: Isotherm's own v0 forecast loses to Polymarket in backtest (Brier 0.0656 vs 0.0594, 381 station-days). The plugin-local v0-lite fallback is cruder still. No forecasting edge is claimed.",
  "Settlement: official integer °C METAR max for the station-local day incl. SPECI and :30 reports; this rule matches Polymarket on 183/184 RCSS days and 209/209 RJTT days.",
];
