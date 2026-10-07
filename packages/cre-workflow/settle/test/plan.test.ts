import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { type Config, configSchema } from '../config'
import { anchorTimeSec, Budget, dayEndSec, intToYmd, ladderPages, planTargets, ymdToInt } from '../plan'
import { stationToBytes4 } from '../report'
import { testnetConfig } from './helpers'

const cfg = testnetConfig()
const ref = (icao: string, date: number) => ({ station: stationToBytes4(icao) as `0x${string}`, date })

describe('calendar', () => {
  test('dayEndSec == StationTime.localDayEnd', () => {
    expect(dayEndSec(20261005, 480)).toBe(Date.parse('2026-10-05T16:00:00Z') / 1000)
    expect(dayEndSec(20261005, 540)).toBe(Date.parse('2026-10-05T15:00:00Z') / 1000)
    expect(dayEndSec(20241231, 480)).toBe(Date.parse('2024-12-31T16:00:00Z') / 1000)
    expect(dayEndSec(20280229, 540)).toBe(Date.parse('2028-02-29T15:00:00Z') / 1000)
  })
  test('invalid dates are rejected (like StationTime.dayStartUtc)', () => {
    for (const d of [20261301, 20261032, 20270229, 19991231, 22000101, 2026105]) expect(() => intToYmd(d)).toThrow()
    expect(ymdToInt('2026-10-05')).toBe(20261005)
  })
})

describe('planTargets', () => {
  const end05 = dayEndSec(20261005, 480)
  test('oldest first, dedupe, unknown station skipped, nothing before dayEnd + 2 h', () => {
    const now = dayEndSec(20261006, 480) + 7200 // 02:00 Taipei on 10-07
    const due = [ref('RCSS', 20261006), ref('RJTT', 20261006), ref('RCSS', 20261005), ref('RCSS', 20261005), ref('ZGSZ', 20261006)]
    const { targets, skipped } = planTargets(due, [], cfg, now)
    expect(targets.map((t) => `${t.icao}:${t.date}`)).toEqual(['RCSS:20261005', 'RJTT:20261006', 'RCSS:20261006'])
    expect(skipped).toEqual([{ icao: 'ZGSZ', date: 20261006, reason: 'station-not-configured' }])
    expect(targets.every((t) => !t.pastDeadline)).toBe(true)
  })
  test('settle window opens exactly at dayEnd + settleDelaySec (02:00 local)', () => {
    expect(planTargets([ref('RCSS', 20261005)], [], cfg, end05 + 7199).skipped[0]).toMatchObject({ reason: 'before-settle-window', retryAt: end05 + 7200 })
    expect(planTargets([ref('RCSS', 20261005)], [], cfg, end05 + 7200).targets).toHaveLength(1)
  })
  test('never earlier than dayEnd + 60 s even if misconfigured', () => {
    const c = { ...cfg, settleDelaySec: 0 }
    expect(planTargets([ref('RCSS', 20261005)], [], c, end05 + 59).targets).toHaveLength(0)
    expect(planTargets([ref('RCSS', 20261005)], [], c, end05 + 60).targets).toHaveLength(1)
  })
  test('void deadline = dayEnd + 36 h (strictly after)', () => {
    expect(planTargets([ref('RCSS', 20261005)], [], cfg, end05 + 129600).targets[0].pastDeadline).toBe(false)
    expect(planTargets([ref('RCSS', 20261005)], [], cfg, end05 + 129601).targets[0].pastDeadline).toBe(true)
  })
  test('extra (replay) targets join the same queue', () => {
    const { targets } = planTargets([ref('RCSS', 20261006)], [{ icao: 'RJTT', date: 20261005 }], cfg, end05 + 86400 * 2)
    expect(targets.map((t) => `${t.icao}:${t.date}:${t.source}`)).toEqual(['RJTT:20261005:extra', 'RCSS:20261006:vault'])
  })
  test('garbage station bytes are skipped, not thrown', () => {
    const { skipped } = planTargets([{ station: '0x00000000', date: 20261005 }], [], cfg, end05 + 7200)
    expect(skipped[0].reason).toBe('bad-station-code')
  })
})

describe('ladder cursor', () => {
  test('scans the newest window, at or above the configured cursor, in pages', () => {
    const c = { ladderCursorStart: 0, ladderScanWindow: 64, ladderPageSize: 32 }
    expect(ladderPages(0, c)).toEqual([])
    expect(ladderPages(3, c)).toEqual([{ start: 0, count: 3 }])
    expect(ladderPages(70, c)).toEqual([
      { start: 6, count: 32 },
      { start: 38, count: 32 },
    ])
    expect(ladderPages(70, { ...c, ladderCursorStart: 50 })).toEqual([{ start: 50, count: 20 }])
  })
})

describe('budget + trigger time', () => {
  test('budget counts and refuses past the limit', () => {
    const b = new Budget('http', 3)
    b.take(2)
    expect(b.has(2)).toBe(false)
    b.take()
    expect(() => b.take()).toThrow('exhausted')
  })
  test('anchor = scheduled time on a DON (scheduled <= now), DON time when the scheduled time is in the future', () => {
    expect(anchorTimeSec({ scheduledExecutionTime: { seconds: 1791396000n } }, 1791396004500)).toEqual({ anchor: 1791396000, scheduled: 1791396000, now: 1791396004 })
    // simulator: next fire time 06:30Z while it is 05:48Z
    const sim = anchorTimeSec({ scheduledExecutionTime: { seconds: Date.parse('2026-10-07T06:30:00Z') / 1000 } }, Date.parse('2026-10-07T05:48:42Z'))
    expect(sim.anchor).toBe(Date.parse('2026-10-07T05:48:42Z') / 1000)
    expect(anchorTimeSec(undefined, 1791396000123).anchor).toBe(1791396000)
    expect(anchorTimeSec({ scheduledExecutionTime: { seconds: 0n } }, 1791396000123).anchor).toBe(1791396000)
  })
})

// ---------------------------------------------------------------------------- schedules (cron) policy
// Minimal evaluator for the forms we use: [TZ=Zone ]sec min hour dom mon dow with '*', 'N' or '*/N'.
const fires = (expr: string, fromSec: number, toSec: number): number[] => {
  let tz = 'UTC'
  let body = expr
  if (expr.startsWith('TZ=')) [tz, body] = [expr.slice(3, expr.indexOf(' ')), expr.slice(expr.indexOf(' ') + 1)]
  const f = body.trim().split(/\s+/)
  const [sec, min, hour] = f.length === 6 ? f : ['0', ...f]
  const match = (field: string, v: number) => field === '*' || (field.startsWith('*/') ? v % Number(field.slice(2)) === 0 : Number(field) === v)
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
  const out: number[] = []
  for (let t = fromSec - (fromSec % 60); t < toSec; t += 60) {
    const [hh, mm] = fmt.format(new Date(t * 1000)).split(':').map(Number)
    if (match(hour, hh % 24) && match(min, mm) && match(sec, 0)) out.push(t)
  }
  return out
}

describe('cron schedules', () => {
  for (const name of ['config.testnet.json', 'config.anvil.json']) {
    test(`${name}: 02:00 local per station, hourly retries, fires >= 30 min apart and TTL below the spacing`, () => {
      const c: Config = configSchema.parse(JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')))
      const from = Date.parse('2026-10-07T00:00:00Z') / 1000
      const all = c.schedules.flatMap((s) => fires(s, from, from + 3 * 86400)).sort((a, b) => a - b)
      const uniq = [...new Set(all)]
      expect(uniq.length).toBe(all.length) // no two triggers fire at the same instant
      const minGap = Math.min(...uniq.slice(1).map((t, i) => t - uniq[i]))
      expect(minGap).toBeGreaterThanOrEqual(1800)
      expect(c.attestationTtlSec).toBeLessThan(minGap) // two attestations for one station-date never overlap
      for (const st of c.stations) {
        // some trigger fires at 02:00 local each day = dayEnd + settleDelaySec
        for (const d of [20261007, 20261008]) expect(uniq).toContain(dayEndSec(d, st.utcOffsetMin) + c.settleDelaySec)
      }
      const gaps = uniq.slice(1).map((t, i) => t - uniq[i])
      expect(Math.max(...gaps)).toBeLessThanOrEqual(3600) // at least hourly retries
    })
  }
})
