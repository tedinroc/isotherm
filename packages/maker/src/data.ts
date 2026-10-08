// Market data for the maker: Polymarket-implied ladder, observed max so far, v0 guard, intraday increment table.
// Live provider = packages/forecast (relative import; no workspaces). Tests inject a stub with the same shape.
// The interface and localMinuteOf live in data-core.ts (re-exported here); this file is the Node provider.
import { livePolymarketLadder, type LiveLadder } from "../../forecast/src/polymarket.ts";
import { observedMaxSoFar } from "../../forecast/src/obs.ts";
import { v0Ladder, type V0Ladder } from "../../forecast/src/v0.ts";
import { loadCloseTime } from "../../forecast/src/close-config.ts";
import { localMinuteOf, type MarketData } from "./data-core.ts";

export * from "./data-core.ts";

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
