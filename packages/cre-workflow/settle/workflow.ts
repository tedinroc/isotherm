// Isotherm settlement workflow, product version (Chainlink CRE, TypeScript SDK 1.23).
//
//  cron (02:00 local per station + hourly retry)
//   -> EVM read  Resolver.paused()                                    (stop if paused)
//   -> EVM read  Vault.ladderCount(), Vault.duePendingLadders(start,n)  (cursor over the newest ladders)
//   -> plan: oldest first, not before dayEnd + 2 h, within 15 HTTP calls / 15 EVM reads / maxReportsPerRun
//   -> per station-date, HTTP in node mode + DON median consensus:
//        IEM (A) + aviationweather (B); Ogimet (C) only if A or B is incomplete
//   -> settle-core decide():  A,B complete & equal -> SETTLED; >=2 complete & all equal -> SETTLED (2-of-3);
//                             otherwise PENDING, and VOID only after dayEnd + 36 h (< on-chain STALE_WINDOW 48 h)
//   -> v1 report: abi.encode(station,date,tmaxC,isVoid,sourcesHash,validUntil,sig), EIP-712 attester signature,
//      validUntil = cron scheduled time + attestationTtlSec (deterministic across DON nodes)
//   -> runtime.report -> evm.writeReport -> (Mock)KeystoneForwarder.report -> Resolver.onReport
//   -> EVM read  Resolver.resultOf at LATEST (the forwarders never revert: tx success != settled)
import {
  bytesToHex,
  ConsensusAggregationByFields,
  CronCapability,
  type CronPayload,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  HTTPClient,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  median,
  type Runtime,
  TxStatus,
} from '@chainlink/cre-sdk'
import { type Address, type Hex, decodeFunctionResult, encodeFunctionData, zeroAddress } from 'viem'
import { RESOLVER_ABI, STATUS, VAULT_ABI } from './abi'
import { type Config, configSchema } from './config'
import { anchorTimeSec, Budget, type LadderRef, ladderPages, planTargets, type Skip, type Target, ymdToInt } from './plan'
import { buildSignedReport, canonicalSources, type NamedStats, sourcesHashOf, stationToBytes4 } from './report'
import { decide } from './settle-core'
import { fetchSource, type Observation, SOURCE_NAME, type SourceKind, type SourceStats, sourceUrl, toDayStats } from './sources'

export { configSchema }
export type { Config }

const observationConsensus = () =>
  ConsensusAggregationByFields<Observation>({
    tmaxC: median,
    nObs: median,
    nHours: median,
    lastMin: median,
    httpStatus: median,
    healthy: median,
  })

export type TargetOutcome = {
  station: string
  date: number
  action: 'settled' | 'voided' | 'pending' | 'deferred'
  reason: string
  tmaxC?: number | null
  sources?: Record<string, string>
  sourcesHash?: Hex
  validUntil?: string
  txHash?: Hex
  confirmed?: 'resolved' | 'not-accepted' | 'unconfirmed'
  onchain?: { status: number; tmaxC: number }
}

export type RunSummary = {
  triggerTime: string // the anchor: min(cron scheduled time, DON time)
  scheduledTime: string | null
  resolver: Address
  paused?: boolean
  ladders?: { count: number; scanned: [number, number]; due: number }
  outcomes: TargetOutcome[]
  skipped: Skip[]
  budget: { http: string; evmReads: string; reports: string; ogimet?: string }
}

const fmtSrc = (s: SourceStats | null) =>
  s === null
    ? 'not fetched'
    : !s.healthy
      ? 'UNAVAILABLE (error/timeout/throttle)'
      : `${s.tmaxC === null ? '-' : s.tmaxC}C n=${s.nObs} h=${s.nHours} last=${s.lastLocal ?? '-'} ${s.complete ? 'complete' : 'incomplete'}`

export const onCron = (runtime: Runtime<Config>, payload?: CronPayload): string => {
  const cfg = runtime.config
  const time = anchorTimeSec(payload, runtime.now().getTime())
  const nowSec = time.anchor
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainSelectorName })
  if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`)
  const evm = new EVMClient(network.chainSelector.selector)
  const http = new HTTPClient()
  const resolver = cfg.resolverAddress as Address
  const vault = cfg.vaultAddress as Address
  const chainId = BigInt(cfg.chainId)
  const reads = new Budget('evm-read', cfg.maxEvmReads)
  const calls = new Budget('http', cfg.maxHttpCalls)
  const reports = new Budget('reports', cfg.maxReportsPerRun)
  const fallbacks = new Budget('ogimet', cfg.maxFallbackCallsPerRun)
  const planBlock = cfg.readBlock === 'latest' ? LATEST_BLOCK_NUMBER : LAST_FINALIZED_BLOCK_NUMBER

  const summary: RunSummary = { triggerTime: new Date(nowSec * 1000).toISOString(), scheduledTime: time.scheduled === null ? null : new Date(time.scheduled * 1000).toISOString(), resolver, outcomes: [], skipped: [], budget: { http: '', evmReads: '', reports: '' } }
  const finish = () => {
    summary.budget = { http: `${calls.used}/${calls.limit}`, evmReads: `${reads.used}/${reads.limit}`, reports: `${reports.used}/${reports.limit}`, ogimet: `${fallbacks.used}/${fallbacks.limit}` }
    return JSON.stringify(summary)
  }

  // ---- EVM reads (each one counted against the 15/execution quota)
  const read = (to: Address, data: Hex, block = planBlock): Hex => {
    reads.take()
    const reply = evm.callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }), blockNumber: block }).result()
    return bytesToHex(reply.data)
  }
  const resultOf = (icao: string, date: number, block = planBlock) => {
    const data = read(resolver, encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'resultOf', args: [stationToBytes4(icao), date] }), block)
    return decodeFunctionResult({ abi: RESOLVER_ABI, functionName: 'resultOf', data })
  }

  // 1) Paused resolver: onReport would revert (and the forwarder would swallow it). Do nothing.
  const paused = decodeFunctionResult({ abi: RESOLVER_ABI, functionName: 'paused', data: read(resolver, encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'paused' })) })
  if (paused) {
    summary.paused = true
    runtime.log('resolver is paused: no reports this run')
    return finish()
  }

  // 2) Due ladders from the vault, scanning the newest ladderScanWindow ladders page by page.
  const count = Number(decodeFunctionResult({ abi: VAULT_ABI, functionName: 'ladderCount', data: read(vault, encodeFunctionData({ abi: VAULT_ABI, functionName: 'ladderCount' })) }))
  const pages = ladderPages(count, cfg)
  const due: LadderRef[] = []
  const reserve = Math.min(cfg.maxReportsPerRun, reads.limit) // keep reads for post-write confirmations
  let scannedTo = pages.length ? pages[0].start : count
  for (const p of pages) {
    if (reads.left <= reserve) {
      runtime.log(`ladder scan stopped at index ${p.start} (EVM read budget); the rest is picked up next run`)
      break
    }
    const data = read(vault, encodeFunctionData({ abi: VAULT_ABI, functionName: 'duePendingLadders', args: [BigInt(p.start), BigInt(p.count)] }))
    const refs = decodeFunctionResult({ abi: VAULT_ABI, functionName: 'duePendingLadders', data })
    for (const r of refs) due.push({ station: r.station, date: r.date })
    scannedTo = p.start + p.count
  }
  summary.ladders = { count, scanned: [pages.length ? pages[0].start : count, scannedTo], due: due.length }

  // 2b) Replay targets (no vault ladder): only if the Resolver has no result yet.
  const extra: { icao: string; date: number }[] = []
  for (const e of cfg.extraTargets) {
    if (reads.left <= reserve) break
    const date = ymdToInt(e.date)
    if (Number(resultOf(e.icao, date).status) === STATUS.None) extra.push({ icao: e.icao, date })
    else summary.skipped.push({ icao: e.icao, date, reason: 'already-resolved' })
  }

  // 3) Plan.
  const { targets, skipped } = planTargets(due, extra, cfg, nowSec)
  summary.skipped.push(...skipped)
  if (targets.length === 0) {
    runtime.log(`nothing to settle (ladders=${count}, due=${due.length}, skipped=${summary.skipped.length})`)
    return finish()
  }

  let attesterKey: Hex | undefined
  const key = (): Hex => {
    if (!attesterKey) {
      const raw = runtime.getSecret({ id: 'ISOTHERM_ATTESTER_KEY' }).result().value.trim()
      attesterKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
    }
    return attesterKey
  }

  const fetchStats = (kind: SourceKind, t: Target): SourceStats => {
    calls.take()
    const url = sourceUrl(kind, t.icao, t.ymd, t.station.utcOffsetMin, t.station.tzName)
    const o = http.sendRequest(runtime, fetchSource, observationConsensus())({ kind, url, ymd: t.ymd, utcOffsetMin: t.station.utcOffsetMin }).result()
    return toDayStats(o)
  }

  // 4) Work through targets, oldest first.
  for (const t of targets) {
    const base = { station: t.icao, date: t.date }
    if (!reports.has()) {
      summary.outcomes.push({ ...base, action: 'deferred', reason: 'maxReportsPerRun reached' })
      continue
    }
    if (!calls.has(2)) {
      summary.outcomes.push({ ...base, action: 'deferred', reason: 'HTTP budget (2 calls needed)' })
      continue
    }
    const a = fetchStats('iem', t)
    const b = fetchStats('awc', t)
    let c: SourceStats | null = null
    if (!(a.complete && b.complete)) {
      if (!calls.has(1) || !fallbacks.has(1)) {
        // Never decide (and never VOID) without having consulted the fallback.
        const why = !calls.has(1) ? 'HTTP budget (Ogimet fallback needed)' : `fallback budget (${cfg.maxFallbackCallsPerRun} Ogimet call/run; Ogimet throttles)`
        summary.outcomes.push({ ...base, action: 'deferred', reason: why, sources: { IEM: fmtSrc(a), AWC: fmtSrc(b) } })
        continue
      }
      fallbacks.take()
      c = fetchStats('ogimet', t)
    }
    // VOID is allowed after the 36 h deadline only if every consulted source answered (a fetch failure must never
    // void a ladder), and after the 46 h backstop regardless. settle-core's decide() itself is unchanged.
    const consulted = c ? [a, b, c] : [a, b]
    const allHealthy = consulted.every((s) => s.healthy)
    const allowVoid = (t.pastDeadline && allHealthy) || t.pastHardDeadline
    const d = decide([a, b], c ? [c] : [], allowVoid)
    const named: NamedStats[] = [
      { name: SOURCE_NAME.iem, stats: a },
      { name: SOURCE_NAME.awc, stats: b },
      { name: SOURCE_NAME.ogimet, stats: c },
    ]
    const sources = { IEM: fmtSrc(a), AWC: fmtSrc(b), OGIMET: fmtSrc(c) }
    runtime.log(`${t.icao} ${t.ymd}: ${d.status} (${d.reason}) | IEM ${sources.IEM} | AWC ${sources.AWC} | OGIMET ${sources.OGIMET}`)

    if (d.status === 'PENDING') {
      const why = t.pastDeadline && !allHealthy && !t.pastHardDeadline ? `${d.reason}; past deadline but a source is unavailable: retry` : d.reason
      summary.outcomes.push({ ...base, action: 'pending', reason: why, sources })
      continue
    }
    if (d.status === 'SETTLED' && (d.tmaxC === null || d.tmaxC < -90 || d.tmaxC > 70)) {
      summary.outcomes.push({ ...base, action: 'pending', reason: `implausible tmaxC ${d.tmaxC}`, sources })
      continue
    }

    // 5) Encode + attest. validUntil derives from the anchor (cron scheduled time on a DON), never the node's clock.
    const isVoid = d.status === 'VOID'
    const tmaxC = isVoid ? 0 : (d.tmaxC as number)
    const canonical = canonicalSources(t.icao, t.date, d.status, named)
    const body = { station: t.icao, date: t.date, tmaxC, isVoid, sourcesHash: sourcesHashOf(canonical), validUntil: BigInt(nowSec + cfg.attestationTtlSec) }
    const signed = buildSignedReport(key(), chainId, resolver, body)
    runtime.log(`${t.icao} ${t.ymd}: ${canonical} digest=${signed.digest} validUntil=${body.validUntil}`)

    // 6) DON-signed report -> forwarder -> Resolver.onReport
    reports.take()
    const report = runtime
      .report({ encodedPayload: hexToBase64(signed.payload), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' })
      .result()
    const wr = evm.writeReport(runtime, { receiver: resolver, report, gasConfig: { gasLimit: cfg.gasLimit } }).result()
    const txHash = wr.txHash && wr.txHash.length ? bytesToHex(wr.txHash) : undefined
    const out: TargetOutcome = {
      ...base,
      action: isVoid ? 'voided' : 'settled',
      reason: d.reason,
      tmaxC: isVoid ? null : tmaxC,
      sources,
      sourcesHash: body.sourcesHash,
      validUntil: body.validUntil.toString(),
      txHash,
    }
    if (wr.txStatus !== TxStatus.SUCCESS) {
      runtime.log(`${t.icao} ${t.ymd}: writeReport ${wr.txStatus} ${wr.errorMessage ?? ''}`)
      out.confirmed = 'not-accepted'
      out.reason = `writeReport status ${wr.txStatus}: ${wr.errorMessage ?? ''}`
      summary.outcomes.push(out)
      continue
    }
    // 7) Confirm on chain. The mock (and the real) forwarder swallow a reverting onReport: read the Resolver.
    if (reads.has()) {
      const r = resultOf(t.icao, t.date, LATEST_BLOCK_NUMBER)
      out.onchain = { status: Number(r.status), tmaxC: Number(r.tmaxC) }
      const want = isVoid ? STATUS.Void : STATUS.Settled
      out.confirmed = Number(r.status) === want && (isVoid || Number(r.tmaxC) === tmaxC) ? 'resolved' : 'not-accepted'
    } else {
      out.confirmed = 'unconfirmed'
    }
    runtime.log(`${t.icao} ${t.ymd}: tx ${txHash ?? '-'} -> ${out.confirmed}`)
    summary.outcomes.push(out)
  }
  return finish()
}

export const initWorkflow = (config: Config) => config.schedules.map((schedule) => handler(new CronCapability().trigger({ schedule }), onCron))
