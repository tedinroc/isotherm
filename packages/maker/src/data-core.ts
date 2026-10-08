// Market-data contract for the maker (runtime-agnostic: no Node APIs). The tick and the roll only see this
// interface: the Node runner implements it with packages/forecast's file-cached fetchers (data.ts liveMarketData),
// the Cloudflare Worker with its own fetcher (apps/maker-worker), and the tests with deterministic stubs.
import type { LiveLadder } from "../../forecast/src/polymarket-core.ts";
import type { ObservedMax } from "../../forecast/src/obs-core.ts";
import type { V0Ladder } from "../../forecast/src/v0-core.ts";
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
