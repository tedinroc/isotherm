// Reads results/close_time.json (written by scripts/close-time.ts) and turns it into a concrete close time for a
// station-local date: vault closeTime (minting stops) and the maker's stop-quoting time (kill switch).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./http.ts";
import { recommendClose, type CloseRecommendation, type CloseTimeStats } from "./closetime.ts";
import { localTimeToUtcMs, station } from "./stations.ts";

let cache: { stations: Record<string, CloseTimeStats> } | null = null;

export function loadCloseTime(file = join(ROOT, "results", "close_time.json")): { stations: Record<string, CloseTimeStats> } | null {
  if (cache) return cache;
  if (!existsSync(file)) return null;
  cache = JSON.parse(readFileSync(file, "utf8"));
  return cache;
}

/** Fallback when no analysis exists for a station (unvalidated stations): 17:30 local. */
const FALLBACK_CLOSE = "17:30";

export function closeFor(icao: string, date: string, marginMin = 10): CloseRecommendation & { closeUtcMs: number; stopUtcMs: number; dayEndUtcMs: number } {
  const st = station(icao);
  const stats = loadCloseTime()?.stations[icao];
  const month = Number(date.slice(5, 7));
  const rec: CloseRecommendation = stats
    ? recommendClose(stats, month, marginMin)
    : { station: icao, closeLocal: FALLBACK_CLOSE, stopQuotingLocal: "17:20", marginMin, massLeftAtClose: NaN, massLeftAtCloseAllYear: NaN, basis: "no close-time analysis for this station: fixed 17:30 local fallback" };
  const closeUtcMs = localTimeToUtcMs(date, rec.closeLocal, st.utcOffsetMin);
  return { ...rec, stopQuotingLocal: rec.stopQuotingLocal, closeUtcMs, stopUtcMs: closeUtcMs - marginMin * 60_000, dayEndUtcMs: localTimeToUtcMs(date, "24:00", st.utcOffsetMin) };
}
