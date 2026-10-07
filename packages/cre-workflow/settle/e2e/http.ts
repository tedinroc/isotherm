// Synchronous HTTP GET for the off-DON runners (harness fallback + challenge watcher), plus a TEST-ONLY relabel hook.
//
// httpGet: one curl GET, never throws (status 0 = transport error), like the CRE HTTP capability from the handler's view.
//
// ISOTHERM_TEST_RELABEL=RCSS:2026-10-08=2026-10-06[,...]  (anvil forks ONLY)
//   Serves the LIVE archive answer for the source day (here 2026-10-06), with every timestamp shifted to the target
//   day (2026-10-08). It exists so the launchd jobs can be exercised end to end on a fork before the target day's real
//   METARs exist. It is refused unless the RPC is a loopback anvil, so it can never influence a live settlement.
import { sourceUrl, type SourceKind } from '../sources'
import { parseSourceUrl, shiftFixture } from '../test/helpers'

export const LIVE_RPC = 'https://testnet-rpc.monad.xyz'
export const isLoopbackRpc = (rpc: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpc)

export type HttpAnswer = { status: number; body: string }

export const httpGet = (url: string, timeoutSec = 10, agent = 'isotherm-cre-harness/1.0'): HttpAnswer => {
  const r = Bun.spawnSync(['curl', '-sS', '--max-time', String(timeoutSec), '-A', agent, '-w', '\n%{http_code}', url])
  const raw = r.stdout.toString()
  const i = raw.lastIndexOf('\n')
  return { status: Number(raw.slice(i + 1)) || 0, body: i > 0 ? raw.slice(0, i) : '' }
}

export type Relabel = Map<string, string> // "RCSS:2026-10-08" -> "2026-10-06"

export const parseRelabel = (spec: string | undefined, rpc: string): Relabel | null => {
  if (!spec) return null
  if (!isLoopbackRpc(rpc)) throw new Error(`ISOTHERM_TEST_RELABEL is for anvil forks only (rpc ${rpc})`)
  const m: Relabel = new Map()
  for (const part of spec.split(',')) {
    const x = part.trim().match(/^([A-Z0-9]{4}):(\d{4}-\d{2}-\d{2})=(\d{4}-\d{2}-\d{2})$/)
    if (!x) throw new Error(`bad ISOTHERM_TEST_RELABEL entry "${part}" (want ICAO:YYYY-MM-DD=YYYY-MM-DD)`)
    m.set(`${x[1]}:${x[2]}`, x[3])
  }
  return m
}

export type StationInfo = { icao: string; utcOffsetMin: number; tzName: string }

/** GET a settlement-source URL; under a (fork-only) relabel, fetch the source day instead and shift it. */
export const sourceGet = (url: string, relabel: Relabel | null, stations: StationInfo[], timeoutSec = 10, agent?: string): HttpAnswer & { relabelledFrom?: string } => {
  if (relabel) {
    const { kind, icao, ymd } = parseSourceUrl(url)
    const from = relabel.get(`${icao}:${ymd}`)
    const st = stations.find((s) => s.icao === icao)
    if (from && st) {
      const a = httpGet(sourceUrl(kind as SourceKind, icao, from, st.utcOffsetMin, st.tzName), timeoutSec, agent)
      if (a.status !== 200 || a.body.trim() === '') return { ...a, relabelledFrom: from }
      try {
        return { status: 200, body: shiftFixture(kind, a.body, from, ymd), relabelledFrom: from }
      } catch {
        return { ...a, relabelledFrom: from } // unparseable body: served unshifted, so it is simply incomplete for the day
      }
    }
  }
  return httpGet(url, timeoutSec, agent)
}
