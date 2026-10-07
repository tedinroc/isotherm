// Pure planning helpers: which due ladders to work on in this run, in what order, within CRE quotas.
// No SDK imports, so they are unit-tested directly.
import type { Config, StationCfg } from './config'

export type LadderRef = { station: `0x${string}`; date: number } // as returned by CollateralVault.duePendingLadders

/** "2026-10-05" <- 20261005 (validates the calendar date like StationTime.dayStartUtc). */
export const intToYmd = (date: number): string => {
  const y = Math.floor(date / 10000)
  const m = Math.floor(date / 100) % 100
  const d = date % 100
  const t = Date.UTC(y, m - 1, d)
  const back = new Date(t)
  if (y < 2000 || y > 2199 || back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    throw new Error(`invalid date ${date}`)
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export const ymdToInt = (ymd: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`bad date ${ymd}`)
  const n = Number(ymd.replace(/-/g, ''))
  intToYmd(n)
  return n
}

/** UTC unix seconds at which the station-local day `date` ends (== StationTime.localDayEnd). */
export const dayEndSec = (date: number, utcOffsetMin: number): number => {
  const ymd = intToYmd(date)
  return Date.parse(`${ymd}T00:00:00Z`) / 1000 - utcOffsetMin * 60 + 86400
}

export type Target = {
  icao: string
  date: number // yyyymmdd
  ymd: string
  station: StationCfg
  dayEnd: number // unix s
  pastDeadline: boolean // anchor > dayEnd + voidAfterSec: VOID allowed if still unsettleable AND every source healthy
  pastHardDeadline: boolean // anchor > dayEnd + hardVoidAfterSec: VOID allowed whatever the source health
  source: 'vault' | 'extra'
}

export type Skip = { icao: string; date: number; reason: string; retryAt?: number }

const bytes4ToIcao = (b4: string): string | null => {
  const h = b4.toLowerCase()
  if (!/^0x[0-9a-f]{8}$/.test(h)) return null
  let s = ''
  for (let i = 2; i < 10; i += 2) s += String.fromCharCode(Number.parseInt(h.slice(i, i + 2), 16))
  return /^[A-Z0-9]{4}$/.test(s) ? s : null
}

/**
 * Turns due ladders (+ optional replay targets) into an ordered work list.
 *  - unknown stations are skipped (we cannot fetch them),
 *  - nothing is attempted before dayEnd + settleDelaySec (02:00 local; never earlier than dayEnd + 60 s),
 *  - duplicates are dropped, and the oldest day goes first (closest to its void deadline).
 */
export const planTargets = (
  due: LadderRef[],
  extra: { icao: string; date: number }[],
  cfg: Pick<Config, 'stations' | 'settleDelaySec' | 'voidAfterSec' | 'hardVoidAfterSec'>,
  nowSec: number,
): { targets: Target[]; skipped: Skip[] } => {
  const byIcao = new Map(cfg.stations.map((s) => [s.icao, s]))
  const seen = new Set<string>()
  const targets: Target[] = []
  const skipped: Skip[] = []
  const delay = Math.max(60, cfg.settleDelaySec)
  const consider = (icao: string | null, date: number, source: Target['source'], raw: string) => {
    if (icao === null) {
      skipped.push({ icao: raw, date, reason: 'bad-station-code' })
      return
    }
    const key = `${icao}:${date}`
    if (seen.has(key)) return
    seen.add(key)
    const st = byIcao.get(icao)
    if (!st) {
      skipped.push({ icao, date, reason: 'station-not-configured' })
      return
    }
    let end: number
    try {
      end = dayEndSec(date, st.utcOffsetMin)
    } catch {
      skipped.push({ icao, date, reason: 'bad-date' })
      return
    }
    if (nowSec < end + delay) {
      skipped.push({ icao, date, reason: 'before-settle-window', retryAt: end + delay })
      return
    }
    targets.push({
      icao,
      date,
      ymd: intToYmd(date),
      station: st,
      dayEnd: end,
      pastDeadline: nowSec > end + cfg.voidAfterSec,
      pastHardDeadline: nowSec > end + cfg.hardVoidAfterSec,
      source,
    })
  }
  for (const l of due) consider(bytes4ToIcao(l.station), l.date, 'vault', l.station)
  for (const e of extra) consider(e.icao, e.date, 'extra', e.icao)
  targets.sort((a, b) => a.dayEnd - b.dayEnd || (a.icao < b.icao ? -1 : a.icao > b.icao ? 1 : 0))
  return { targets, skipped }
}

/** Ladder index pages to scan: the newest `ladderScanWindow` ladders at or above `ladderCursorStart`. */
export const ladderPages = (
  ladderCount: number,
  cfg: Pick<Config, 'ladderCursorStart' | 'ladderScanWindow' | 'ladderPageSize'>,
): { start: number; count: number }[] => {
  const start = Math.max(cfg.ladderCursorStart, ladderCount - cfg.ladderScanWindow, 0)
  const pages: { start: number; count: number }[] = []
  for (let s = start; s < ladderCount; s += cfg.ladderPageSize) pages.push({ start: s, count: Math.min(cfg.ladderPageSize, ladderCount - s) })
  return pages
}

/** A per-execution quota counter (HTTP calls, EVM reads, reports). */
export class Budget {
  used = 0
  constructor(
    readonly name: string,
    readonly limit: number,
  ) {}
  get left(): number {
    return this.limit - this.used
  }
  has(n = 1): boolean {
    return this.left >= n
  }
  take(n = 1): void {
    if (!this.has(n)) throw new Error(`${this.name} budget exhausted (${this.used}/${this.limit})`)
    this.used += n
  }
}

/**
 * The run's time anchor in unix seconds = min(cron scheduledExecutionTime, DON time).
 *  - On a deployed DON the scheduled time is identical on every node and never in the future, so the anchor is the
 *    scheduled time: validUntil and the deadline checks are deterministic, and runs from different cron fires sign
 *    windows that cannot overlap (fires >= 30 min apart, TTL 25 min).
 *  - `cre workflow simulate` passes the NEXT fire time of the selected cron (observed: 06:30Z for a 05:48Z run).
 *    Taking the minimum with DON time (runtime.now(), also consensus-derived) keeps validUntil <= sign time + TTL and
 *    stops a simulation from opening the 02:00 settle window or the 36 h void deadline up to an hour early.
 */
export const anchorTimeSec = (
  payload: { scheduledExecutionTime?: { seconds: bigint | number | string } } | undefined,
  nowMs: number,
): { anchor: number; scheduled: number | null; now: number } => {
  const now = Math.floor(nowMs / 1000)
  const s = payload?.scheduledExecutionTime?.seconds
  const scheduled = s !== undefined && s !== null && Number(s) > 0 ? Number(s) : null
  return { anchor: scheduled === null ? now : Math.min(scheduled, now), scheduled, now }
}
