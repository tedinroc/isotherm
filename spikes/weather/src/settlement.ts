// Settlement runner (Node): fetches the three sources with the exact URLs from settle-core.ts and applies its
// pure decision rule. The CRE workflow does the same fetches (HTTP capability) and calls the same pure functions.
// Empirical fidelity vs Polymarket (results/fidelity_*.json): RCSS 183/184, RJTT 209/209 resolved days.
import { fetchText } from "./http.ts";
import {
  awcDayUrl, dayStats, decide, iemDayUrl, localDayStartUtcMs, ogimetDayUrl, parseAwcJson, parseIemCsv, parseOgimetText,
  type DayStats, type Ob, type Status,
} from "./settle-core.ts";
import { station } from "./stations.ts";

export interface SourceResult extends DayStats {
  source: "iem" | "awc" | "ogimet";
  url: string;
  error?: string;
}
export interface Settlement {
  station: string;
  date: string;
  status: Status;
  tmaxC: number | null;
  sources: SourceResult[];
  reason: string;
}

async function source(name: SourceResult["source"], url: string, parse: (b: string) => Ob[], date: string, off: number, ttlSec: number): Promise<SourceResult> {
  try {
    return { source: name, url, ...dayStats(parse(await fetchText(url, { ttlSec })), date, off) };
  } catch (e) {
    return { source: name, url, tmaxC: null, nObs: 0, nHours: 0, lastLocal: null, complete: false, error: String(e) };
  }
}

/**
 * tmaxC(station, localDate) -> SETTLED value, or PENDING / VOID.
 * voidAfterHours: hours after the end of local day D after which an unresolved day becomes VOID (refund at par).
 */
export async function tmaxC(icao: string, localDate: string, nowMs = Date.now(), voidAfterHours = 36, ttlSec = 600): Promise<Settlement> {
  const st = station(icao);
  const off = st.utcOffsetMin;
  const end = localDayStartUtcMs(localDate, off) + 86_400_000;
  const base = { station: st.icao, date: localDate };
  if (nowMs < end) return { ...base, status: "PENDING", tmaxC: null, sources: [], reason: "local day not over" };
  const primary = [
    await source("iem", iemDayUrl(icao, localDate, st.tzName), (b) => parseIemCsv(b, off), localDate, off, ttlSec),
    await source("awc", awcDayUrl(icao, localDate, off), parseAwcJson, localDate, off, ttlSec),
  ];
  const fallback: SourceResult[] = [];
  if (!(primary[0].complete && primary[1].complete))
    fallback.push(await source("ogimet", ogimetDayUrl(icao, localDate, off), parseOgimetText, localDate, off, ttlSec));
  const d = decide(primary, fallback, nowMs > end + voidAfterHours * 3600_000);
  return { ...base, ...d, sources: [...primary, ...fallback] };
}
