// Live v0 model ladder (the GUARDRAIL / FALLBACK, not the quote source). The model lives in v0-core.ts (re-exported
// here); this file binds it to the Node file-cached fetchText and the seed files in data/daily_<ICAO>.json.
// Backtest (spikes/weather): v0 lead-1 Brier 0.0656 vs Polymarket D-1 23:00 0.0594 -> Polymarket is better.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Obs as DailyObs } from "./forecast.ts";
import { fetchText, ROOT } from "./http.ts";
import { dailyHistoryWith, v0LadderWith, type V0Io, type V0Ladder } from "./v0-core.ts";

export * from "./v0-core.ts";

const nodeIo: V0Io = {
  get: fetchText,
  seedDaily(icao) {
    const seed = join(ROOT, "data", `daily_${icao}.json`);
    return existsSync(seed) ? (JSON.parse(readFileSync(seed, "utf8")) as any[]) : null;
  },
};

/** Daily settlement maxima: seeded from data/daily_<ICAO>.json, refreshed with the last ~3 weeks from IEM. */
export async function dailyHistory(icao: string, nowMs = Date.now()): Promise<DailyObs> {
  return dailyHistoryWith(nodeIo, icao, nowMs);
}

/** v0 ladder for a station-local date. Cached in memory for `maxAgeSec`. */
export async function v0Ladder(icao: string, date: string, nowMs = Date.now(), maxAgeSec = 3600): Promise<V0Ladder | null> {
  return v0LadderWith(nodeIo, icao, date, nowMs, maxAgeSec);
}
