// The node-mode reduction (body -> Observation -> DON median -> DayStats) must not change any decision input.
import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { dayStats, parseAwcJson, parseIemCsv, parseOgimetText } from '../settle-core'
import { looksHealthy, NO_DATA, observe, sourceUrl, toDayStats } from '../sources'
import { fx, OFFSETS } from './helpers'

const files = readdirSync(new URL('../fixtures/', import.meta.url)).filter((f) => /^(iem|awc|ogimet)_[A-Z]{4}_\d{4}-\d{2}-\d{2}\./.test(f))

describe('observe -> toDayStats round trip equals settle-core dayStats on every fixture', () => {
  for (const f of files) {
    test(f, () => {
      const [kind, icao, rest] = f.split('_') as ['iem' | 'awc' | 'ogimet', string, string]
      const ymd = rest.slice(0, 10)
      const off = OFFSETS[icao]
      const body = fx(f)
      const parsed = kind === 'iem' ? parseIemCsv(body, off) : kind === 'awc' ? parseAwcJson(body) : parseOgimetText(body)
      const want = dayStats(parsed, ymd, off)
      const { split, healthy, ...got } = toDayStats(observe(kind, body, ymd, off))
      expect(split).toBe(false)
      expect(healthy).toBe(true) // every captured archive answer is healthy, including AWC's empty "aged out" body
      expect(got).toEqual(want)
    })
  }
})

describe('failure handling (never throws, never invents data)', () => {
  test('HTTP error -> no data', () => {
    expect(observe('iem', 'whatever', '2026-10-05', 480, 503)).toEqual({ ...NO_DATA, httpStatus: 503 })
    expect(toDayStats({ ...NO_DATA }).complete).toBe(false)
  })
  test('HTML error page / garbage JSON -> no data', () => {
    expect(observe('awc', '<html>rate limited</html>', '2026-10-05', 480).nObs).toBe(0)
    expect(observe('iem', '<html>oops</html>', '2026-10-05', 480).nObs).toBe(0)
    expect(observe('ogimet', 'Your quota limit for slow queries rate has been reached', '2026-10-05', 480).nObs).toBe(0)
  })
  test('AWC empty body = no data (aged out), but a healthy answer', () => {
    expect(observe('awc', '', '2026-05-04', 480)).toEqual({ ...NO_DATA, httpStatus: 200, healthy: 1 })
  })
  test('AWC beyond its 30-day retention answers HTTP 400 (captured live 2026-10-07): a definitive "no data", healthy', () => {
    const body = '{"status":"error","error":"Data is available for up to 30 days for date"}'
    expect(observe('awc', body, '2026-05-04', 480, 400)).toEqual({ ...NO_DATA, httpStatus: 400, healthy: 1 })
    expect(observe('awc', '', '2026-10-05', 480, 204)).toEqual({ ...NO_DATA, httpStatus: 204, healthy: 1 })
    expect(observe('awc', '{"status":"error","error":"rate limit"}', '2026-10-05', 480, 400).healthy).toBe(0)
    expect(observe('awc', 'x', '2026-10-05', 480, 500).healthy).toBe(0)
  })
  test('health: genuine (possibly empty) archive answers vs errors, throttles and timeouts', () => {
    expect(looksHealthy('iem', 'station,valid,metar\n')).toBe(true) // empty IEM day
    expect(looksHealthy('iem', '<html>502</html>')).toBe(false)
    expect(looksHealthy('awc', '[]')).toBe(true)
    expect(looksHealthy('awc', '{"error":"rate"}')).toBe(false)
    expect(looksHealthy('ogimet', fx('ogimet_RCSS_2026-05-04.txt'))).toBe(true)
    expect(looksHealthy('ogimet', 'Your quota limit for slow queries rate has been reached')).toBe(false)
    expect(looksHealthy('ogimet', '')).toBe(false) // ambiguous: never treated as proof of "no data"
    expect(observe('ogimet', 'Your quota limit for slow queries rate has been reached', '2026-05-04', 480).healthy).toBe(0)
    expect(toDayStats({ ...NO_DATA }).healthy).toBe(false) // transport error / timeout
    expect(toDayStats({ tmaxC: 25, nObs: 54, nHours: 24, lastMin: 1410, httpStatus: 200, healthy: 0.5 }).healthy).toBe(false) // DON split
  })
  test('a DON split (median between two disagreeing nodes) is incomplete, never a half degree', () => {
    const s = toDayStats({ tmaxC: 29.5, nObs: 50, nHours: 24, lastMin: 1410, httpStatus: 200, healthy: 1 })
    expect(s).toMatchObject({ complete: false, tmaxC: null, split: true })
  })
  test('source URLs come from settle-core', () => {
    expect(sourceUrl('awc', 'RJTT', '2026-10-06', 540, 'Asia/Tokyo')).toBe('https://aviationweather.gov/api/data/metar?ids=RJTT&format=json&date=2026-10-06T15:00:00Z&hours=24')
    expect(sourceUrl('iem', 'RJTT', '2026-10-06', 540, 'Asia/Tokyo')).toContain('station=RJTT&data=metar&year1=2026&month1=10&day1=6&year2=2026&month2=10&day2=7&tz=Asia/Tokyo')
  })
})
