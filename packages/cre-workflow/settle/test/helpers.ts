// Test helpers: real captured METAR fixtures served by URL, and a small model of the v1 Resolver + Vault for the
// SDK harness (EvmMock). The model applies the same acceptance rules as src/Resolver.sol so handler tests can assert
// what the chain would do; the real contracts are exercised in e2e/fork.e2e.test.ts on an anvil fork.
import { hexToBase64 } from '@chainlink/cre-sdk'
import { EvmMock, HttpActionsMock, newTestRuntime } from '@chainlink/cre-sdk/test'
import { readFileSync } from 'node:fs'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  type Address,
  type Hex,
  bytesToHex,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  hexToBytes,
  keccak256,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { RESOLVER_ABI, STATUS, VAULT_ABI } from '../abi'
import { type Config, configSchema } from '../config'
import { dayEndSec } from '../plan'
import { decodeReport, settlementDigest, stationToBytes4 } from '../report'

export const MONAD_TESTNET_SELECTOR = 2183018362218727504n
export const HEADER = 109 // report metadata header the harness prepends to rawReport
// Throwaway, publicly known test key (anvil account #9). Never holds value.
export const TEST_ATTESTER_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as Hex
export const TEST_ATTESTER = privateKeyToAccount(TEST_ATTESTER_KEY).address
export const OFFSETS: Record<string, number> = { RCSS: 480, RJTT: 540, ZGSZ: 480 } // ZGSZ: on chain-model only (not configured)

export const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
export const testnetConfig = (over: Partial<Config> = {}): Config =>
  configSchema.parse({ ...JSON.parse(readFileSync(new URL('../config.testnet.json', import.meta.url), 'utf8')), ...over })

// ------------------------------------------------------------------------------------------------ HTTP
export type SourceKey = `${'iem' | 'awc' | 'ogimet'}:${string}:${string}` // kind:ICAO:YYYY-MM-DD

const localYmd = (utcMs: number, icao: string) => new Date(utcMs + OFFSETS[icao] * 60_000).toISOString().slice(0, 10)

/** Which source / station / local date a settlement URL asks for (inverse of settle-core's URL builders). */
export const parseSourceUrl = (url: string): { kind: 'iem' | 'awc' | 'ogimet'; icao: string; ymd: string } => {
  const u = new URL(url)
  const q = u.searchParams
  if (u.hostname === 'mesonet.agron.iastate.edu') {
    const pad = (s: string | null) => String(s).padStart(2, '0')
    return { kind: 'iem', icao: q.get('station')!, ymd: `${q.get('year1')}-${pad(q.get('month1'))}-${pad(q.get('day1'))}` }
  }
  if (u.hostname === 'aviationweather.gov') {
    const icao = q.get('ids')!
    return { kind: 'awc', icao, ymd: localYmd(Date.parse(q.get('date')!) - 86_400_000, icao) }
  }
  if (u.hostname === 'www.ogimet.com') {
    const icao = q.get('icao')!
    const b = q.get('begin')!
    const t = Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8), +b.slice(8, 10), +b.slice(10, 12))
    return { kind: 'ogimet', icao, ymd: localYmd(t, icao) }
  }
  throw new Error(`unexpected URL ${url}`)
}

const EXT = { iem: 'csv', awc: 'json', ogimet: 'txt' } as const

/** Shift a captured response from local date `from` to local date `to` (test-only relabel, every timestamp moved). */
export const shiftFixture = (kind: 'iem' | 'awc' | 'ogimet', body: string, from: string, to: string): string => {
  const dms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  if (dms === 0) return body
  if (kind === 'awc') {
    const rows = JSON.parse(body) as { obsTime: number }[]
    return JSON.stringify(rows.map((r) => ({ ...r, obsTime: r.obsTime + dms / 1000 })))
  }
  if (kind === 'iem') {
    return body.replace(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/g, (_, d: string, hm: string) => `${new Date(Date.parse(`${d}T00:00:00Z`) + dms).toISOString().slice(0, 10)} ${hm}`)
  }
  return body.replace(/^([A-Z0-9]{4}),(\d{4}),(\d{2}),(\d{2}),/gm, (_, s: string, y: string, m: string, d: string) => {
    const nd = new Date(Date.UTC(+y, +m - 1, +d) + dms)
    return `${s},${nd.getUTCFullYear()},${String(nd.getUTCMonth() + 1).padStart(2, '0')},${String(nd.getUTCDate()).padStart(2, '0')},`
  })
}

export type HttpPlan = {
  /** Override a source: a body string, an HTTP status, or a function of the default body. */
  overrides?: Partial<Record<SourceKey, string | number | { status: number; body: string } | ((body: string) => string)>>
  /** Serve fixture `from` (local date) for requested date `to` (fork e2e relabel). */
  relabel?: Record<string, string> // "RCSS:2026-10-08" -> "2026-10-05"
}

/** Installs the HTTP mock; returns the list of requested URLs. Missing fixtures answer with an empty body. */
export const installHttp = (plan: HttpPlan = {}): string[] => {
  const seen: string[] = []
  HttpActionsMock.testInstance().sendRequest = (req) => {
    seen.push(req.url)
    const { kind, icao, ymd } = parseSourceUrl(req.url)
    const key = `${kind}:${icao}:${ymd}` as SourceKey
    const src = plan.relabel?.[`${icao}:${ymd}`] ?? ymd
    let body = ''
    try {
      body = shiftFixture(kind, fx(`${kind}_${icao}_${src}.${EXT[kind]}`), src, ymd)
    } catch {
      body = kind === 'awc' ? '' : 'station,valid,metar\n' // like an empty archive
    }
    const o = plan.overrides?.[key]
    if (typeof o === 'number') return { statusCode: o, body: new TextEncoder().encode('error'), headers: {} }
    if (o && typeof o === 'object') return { statusCode: o.status, body: new TextEncoder().encode(o.body), headers: {} }
    if (typeof o === 'string') body = o
    if (typeof o === 'function') body = o(body)
    return { statusCode: 200, body: new TextEncoder().encode(body), headers: {} }
  }
  return seen
}

// ------------------------------------------------------------------------------------------------ chain model
export type ModelResult = { status: number; tmaxC: number; resolvedAt: bigint; finalAt: bigint; sourcesHash: Hex }
export type ChainModel = {
  resolver: Address
  attester: Address
  chainId: bigint
  paused: boolean
  ladders: { station: string; date: number }[]
  results: Map<string, ModelResult>
  /** chain time (s) used by duePendingLadders + onReport */
  now: () => number
  reads: { fn: string; block: string }[]
  writes: { payload: Hex; gasLimit: bigint; receiver: Address; accepted: boolean; reason: string }[]
  /** make onReport "revert" (forwarder swallows it) for testing confirmation */
  rejectAll?: boolean
}

const zero32 = `0x${'00'.repeat(32)}` as Hex
export const resultKey = (station: string, date: number) => `${station}:${date}`

/** Signer of a 65-byte r||s||v signature over a digest (sync, noble). */
export const recoverSigner = (digest: Hex, signature: Hex): Address => {
  const sig = hexToBytes(signature)
  const v = sig[64]
  if (v !== 27 && v !== 28) return zeroAddress
  const s = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v - 27)
  if (s.hasHighS()) return zeroAddress // OpenZeppelin ECDSA rejects high-s
  const pub = s.recoverPublicKey(hexToBytes(digest)).toRawBytes(false)
  return getAddress(`0x${keccak256(pub.slice(1)).slice(-40)}`)
}

/** Resolver.onReport acceptance rules (src/Resolver.sol v1), applied to a decoded payload. Mutates m.results. */
export const modelOnReport = (m: ChainModel, payload: Hex): { accepted: boolean; reason: string } => {
  if (m.rejectAll) return { accepted: false, reason: 'rejected (test)' }
  if (m.paused) return { accepted: false, reason: 'EnforcedPause' }
  const r = decodeReport(payload)
  const t = BigInt(m.now())
  if (t > r.validUntil) return { accepted: false, reason: 'AttestationExpired' }
  const signer = recoverSigner(settlementDigest(m.chainId, m.resolver, r), r.signature)
  if (signer !== m.attester) return { accepted: false, reason: `InvalidAttestation(${signer})` }
  if (m.now() < dayEndSec(r.date, OFFSETS[r.station])) return { accepted: false, reason: 'DayNotOver' }
  if (m.results.get(resultKey(r.station, r.date))) return { accepted: false, reason: 'AlreadyResolved' }
  if (!r.isVoid && (r.tmaxC < -90 || r.tmaxC > 70)) return { accepted: false, reason: 'TmaxOutOfRange' }
  m.results.set(resultKey(r.station, r.date), {
    status: r.isVoid ? STATUS.Void : STATUS.Settled,
    tmaxC: r.isVoid ? 0 : r.tmaxC,
    resolvedAt: t,
    finalAt: r.isVoid ? t : t + 900n,
    sourcesHash: r.sourcesHash,
  })
  return { accepted: true, reason: 'ok' }
}

/** LAST_FINALIZED_BLOCK_NUMBER = {absVal:[3],sign:-1}, LATEST_BLOCK_NUMBER = {absVal:[2],sign:-1}. */
const blockTag = (b: any): string => {
  if (!b) return 'default'
  const abs = b.absVal instanceof Uint8Array ? b.absVal : typeof b.absVal === 'string' ? Buffer.from(b.absVal, 'base64') : null
  const neg = String(b.sign) === '-1'
  if (neg && abs && abs.length === 1 && abs[0] === 3) return 'finalized'
  if (neg && abs && abs.length === 1 && abs[0] === 2) return 'latest'
  return 'number'
}

/** Wires EvmMock to the chain model (reads route by selector; writes go through modelOnReport). */
export const installChain = (m: ChainModel) => {
  const evm = EvmMock.testInstance(MONAD_TESTNET_SELECTOR)
  evm.callContract = (req) => {
    const to = bytesToHex(req.call!.to as Uint8Array).toLowerCase()
    const data = bytesToHex(req.call!.data as Uint8Array)
    const tag = blockTag(req.blockNumber)
    if (to === m.resolver.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: RESOLVER_ABI, data })
      m.reads.push({ fn: functionName, block: tag })
      if (functionName === 'paused') return { data: hexToBase64(encodeFunctionResult({ abi: RESOLVER_ABI, functionName, result: m.paused })) }
      const [b4, date] = args as [Hex, number]
      const station = Buffer.from(b4.slice(2), 'hex').toString('latin1')
      const r = m.results.get(resultKey(station, date)) ?? { status: 0, tmaxC: 0, resolvedAt: 0n, finalAt: 0n, sourcesHash: zero32 }
      return { data: hexToBase64(encodeFunctionResult({ abi: RESOLVER_ABI, functionName: 'resultOf', result: r })) }
    }
    const { functionName, args } = decodeFunctionData({ abi: VAULT_ABI, data })
    m.reads.push({ fn: functionName, block: tag })
    if (functionName === 'ladderCount') return { data: hexToBase64(encodeFunctionResult({ abi: VAULT_ABI, functionName, result: BigInt(m.ladders.length) })) }
    const [start, count] = (args as [bigint, bigint]).map(Number)
    const due = m.ladders
      .slice(start, start + count)
      .filter((l) => m.now() >= dayEndSec(l.date, OFFSETS[l.station] ?? 0) && !m.results.get(resultKey(l.station, l.date)))
      .map((l) => ({ station: stationToBytes4(l.station), date: l.date }))
    return { data: hexToBase64(encodeFunctionResult({ abi: VAULT_ABI, functionName: 'duePendingLadders', result: due })) }
  }
  evm.writeReport = (input) => {
    const raw = input.report!.rawReport as Uint8Array
    const payload = `0x${bytesToHex(raw).slice(2 + HEADER * 2)}` as Hex
    const v = modelOnReport(m, payload)
    m.writes.push({ payload, gasLimit: input.gasConfig!.gasLimit as bigint, receiver: bytesToHex(input.receiver as Uint8Array) as Address, ...v })
    // Like the real forwarders: the tx succeeds even when onReport reverts (ReportProcessed(result=false)).
    return { txStatus: 2 /* SUCCESS */, txHash: new Uint8Array(32).fill(m.writes.length) }
  }
}

export const newModel = (over: Partial<ChainModel> = {}): ChainModel => ({
  resolver: '0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B',
  attester: TEST_ATTESTER,
  chainId: 10143n,
  paused: false,
  ladders: [],
  results: new Map(),
  now: () => 0,
  reads: [],
  writes: [],
  ...over,
})

export const runtimeFor = (config: Config, nowMs: number, attesterKey: Hex = TEST_ATTESTER_KEY) => {
  const ns = new Map([['ISOTHERM_ATTESTER_KEY', attesterKey]])
  return newTestRuntime<Config>(new Map([['main', ns], ['default', ns]]), { timeProvider: () => nowMs }, config)
}

export const cronPayload = (sec: number) => ({ scheduledExecutionTime: { seconds: BigInt(sec), nanos: 0 } }) as any
