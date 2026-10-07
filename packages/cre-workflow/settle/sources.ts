// The three METAR sources, wired to the validated settlement core (settle-core.ts, byte-identical to
// packages/forecast/src/settle-core.ts and spikes/weather/src/settle-core.ts).
//
// Each source is fetched in CRE *node mode*: every DON node downloads and parses it on its own, reduces it to a
// small numeric Observation, and the DON agrees on the per-field median (BFT against a lying or broken node).
// The agreed Observation is turned back into settle-core's DayStats, and settle-core's decide() runs on that.
import type { HTTPSendRequester } from '@chainlink/cre-sdk'
import {
  awcDayUrl,
  type DayStats,
  dayStats,
  iemDayUrl,
  type Ob,
  ogimetDayUrl,
  parseAwcJson,
  parseIemCsv,
  parseOgimetText,
} from './settle-core'

export type SourceKind = 'iem' | 'awc' | 'ogimet'
export const SOURCE_NAME = { iem: 'IEM', awc: 'AWC', ogimet: 'OGIMET' } as const

/** What each node reports to consensus. All integers; -999 / -1 encode "none". */
export type Observation = {
  tmaxC: number // -999 when no report in the window
  nObs: number
  nHours: number // distinct local clock hours with a report
  lastMin: number // minutes after local midnight of the last report, -1 when none
  httpStatus: number // 0 = transport error
  healthy: number // 1 = the response looked like a genuine archive answer (possibly empty); 0 = error/timeout/throttle
}

export type FetchArgs = { kind: SourceKind; url: string; ymd: string; utcOffsetMin: number }

export const sourceUrl = (kind: SourceKind, icao: string, ymd: string, utcOffsetMin: number, tzName: string): string => {
  if (kind === 'iem') return iemDayUrl(icao, ymd, tzName)
  if (kind === 'awc') return awcDayUrl(icao, ymd, utcOffsetMin)
  return ogimetDayUrl(icao, ymd, utcOffsetMin)
}

const parse = (kind: SourceKind, body: string, utcOffsetMin: number): Ob[] => {
  if (kind === 'iem') return parseIemCsv(body, utcOffsetMin)
  if (kind === 'awc') return parseAwcJson(body)
  return parseOgimetText(body)
}

const lastLocalToMin = (s: string | null): number => (s === null ? -1 : Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)))
const pad2 = (n: number) => (n < 10 ? '0' : '') + n

export const NO_DATA: Observation = { tmaxC: -999, nObs: 0, nHours: 0, lastMin: -1, httpStatus: 0, healthy: 0 }

/**
 * Did the source answer like an archive (even an empty one), as opposed to an error page, a throttle notice or a
 * timeout? Only answers from healthy sources may justify a VOID: a fetch failure must never void a ladder.
 *   IEM: the CSV header.  AWC: an empty body (documented "no data") or a JSON array.
 *   Ogimet: only "ICAO,YYYY,..." lines (its quota notice is plain text with HTTP 200); an empty body is ambiguous.
 */
export const looksHealthy = (kind: SourceKind, body: string): boolean => {
  const b = body.trim()
  if (kind === 'iem') return b.startsWith('station,valid,metar')
  if (kind === 'awc') {
    if (b === '') return true
    if (!b.startsWith('[')) return false
    try {
      return Array.isArray(JSON.parse(b))
    } catch {
      return false
    }
  }
  const lines = b.split('\n').filter((l) => l.trim() !== '')
  return lines.length > 0 && lines.every((l) => /^[A-Z0-9]{4},\d{4},\d{2},\d{2},\d{2},\d{2},/.test(l))
}

/** Pure: response body -> Observation, through settle-core's parser and dayStats(). Never throws. */
/** AWC's definitive "no data" answers: 204 / empty body, or 400 "Data is available for up to 30 days" (captured 2026-10-07). */
export const awcDefinitelyEmpty = (httpStatus: number, body: string): boolean =>
  httpStatus === 204 || (httpStatus === 400 && /available for up to \d+ days/i.test(body))

export const observe = (kind: SourceKind, body: string, ymd: string, utcOffsetMin: number, httpStatus = 200): Observation => {
  if (kind === 'awc' && awcDefinitelyEmpty(httpStatus, body)) return { ...NO_DATA, httpStatus, healthy: 1 }
  if (httpStatus !== 200) return { ...NO_DATA, httpStatus }
  const healthy = looksHealthy(kind, body) ? 1 : 0
  let s: DayStats
  try {
    s = dayStats(parse(kind, body, utcOffsetMin), ymd, utcOffsetMin)
  } catch {
    return { ...NO_DATA, httpStatus } // unparseable body (e.g. an HTML error page) = no data, unhealthy
  }
  return { tmaxC: s.tmaxC ?? -999, nObs: s.nObs, nHours: s.nHours, lastMin: lastLocalToMin(s.lastLocal), httpStatus, healthy }
}

/**
 * DON-agreed Observation -> settle-core DayStats. `complete` is recomputed with settle-core's exact rule
 * (>= 20 distinct local hours AND last report at or after 23:00 local). A non-integer field means the median fell
 * between two disagreeing nodes: that source is treated as incomplete (never settle on a split DON).
 */
export type SourceStats = DayStats & { split: boolean; healthy: boolean }

export const toDayStats = (o: Observation): SourceStats => {
  const fields = [o.tmaxC, o.nObs, o.nHours, o.lastMin]
  const healthy = o.healthy === 1 // a split (0.5) or 0 is unhealthy
  if (!fields.every(Number.isInteger)) return { tmaxC: null, nObs: 0, nHours: 0, lastLocal: null, complete: false, split: true, healthy: false }
  if (o.nObs <= 0 || o.tmaxC === -999 || o.lastMin < 0) {
    return { tmaxC: null, nObs: 0, nHours: 0, lastLocal: null, complete: false, split: false, healthy }
  }
  return {
    tmaxC: o.tmaxC,
    nObs: o.nObs,
    nHours: o.nHours,
    lastLocal: `${pad2(Math.floor(o.lastMin / 60))}:${pad2(o.lastMin % 60)}`,
    complete: o.nHours >= 20 && o.lastMin >= 23 * 60,
    split: false,
    healthy,
  }
}

const decoder = new TextDecoder()

/** Node-mode fetcher: one HTTP GET, parsed locally. Never throws, so one dead source cannot abort the run. */
export const fetchSource = (req: HTTPSendRequester, a: FetchArgs): Observation => {
  let status = 0
  let body = ''
  try {
    const resp = req.sendRequest({ url: a.url, method: 'GET' }).result()
    status = resp.statusCode
    body = decoder.decode(resp.body)
  } catch {
    return { ...NO_DATA }
  }
  return observe(a.kind, body, a.ymd, a.utcOffsetMin, status)
}
