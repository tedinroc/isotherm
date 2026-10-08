// Reads results/close_time.json (written by scripts/close-time.ts) and turns it into a concrete close time for a
// station-local date: vault closeTime (minting stops) and the maker's stop-quoting time (kill switch).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./http.ts";
import { closeFromStats, type CloseRecommendation, type CloseTimeStats } from "./closetime.ts";

let cache: { stations: Record<string, CloseTimeStats> } | null = null;

export function loadCloseTime(file = join(ROOT, "results", "close_time.json")): { stations: Record<string, CloseTimeStats> } | null {
  if (cache) return cache;
  if (!existsSync(file)) return null;
  cache = JSON.parse(readFileSync(file, "utf8"));
  return cache;
}

/** Concrete close for a station-local date from results/close_time.json (closetime.ts closeFromStats, pure). */
export function closeFor(icao: string, date: string, marginMin = 10): CloseRecommendation & { closeUtcMs: number; stopUtcMs: number; dayEndUtcMs: number } {
  return closeFromStats(loadCloseTime()?.stations[icao], icao, date, marginMin);
}
