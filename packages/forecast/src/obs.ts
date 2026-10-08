// Observation sources (keyless): Iowa Environmental Mesonet ASOS archive, aviationweather.gov METAR API, Ogimet.
//  - bulk fetchers (archives, used by the close-time analysis and the v0 model's daily history)
//  - observedMaxSoFar(): the intraday running max for a station-local day, used by the maker to condition its fair
//    value (once a METAR shows Tmax >= k, YES on that strike is certain and the maker pulls its quotes).
// The pure parts (URL builders, parsers, daily max, running max) live in obs-core.ts and are re-exported here, so
// importers of this module are unchanged; this file binds them to the Node file-cached fetchText.
import { fetchText } from "./http.ts";
import { iemObsWith, observedMaxWith, ogimetUrl, parseOgimet, type ObservedMax, type Obs } from "./obs-core.ts";

export * from "./obs-core.ts";

/** All IEM obs (METAR+SPECI) whose UTC time is in [fromUtcDate, toUtcDateExcl), chunked by calendar year.
 *  `immutable` forces an infinite TTL (reproducible analyses over a fixed past window). */
export async function iemObs(icao: string, fromUtcDate: string, toUtcDateExcl: string, immutable = false): Promise<Obs[]> {
  return iemObsWith(fetchText, icao, fromUtcDate, toUtcDateExcl, immutable);
}

export async function ogimetObs(icao: string, fromMonth: string, toMonth: string, immutable = false): Promise<Obs[]> {
  const out: Obs[] = [];
  const nowMonth = new Date().toISOString().slice(0, 7);
  for (let ym = fromMonth; ym <= toMonth; ) {
    const [y, m] = ym.split("-").map(Number);
    const begin = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1) - 60_000);
    const text = await fetchText(ogimetUrl(icao, begin, end), { ttlSec: immutable || ym < nowMonth ? Infinity : 1800, timeoutMs: 120_000 });
    if (/limit|excess|quota/i.test(text.slice(0, 300)) && !/METAR/.test(text.slice(0, 300))) throw new Error("ogimet refused: " + text.slice(0, 200));
    out.push(...parseOgimet(text));
    ym = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  }
  return out.sort((a, b) => a.tUtc - b.tUtc);
}

/** Running max of the local day so far, from AWC (fresh) and IEM (lags ~1-2 h). Never throws. */
export async function observedMaxSoFar(icao: string, date: string, nowMs = Date.now(), ttlSec = 120): Promise<ObservedMax> {
  return observedMaxWith(fetchText, icao, date, nowMs, ttlSec);
}
