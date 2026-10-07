// Golden tests for the validated settlement rule, run against the copy that is compiled into the WASM.
// Fixtures are real IEM / aviationweather.gov / Ogimet responses (see fixtures/MANIFEST.json and
// packages/forecast/test/fixtures). Every "want" value below is Polymarket's resolved winning bucket, except
// 2026-05-04 (Polymarket's resolver missed the 25 C METAR that two independent archives hold).
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { awcDayUrl, dayStats, decide, iemDayUrl, metarTempC, ogimetDayUrl, parseAwcJson, parseIemCsv, parseOgimetText } from '../settle-core'
import { fx } from './helpers'

const TPE = 480
const TYO = 540
const sha = (u: URL) => createHash('sha256').update(readFileSync(u)).digest('hex')
const SETTLE_CORE_SHA256 = '119832de3ceabd39e311fe59b8915628cdd9a28a61377527e6f7ed2743853d62'

describe('settle-core identity', () => {
  test('settle/settle-core.ts is byte-identical to the validated copy (packages/forecast, spikes/weather)', () => {
    const mine = new URL('../settle-core.ts', import.meta.url)
    expect(sha(mine)).toBe(SETTLE_CORE_SHA256)
    for (const rel of ['../../../forecast/src/settle-core.ts', '../../../../spikes/weather/src/settle-core.ts']) {
      const u = new URL(rel, import.meta.url)
      if (existsSync(u)) expect(sha(u)).toBe(SETTLE_CORE_SHA256)
    }
  })
})

describe('METAR parsing and URLs', () => {
  test('temperature group', () => {
    expect(metarTempC('RCSS 050530Z 09013KT 040V110 9999 FEW015 SCT030 BKN100 25/18 Q1016 NOSIG RMK A3003')).toBe(25)
    expect(metarTempC('XXXX 010000Z 00000KT 9999 M05/M10 Q1030')).toBe(-5)
    expect(metarTempC('XXXX 010000Z 00000KT 9999 05/// Q1030')).toBe(5)
    expect(metarTempC('XXXX 010000Z 00000KT R10/1200 9999 12/08 Q1030')).toBe(12)
    expect(metarTempC('XXXX 010000Z 00000KT 9999 Q1030 RMK 23/45')).toBe(null)
    expect(metarTempC('RCSS 141630Z NIL')).toBe(null)
  })
  test('exact settlement URLs', () => {
    expect(iemDayUrl('RCSS', '2026-10-05', 'Asia/Taipei')).toBe(
      'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=RCSS&data=metar&year1=2026&month1=10&day1=5&year2=2026&month2=10&day2=6&tz=Asia/Taipei&format=onlycomma&latlon=no&elev=no&missing=M&trace=T&direct=no&report_type=3&report_type=4',
    )
    expect(awcDayUrl('RCSS', '2026-10-05', TPE)).toBe('https://aviationweather.gov/api/data/metar?ids=RCSS&format=json&date=2026-10-05T16:00:00Z&hours=24')
    expect(ogimetDayUrl('RCSS', '2026-10-05', TPE)).toBe('https://www.ogimet.com/cgi-bin/getmetar?icao=RCSS&begin=202610041600&end=202610051559')
  })
})

describe('golden days', () => {
  const primary = (icao: string, d: string, off: number) => [
    dayStats(parseIemCsv(fx(`iem_${icao}_${d}.csv`), off), d, off),
    dayStats(parseAwcJson(fx(`awc_${icao}_${d}.json`)), d, off),
  ]
  for (const [icao, d, off, want] of [
    ['RCSS', '2026-10-05', TPE, 29],
    ['RJTT', '2026-10-05', TYO, 22],
    ['RCSS', '2026-10-06', TPE, 25], // captured 2026-10-07 for this package; Polymarket resolved 25 C
    ['RJTT', '2026-10-06', TYO, 26], // Polymarket resolved 26 C
  ] as const) {
    test(`${icao} ${d}: IEM and AWC complete and agree on ${want}`, () => {
      const [a, b] = primary(icao, d, off)
      expect([a.complete, b.complete]).toEqual([true, true])
      expect(decide([a, b], [], false)).toEqual({ status: 'SETTLED', tmaxC: want, reason: 'primary sources agree' })
    })
  }
  test('RCSS/RJTT 2026-10-06: Ogimet (fallback archive) agrees too', () => {
    expect(dayStats(parseOgimetText(fx('ogimet_RCSS_2026-10-06.txt')), '2026-10-06', TPE).tmaxC).toBe(25)
    expect(dayStats(parseOgimetText(fx('ogimet_RJTT_2026-10-06.txt')), '2026-10-06', TYO).tmaxC).toBe(26)
  })
  test('AWC window is inclusive of its end: the next-day 00:00 report is excluded (50, not 51)', () => {
    expect(dayStats(parseAwcJson(fx('awc_RCSS_2026-10-05.json')), '2026-10-05', TPE).nObs).toBe(50)
  })
  test('RCSS 2026-05-04: AWC aged out -> 2-of-3 IEM + Ogimet = 25', () => {
    const a = dayStats(parseIemCsv(fx('iem_RCSS_2026-05-04.csv'), TPE), '2026-05-04', TPE)
    const b = dayStats(parseAwcJson(fx('awc_RCSS_2026-05-04.json')), '2026-05-04', TPE)
    const c = dayStats(parseOgimetText(fx('ogimet_RCSS_2026-05-04.txt')), '2026-05-04', TPE)
    expect(b.nObs).toBe(0)
    expect(decide([a, b], [c], false)).toEqual({ status: 'SETTLED', tmaxC: 25, reason: '2-of-3 fallback agree' })
  })
  test('RCSS 2025-11-15 (IEM outage): one partial report says 20, truth 26 -> PENDING, VOID only after the deadline', () => {
    const a = dayStats(parseIemCsv(fx('iem_RCSS_2025-11-15.csv'), TPE), '2025-11-15', TPE)
    const c = dayStats(parseOgimetText(fx('ogimet_RCSS_2025-11-15.txt')), '2025-11-15', TPE)
    expect([a.tmaxC, a.complete, c.tmaxC, c.complete]).toEqual([20, false, 26, true])
    const empty = dayStats([], '2025-11-15', TPE)
    expect(decide([a, empty], [c], false).status).toBe('PENDING')
    expect(decide([a, empty], [c], true).status).toBe('VOID')
  })
  test('complete primaries that disagree never settle and do not consult the fallback', () => {
    const s = (t: number) => ({ tmaxC: t, nObs: 48, nHours: 24, lastLocal: '23:30', complete: true })
    expect(decide([s(30), s(31)], [s(30)], false).status).toBe('PENDING')
    expect(decide([s(30), s(31)], [s(30)], true).status).toBe('VOID')
  })
  test('completeness rule: >= 20 local hours AND last report >= 23:00', () => {
    const day = '2026-10-05'
    const start = Date.parse(`${day}T00:00:00Z`) - TPE * 60_000
    const obs = (hours: number[], lastMin = 0) => hours.map((h, i) => ({ tUtcMs: start + h * 3600_000 + (i === hours.length - 1 ? lastMin : 0) * 60_000, tempC: 20 }))
    const h = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i)
    expect(dayStats(obs(h(24)), day, TPE).complete).toBe(true) // 00..23
    expect(dayStats(obs(h(20, 4)), day, TPE).complete).toBe(true) // 04..23, 20 hours
    expect(dayStats(obs(h(19, 5)), day, TPE).complete).toBe(false) // 19 hours
    expect(dayStats(obs(h(23)), day, TPE).complete).toBe(false) // last report 22:00
    expect(dayStats(obs(h(23), 59), day, TPE).complete).toBe(false) // last 22:59
  })
})
