// MarketData for the Worker: the same three inputs as the Node runner (packages/maker data.ts), through the shared
// forecast cores with the Worker's fetcher:
//   - Polymarket-implied P(Tmax >= k): fetchLiveLadder (Gamma structure + one CLOB /prices batch),
//   - the observed max so far (AWC + IEM METARs): observedMaxWith -> fair conditioning and "certain" pulls,
//   - the guardrail: v0LadderWith (Open-Meteo + 2-year history seed) and the intraday increment table.
// The last good Polymarket ladder is kept (fair.ts decides whether it is still fresh); v0 is recomputed at most every
// loop.v0RefreshSec and the result is kept in the Durable Object across isolate restarts.
import { fetchLiveLadder, type LiveLadder } from "../../../packages/forecast/src/polymarket-core.ts";
import { observedMaxWith } from "../../../packages/forecast/src/obs-core.ts";
import { v0LadderWith, type V0Io, type V0Ladder } from "../../../packages/forecast/src/v0-core.ts";
import type { CloseTimeStats } from "../../../packages/forecast/src/closetime.ts";
import type { TextGetter } from "../../../packages/forecast/src/fetch-types.ts";
import { localMinuteOf, type LadderData, type MarketData } from "../../../packages/maker/src/data-core.ts";
import seedRCSS from "../../../packages/forecast/data/daily_RCSS.json";
import seedRJTT from "../../../packages/forecast/data/daily_RJTT.json";
import type { Store } from "./store.ts";

const SEEDS: Record<string, { date: string; tmaxC: number | null; complete: boolean }[]> = {
  RCSS: seedRCSS as any,
  RJTT: seedRJTT as any,
};

export interface WorkerDataOpts {
  get: TextGetter;
  store: Store;
  closeTimes: Record<string, CloseTimeStats> | null;
  loop: { pmTtlSec: number; obsTtlSec: number; v0RefreshSec: number };
  /** Test-only (loopback forks): fetch LadderData JSON from `${url}?station=..&date=..&now=..` instead. */
  testUrl?: string | null;
  fetch?: typeof fetch;
}

export function workerMarketData(o: WorkerDataOpts): MarketData {
  const lastPm = new Map<string, { l: LiveLadder; at: number }>();
  const io: V0Io = { get: o.get, seedDaily: (icao) => SEEDS[icao] ?? null };
  const doFetch = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return {
    async get(icao, isoDate, nowMs): Promise<LadderData> {
      if (o.testUrl) {
        const r = await doFetch(`${o.testUrl}?station=${icao}&date=${isoDate}&now=${nowMs}`);
        if (!r.ok) throw new Error(`test market data ${r.status}`);
        return (await r.json()) as LadderData;
      }
      const key = `${icao}:${isoDate}`;
      let pm: LiveLadder | null = null, pmFetchedMs: number | null = null, pmError: string | undefined;
      try {
        pm = await fetchLiveLadder(o.get, icao, isoDate, { gammaTtlSec: o.loop.pmTtlSec });
        if (pm) lastPm.set(key, { l: pm, at: Date.parse(pm.fetchedAt) });
        pmFetchedMs = pm ? Date.parse(pm.fetchedAt) : null;
      } catch (e) {
        pmError = String((e as Error).message ?? e).slice(0, 200);
        const prev = lastPm.get(key);
        if (prev) (pm = prev.l), (pmFetchedMs = prev.at);
      }
      let v0: V0Ladder | null = null, v0Error: string | undefined;
      const vKey = `v0:${key}`;
      const cached = o.store.get<{ at: number; v: V0Ladder | null }>(vKey);
      if (cached && (nowMs - cached.at) / 1000 < o.loop.v0RefreshSec) v0 = cached.v;
      else
        try {
          v0 = await v0LadderWith(io, icao, isoDate, nowMs, o.loop.v0RefreshSec);
          o.store.put(vKey, { at: nowMs, v: v0 });
        } catch (e) {
          v0Error = String((e as Error).message ?? e).slice(0, 200);
          if (cached) v0 = cached.v; // an hour-old guard beats none
        }
      const obs = await observedMaxWith(o.get, icao, isoDate, nowMs, o.loop.obsTtlSec);
      return { pm, pmFetchedMs, pmError, obs, v0, v0Error, intraday: o.closeTimes?.[icao] ?? null, localMinute: localMinuteOf(icao, isoDate, nowMs) };
    },
  };
}
