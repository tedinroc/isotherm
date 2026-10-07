// Market data for the maker: Polymarket-implied ladder, observed max so far, v0 guard, intraday increment table.
// Live provider = packages/forecast (relative import; no workspaces). Tests inject a stub with the same shape.
import { livePolymarketLadder, type LiveLadder } from "../../forecast/src/polymarket.ts";
import { observedMaxSoFar, type ObservedMax } from "../../forecast/src/obs.ts";
import { v0Ladder, type V0Ladder } from "../../forecast/src/v0.ts";
import { loadCloseTime } from "../../forecast/src/close-config.ts";
import type { CloseTimeStats } from "../../forecast/src/closetime.ts";
import { localDayUtcRange, station } from "../../forecast/src/stations.ts";

export interface LadderData {
  pm: LiveLadder | null;
  pmFetchedMs: number | null;
  pmError?: string;
  obs: ObservedMax | null;
  v0: V0Ladder | null;
  v0Error?: string;
  intraday: CloseTimeStats | null;
  localMinute: number | null; // minutes after local midnight if `isoDate` is the station's today
}

export interface MarketData {
  get(stationIcao: string, isoDate: string, nowMs: number): Promise<LadderData>;
}

export function localMinuteOf(stationIcao: string, isoDate: string, nowMs: number): number | null {
  const [s, e] = localDayUtcRange(isoDate, station(stationIcao).utcOffsetMin);
  return nowMs >= s && nowMs < e ? Math.floor((nowMs - s) / 60_000) : null;
}

export function liveMarketData(opts: { pmTtlSec: number; obsTtlSec: number; v0RefreshSec: number }): MarketData {
  const lastPm = new Map<string, { l: LiveLadder; at: number }>();
  return {
    async get(icao, isoDate, nowMs) {
      const key = `${icao}:${isoDate}`;
      let pm: LiveLadder | null = null, pmFetchedMs: number | null = null, pmError: string | undefined;
      try {
        pm = await livePolymarketLadder(icao, isoDate, { gammaTtlSec: opts.pmTtlSec });
        if (pm) lastPm.set(key, { l: pm, at: Date.parse(pm.fetchedAt) });
        pmFetchedMs = pm ? Date.parse(pm.fetchedAt) : null;
      } catch (e) {
        pmError = String((e as Error).message ?? e).slice(0, 200);
        const prev = lastPm.get(key); // keep the last good ladder; fair.ts decides whether it is still fresh enough
        if (prev) (pm = prev.l), (pmFetchedMs = prev.at);
      }
      let v0: V0Ladder | null = null, v0Error: string | undefined;
      try {
        v0 = await v0Ladder(icao, isoDate, nowMs, opts.v0RefreshSec);
      } catch (e) {
        v0Error = String((e as Error).message ?? e).slice(0, 200);
      }
      const obs = await observedMaxSoFar(icao, isoDate, nowMs, opts.obsTtlSec);
      return { pm, pmFetchedMs, pmError, obs, v0, v0Error, intraday: loadCloseTime()?.stations[icao] ?? null, localMinute: localMinuteOf(icao, isoDate, nowMs) };
    },
  };
}
