// Handler tests in the official CRE SDK test harness (no login, no WASM): HTTP served from real captured fixtures,
// EVM reads/writes served by a model of the v1 Resolver + Vault that applies Resolver.onReport's acceptance rules.
import { describe, expect } from 'bun:test'
import { test } from '@chainlink/cre-sdk/test'
import { type Hex, recoverTypedDataAddress } from 'viem'
import { STATUS } from '../abi'
import { dayEndSec } from '../plan'
import { decodeReport, SETTLEMENT_TYPES, settlementDomain, stationToBytes4 } from '../report'
import type { RunSummary } from '../workflow'
import { onCron } from '../workflow'
import { cronPayload, fx, installChain, installHttp, newModel, resultKey, runtimeFor, TEST_ATTESTER, testnetConfig } from './helpers'

const cfg = testnetConfig()
const T = (date: number, icao = 'RCSS') => dayEndSec(date, icao === 'RCSS' ? 480 : 540)
const run = (nowSec: number, model: ReturnType<typeof newModel>, c = cfg, scheduled = true): RunSummary => {
  model.now = () => nowSec + 2 // chain time a couple of seconds after the trigger
  installChain(model)
  return JSON.parse(onCron(runtimeFor(c, nowSec * 1000 + 999_000), scheduled ? cronPayload(nowSec) : undefined))
}
const hosts = (urls: string[]) => urls.map((u) => new URL(u).hostname.split('.').slice(-2, -1)[0])

describe('catch-up settlement', () => {
  test('settles every due ladder, oldest first: RCSS+RJTT 10-05 and 10-06 (4 reports, 8 HTTP calls)', () => {
    const m = newModel({ ladders: [
      { station: 'RCSS', date: 20261006 }, { station: 'RJTT', date: 20261006 },
      { station: 'RCSS', date: 20261005 }, { station: 'RJTT', date: 20261005 },
      { station: 'RCSS', date: 20261007 }, // not over yet: not due
    ] })
    const urls = installHttp()
    const now = T(20261006) + 7200 // 02:00 Taipei on 10-07
    const out = run(now, m)
    expect(out.outcomes.map((o) => `${o.station}:${o.date}:${o.action}:${o.tmaxC}`)).toEqual([
      'RJTT:20261005:settled:22', 'RCSS:20261005:settled:29', 'RJTT:20261006:settled:26', 'RCSS:20261006:settled:25',
    ])
    expect(out.outcomes.every((o) => o.confirmed === 'resolved')).toBe(true)
    expect(urls).toHaveLength(8) // IEM + AWC each; no Ogimet needed
    expect(hosts(urls).filter((h) => h === 'ogimet')).toHaveLength(0)
    expect(m.writes.every((w) => w.accepted && w.gasLimit === 200000n)).toBe(true)
    expect(m.writes.every((w) => w.receiver.toLowerCase() === cfg.resolverAddress.toLowerCase())).toBe(true)
    expect(m.results.get(resultKey('RCSS', 20261005))).toMatchObject({ status: STATUS.Settled, tmaxC: 29 })
    expect(out.ladders).toEqual({ count: 5, scanned: [0, 5], due: 4 })
    // planning reads at the finalized block, confirmations at latest
    expect(m.reads.filter((r) => r.fn !== 'resultOf').every((r) => r.block === 'finalized')).toBe(true)
    expect(m.reads.filter((r) => r.fn === 'resultOf').every((r) => r.block === 'latest')).toBe(true)
    expect(out.budget).toEqual({ http: '8/15', evmReads: '7/15', reports: '4/5', ogimet: '0/1' })

    // second run: nothing due -> no HTTP, no writes
    const urls2 = installHttp()
    const out2 = run(now + 3600, m)
    expect(urls2).toHaveLength(0)
    expect(out2.outcomes).toHaveLength(0)
    expect(m.writes).toHaveLength(4)
  })

  test('report bytes: v1 encoding, attester signature, validUntil = scheduled trigger time + 1500 s', async () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261005 }] })
    installHttp()
    const now = T(20261005) + 7200
    run(now, m)
    const r = decodeReport(m.writes[0].payload)
    expect(r).toMatchObject({ station: 'RCSS', date: 20261005, tmaxC: 29, isVoid: false, validUntil: BigInt(now + 1500) })
    const signer = await recoverTypedDataAddress({
      domain: settlementDomain(10143n, cfg.resolverAddress as `0x${string}`),
      types: SETTLEMENT_TYPES,
      primaryType: 'Settlement',
      message: { ...r, station: stationToBytes4(r.station) },
      signature: r.signature,
    })
    expect(signer).toBe(TEST_ATTESTER)
  })

  test('validUntil comes from the cron schedule, not the DON clock, when the schedule is in the past (DON: +999 s here)', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261005 }] })
    installHttp()
    const now = T(20261005) + 7200
    run(now, m)
    expect(decodeReport(m.writes[0].payload).validUntil).toBe(BigInt(now + cfg.attestationTtlSec))
  })

  test('without a scheduled time it falls back to DON time (runtime.now)', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261005 }] })
    installHttp()
    const now = T(20261005) + 7200
    run(now, m, cfg, false)
    expect(decodeReport(m.writes[0].payload).validUntil).toBe(BigInt(now + 999 + cfg.attestationTtlSec))
  })

  test('simulator passes the NEXT fire time: validUntil stays <= DON time + TTL and the 02:00 gate is not opened early', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261005 }] })
    let urls = installHttp()
    const donNow = T(20261005) + 7200 - 1800 // 01:30 Taipei
    m.now = () => donNow
    installChain(m)
    let out: RunSummary = JSON.parse(onCron(runtimeFor(cfg, donNow * 1000), cronPayload(T(20261005) + 7200 + 1800)))
    expect(out.skipped[0]).toMatchObject({ reason: 'before-settle-window' }) // scheduled 02:30 would have opened it
    expect(urls).toHaveLength(0)
    urls = installHttp()
    const later = T(20261005) + 7200 + 60
    m.now = () => later
    installChain(m)
    out = JSON.parse(onCron(runtimeFor(cfg, later * 1000), cronPayload(later + 3540)))
    expect(decodeReport(m.writes[0].payload).validUntil).toBe(BigInt(later + cfg.attestationTtlSec))
    expect(out.triggerTime).toBe(new Date(later * 1000).toISOString())
  })
})

describe('the settlement rule inside the workflow', () => {
  const awcPlus2 = (body: string) => JSON.stringify((JSON.parse(body) as { rawOb: string }[]).map((r) => ({ ...r, rawOb: r.rawOb.replace(/ (\d{2})\/(\d{2}|M?\d{2}) /, (_, t, d) => ` ${String(Number(t) + 2).padStart(2, '0')}/${d} `) })))

  test('IEM and AWC disagree -> PENDING (no report) before the deadline, VOID after it', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261005 }] })
    const plan = { overrides: { 'awc:RCSS:2026-10-05': awcPlus2 } as const }
    const urls = installHttp(plan)
    let out = run(T(20261005) + 7200, m)
    expect(out.outcomes[0]).toMatchObject({ action: 'pending', reason: 'primary sources disagree' })
    expect(m.writes).toHaveLength(0)
    expect(hosts(urls)).toEqual(['iastate', 'aviationweather']) // complete-but-disagreeing primaries: no fallback

    installHttp(plan)
    out = run(T(20261005) + 129600, m) // exactly at the deadline: still PENDING
    expect(out.outcomes[0].action).toBe('pending')
    installHttp(plan)
    out = run(T(20261005) + 129600 + 1800, m)
    expect(out.outcomes[0]).toMatchObject({ action: 'voided', tmaxC: null, confirmed: 'resolved' })
    const r = decodeReport(m.writes[0].payload)
    expect([r.isVoid, r.tmaxC]).toEqual([true, 0])
    expect(m.results.get(resultKey('RCSS', 20261005))?.status).toBe(STATUS.Void)
  })

  test('AWC aged out (2026-05-04) -> Ogimet fallback -> SETTLED 25 by 2-of-3', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20260504 }] })
    const urls = installHttp()
    const out = run(T(20260504) + 7200, m)
    expect(hosts(urls)).toEqual(['iastate', 'aviationweather', 'ogimet'])
    expect(out.outcomes[0]).toMatchObject({ action: 'settled', tmaxC: 25, reason: '2-of-3 fallback agree', confirmed: 'resolved' })
  })

  test('IEM outage (2025-11-15: 1 partial report says 20, truth 26) -> PENDING, then VOID only after 36 h', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20251115 }] })
    installHttp()
    expect(run(T(20251115) + 7200, m).outcomes[0]).toMatchObject({ action: 'pending', reason: 'insufficient complete sources' })
    installHttp()
    expect(run(T(20251115) + 129600 + 3600, m).outcomes[0]).toMatchObject({ action: 'voided' })
  })

  test('past the deadline with the fallback THROTTLED (seen live: Ogimet quota/timeout) -> PENDING, not VOID', () => {
    // 2026-05-04: IEM complete (25), AWC aged out (healthy empty), Ogimet answers with its quota notice.
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20260504 }] })
    const plan = { overrides: { 'ogimet:RCSS:2026-05-04': 'Your quota limit for slow queries rate has been reached' } as const }
    installHttp(plan)
    let out = run(T(20260504) + 129600 + 1800, m) // 36.5 h: past our deadline
    expect(out.outcomes[0].action).toBe('pending')
    expect(out.outcomes[0].reason).toContain('source is unavailable')
    expect(out.outcomes[0].sources?.OGIMET).toContain('UNAVAILABLE')
    expect(m.writes).toHaveLength(0)
    installHttp() // an hour later Ogimet answers: settles 25 by 2-of-3 instead of a wrong VOID
    out = run(T(20260504) + 129600 + 5400, m)
    expect(out.outcomes[0]).toMatchObject({ action: 'settled', tmaxC: 25, reason: '2-of-3 fallback agree' })
  })

  test('AWC past its 30-day retention (HTTP 400, as live) + IEM complete + Ogimet complete -> SETTLED 25 by 2-of-3', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20260504 }] })
    const awc400 = { status: 400, body: '{"status":"error","error":"Data is available for up to 30 days for date"}' }
    installHttp({ overrides: { 'awc:RCSS:2026-05-04': awc400 } })
    const out = run(T(20260504) + 7200, m)
    expect(out.outcomes[0]).toMatchObject({ action: 'settled', tmaxC: 25, reason: '2-of-3 fallback agree' })
    expect(out.outcomes[0].sources?.AWC).toContain('n=0') // healthy "no data", not UNAVAILABLE
  })

  test('the 46 h backstop voids even with a source still failing (before the 48 h on-chain stale window)', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20260504 }] })
    installHttp({ overrides: { 'ogimet:RCSS:2026-05-04': 503 } })
    expect(run(T(20260504) + 165600, m).outcomes[0].action).toBe('pending') // exactly 46 h: not yet
    installHttp({ overrides: { 'ogimet:RCSS:2026-05-04': 503 } })
    const out = run(T(20260504) + 165600 + 1800, m)
    expect(out.outcomes[0]).toMatchObject({ action: 'voided', confirmed: 'resolved' })
    expect(m.results.get(resultKey('RCSS', 20260504))?.resolvedAt).toBeLessThan(BigInt(T(20260504) + 172800))
  })

  test('at most one Ogimet query per run: a second fallback day waits for the next hourly run', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20251115 }, { station: 'RCSS', date: 20260504 }] })
    let urls = installHttp()
    let out = run(T(20260504) + 129600 + 1800, m)
    expect(hosts(urls).filter((h) => h === 'ogimet')).toHaveLength(1)
    expect(out.outcomes.map((o) => `${o.date}:${o.action}`)).toEqual(['20251115:voided', '20260504:deferred'])
    expect(out.outcomes[1].reason).toContain('fallback budget')
    urls = installHttp()
    out = run(T(20260504) + 129600 + 5400, m)
    expect(out.outcomes.map((o) => `${o.date}:${o.action}:${o.tmaxC}`)).toEqual(['20260504:settled:25'])
  })

  test('IEM HTTP 503 -> treated as incomplete -> AWC + Ogimet settle it', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261006 }] })
    const urls = installHttp({ overrides: { 'iem:RCSS:2026-10-06': 503 } })
    const out = run(T(20261006) + 7200, m)
    expect(urls).toHaveLength(3)
    expect(out.outcomes[0]).toMatchObject({ action: 'settled', tmaxC: 25, reason: '2-of-3 fallback agree' })
  })

  test('a thin day (IEM lagging, last report before 23:00) is not settled on AWC alone', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261005 }] })
    const cut = (csv: string) => csv.split('\n').filter((l) => !/ 2[23]:\d\d,/.test(l)).join('\n')
    installHttp({ overrides: { 'iem:RCSS:2026-10-05': cut, 'ogimet:RCSS:2026-10-05': '' } })
    const out = run(T(20261005) + 7200, m)
    expect(out.outcomes[0]).toMatchObject({ action: 'pending', reason: 'insufficient complete sources' })
    expect(m.writes).toHaveLength(0)
  })
})

describe('quotas, safety and confirmation', () => {
  test('resolver paused -> no HTTP, no writes', () => {
    const m = newModel({ paused: true, ladders: [{ station: 'RCSS', date: 20261005 }] })
    const urls = installHttp()
    const out = run(T(20261005) + 7200, m)
    expect(out.paused).toBe(true)
    expect(urls).toHaveLength(0)
    expect(m.writes).toHaveLength(0)
  })

  test('backlog of 8 due ladders: HTTP <= 15, reports <= 5, the rest deferred to the next hourly run', () => {
    const ladders: { station: string; date: number }[] = []
    for (const d of [20261001, 20261002, 20261003, 20261004]) ladders.push({ station: 'RCSS', date: d }, { station: 'RJTT', date: d })
    const m = newModel({ ladders })
    const relabel: Record<string, string> = {}
    for (const l of ladders) relabel[`${l.station}:${String(l.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}`] = '2026-10-05'
    const urls = installHttp({ relabel })
    const out = run(T(20261004) + 7200, m)
    expect(urls.length).toBeLessThanOrEqual(15)
    expect(m.writes).toHaveLength(5)
    expect(out.outcomes.filter((o) => o.action === 'deferred')).toHaveLength(3)
    expect(out.outcomes[0]).toMatchObject({ station: 'RJTT', date: 20261001 }) // oldest dayEnd first (Tokyo ends 1 h earlier)
    installHttp({ relabel })
    const out2 = run(T(20261004) + 7200 + 3600, m)
    expect(out2.outcomes.map((o) => o.action)).toEqual(['settled', 'settled', 'settled'])
    expect(m.writes).toHaveLength(8)
  })

  test('never decides without the fallback: if Ogimet does not fit in the HTTP budget the day is deferred', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20251115 }] })
    installHttp()
    const out = run(T(20251115) + 129600 + 3600, m, testnetConfig({ maxHttpCalls: 2 }))
    expect(out.outcomes[0]).toMatchObject({ action: 'deferred', reason: 'HTTP budget (Ogimet fallback needed)' })
    expect(m.writes).toHaveLength(0) // past the deadline, but no VOID without consulting Ogimet
  })

  test('nothing before 02:00 local; unknown stations skipped', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261006 }, { station: 'ZGSZ', date: 20261006 }] })
    const urls = installHttp()
    const out = run(T(20261006) + 3600, m) // 01:00 Taipei
    expect(urls).toHaveLength(0)
    expect(out.skipped.map((s) => s.reason).sort()).toEqual(['before-settle-window', 'station-not-configured'])
  })

  test('forwarder swallows a rejected onReport: tx success but confirmation says not-accepted', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261005 }], rejectAll: true })
    installHttp()
    const out = run(T(20261005) + 7200, m)
    expect(out.outcomes[0]).toMatchObject({ action: 'settled', confirmed: 'not-accepted', onchain: { status: 0, tmaxC: 0 } })
  })

  test('wrong attester key -> the Resolver model rejects (InvalidAttestation)', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261005 }] })
    installHttp()
    m.now = () => T(20261005) + 7202
    installChain(m)
    const out: RunSummary = JSON.parse(onCron(runtimeFor(cfg, (T(20261005) + 7200) * 1000, `0x${'11'.repeat(32)}` as Hex), cronPayload(T(20261005) + 7200)))
    expect(m.writes[0].reason).toStartWith('InvalidAttestation')
    expect(out.outcomes[0].confirmed).toBe('not-accepted')
  })

  test('replay targets (no ladder) are settled only if the Resolver has no result', () => {
    const m = newModel()
    m.results.set(resultKey('RJTT', 20261005), { status: 1, tmaxC: 22, resolvedAt: 1n, finalAt: 2n, sourcesHash: `0x${'00'.repeat(32)}` })
    installHttp()
    const c = testnetConfig({ extraTargets: [{ icao: 'RCSS', date: '2026-10-06' }, { icao: 'RJTT', date: '2026-10-05' }] })
    const out = run(T(20261006) + 7200, m, c)
    expect(out.outcomes.map((o) => `${o.station}:${o.date}:${o.action}:${o.tmaxC}`)).toEqual(['RCSS:20261006:settled:25'])
    expect(out.skipped).toContainEqual({ icao: 'RJTT', date: 20261005, reason: 'already-resolved' })
  })

  test('summary stays tiny (CRE response limit 100 KB) and logs stay under 1 KB per line', () => {
    const m = newModel({ ladders: [{ station: 'RCSS', date: 20261005 }, { station: 'RJTT', date: 20261005 }] })
    installHttp()
    m.now = () => T(20261005) + 7202
    installChain(m)
    const rt = runtimeFor(cfg, (T(20261005) + 7200) * 1000)
    const s = onCron(rt, cronPayload(T(20261005) + 7200))
    expect(s.length).toBeLessThan(100_000)
    expect(rt.getLogs().every((l) => l.length < 1024)).toBe(true)
    expect(fx('awc_RCSS_2026-10-05.json').length).toBeLessThan(250_000) // CRE HTTP response limit
  })
})
