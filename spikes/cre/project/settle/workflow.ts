// Isotherm settlement workflow (Chainlink CRE, TypeScript SDK).
//
//   cron ─▶ EVM read Resolver.resultOf(station,date)    (skip if already resolved / stub if no resolver)
//        ─▶ HTTP (node mode, DON consensus) IEM ASOS raw METAR      ─┐
//        ─▶ HTTP (node mode, DON consensus) aviationweather.gov METAR ┴▶ agree-or-void
//        ─▶ runtime.report(abi.encode(station,date,tmaxC,isVoid,sourcesHash,attestation))   (== src/Resolver.sol)
//        ─▶ EVM writeReport ─▶ (Mock)KeystoneForwarder.report ─▶ Resolver.onReport(metadata, report)
import {
  bytesToHex,
  ConsensusAggregationByFields,
  CronCapability,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  HTTPClient,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  median,
  TxStatus,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk'
import { type Address, type Hex, decodeFunctionResult, encodeFunctionData, zeroAddress } from 'viem'
import { z } from 'zod'
import {
  awcUrl,
  decide,
  iemUrl,
  localDayWindow,
  parseAwcRaw,
  parseIemCsv,
  previousLocalDate,
  type SourceResult,
  ymdToInt,
} from './metar'
import { encodeReport, settlementDigest, signDigest, sourcesHash, stationToBytes4, type SettlementBody } from './report'

// ─── Config ──────────────────────────────────────────────────────────────
export const configSchema = z.object({
  schedule: z.string(),
  chainSelectorName: z.string(), // "monad-testnet"
  chainId: z.string(), // "10143" — bound into the EIP-712 domain of the attestation
  resolverAddress: z.string(),
  readSettled: z.boolean().default(true), // false = stub the EVM read (no Resolver deployed yet)
  gasLimit: z.string(), // Monad bills the gas LIMIT: keep it tight
  iemBaseUrl: z.string(),
  awcBaseUrl: z.string(),
  minObs: z.number().int().positive(), // per-source coverage floor (RCSS: 48 half-hourly METARs/day)
  dateOverride: z.string().optional(), // "2026-10-05" for replays; otherwise "yesterday" in station time
  stations: z
    .array(z.object({ icao: z.string().length(4), tzOffsetMin: z.number().int() }))
    .min(1)
    .max(7), // 2 HTTP calls per station, CRE quota = 15 HTTP calls / execution
})
export type Config = z.infer<typeof configSchema>

// Read surface of isotherm/src/Resolver.sol (IIsothermResolver.resultOf). status: 0 None, 1 Settled, 2 Void
export const RESOLVER_ABI = [
  {
    type: 'function',
    name: 'resultOf',
    stateMutability: 'view',
    inputs: [
      { name: 'station', type: 'bytes4' },
      { name: 'date', type: 'uint32' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'status', type: 'uint8' },
          { name: 'tmaxC', type: 'int16' },
          { name: 'resolvedAt', type: 'uint64' },
          { name: 'sourcesHash', type: 'bytes32' },
        ],
      },
    ],
  },
] as const

// ─── Node-mode fetchers (run on every DON node, then aggregated) ─────────
type FetchArgs = { url: string; station: string; ymd: string; tzOffsetMin: number }

const decode = (body: Uint8Array) => new TextDecoder().decode(body)

export const fetchIem = (req: HTTPSendRequester, a: FetchArgs): SourceResult => {
  const resp = req.sendRequest({ url: a.url, method: 'GET' }).result()
  if (resp.statusCode !== 200) throw new Error(`IEM HTTP ${resp.statusCode}`)
  return parseIemCsv(decode(resp.body), a.station, localDayWindow(a.ymd, a.tzOffsetMin))
}

export const fetchAwc = (req: HTTPSendRequester, a: FetchArgs): SourceResult => {
  const resp = req.sendRequest({ url: a.url, method: 'GET' }).result()
  if (resp.statusCode !== 200) throw new Error(`AWC HTTP ${resp.statusCode}`)
  return parseAwcRaw(decode(resp.body), a.station, localDayWindow(a.ymd, a.tzOffsetMin))
}

// Each node returns {tmax, obs}; the DON agrees on the median of each field (BFT against a lying node).
const sourceConsensus = () => ConsensusAggregationByFields<SourceResult>({ tmax: median, obs: median })

// ─── Handler ─────────────────────────────────────────────────────────────
type StationOutcome = Record<string, unknown>

export const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainSelectorName })
  if (!network) throw new Error(`unknown chain ${cfg.chainSelectorName}`)
  const evm = new EVMClient(network.chainSelector.selector)
  const http = new HTTPClient()
  const resolver = cfg.resolverAddress as Address
  const rawKey = runtime.getSecret({ id: 'ISOTHERM_ATTESTER_KEY' }).result().value.trim()
  const attesterKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex

  const outcomes: StationOutcome[] = []
  for (const st of cfg.stations) {
    const ymd = cfg.dateOverride ?? previousLocalDate(runtime.now().getTime(), st.tzOffsetMin)
    const date = ymdToInt(ymd)
    const w = localDayWindow(ymd, st.tzOffsetMin)

    // 1) EVM read: is this city-day already resolved?
    if (cfg.readSettled) {
      const call = evm
        .callContract(runtime, {
          call: encodeCallMsg({
            from: zeroAddress,
            to: resolver,
            data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'resultOf', args: [stationToBytes4(st.icao), date] }),
          }),
          blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
        })
        .result()
      const res = decodeFunctionResult({ abi: RESOLVER_ABI, functionName: 'resultOf', data: bytesToHex(call.data) })
      if (res.status !== 0) {
        runtime.log(`${st.icao} ${ymd}: already resolved (status=${res.status}), skip`)
        outcomes.push({ station: st.icao, date, skipped: 'already-resolved' })
        continue
      }
    } else {
      runtime.log(`${st.icao} ${ymd}: readSettled=false (EVM read stubbed)`)
    }

    // 2) Two independent HTTP sources, each DON-aggregated
    const base = { station: st.icao, ymd, tzOffsetMin: st.tzOffsetMin }
    const iem = http.sendRequest(runtime, fetchIem, sourceConsensus())({ ...base, url: iemUrl(cfg.iemBaseUrl, st.icao, w) }).result()
    const awc = http.sendRequest(runtime, fetchAwc, sourceConsensus())({ ...base, url: awcUrl(cfg.awcBaseUrl, st.icao, w) }).result()
    runtime.log(`${st.icao} ${ymd}: IEM tmax=${iem.tmax} obs=${iem.obs} | AWC tmax=${awc.tmax} obs=${awc.obs}`)

    // 3) Agree-or-void
    const d = decide(iem, awc, cfg.minObs)
    if (d.kind === 'retry') {
      runtime.log(`${st.icao} ${ymd}: no report (${d.reason}); next cron run retries`)
      outcomes.push({ station: st.icao, date, skipped: d.reason })
      continue
    }

    // 4) Encode + EIP-712 attestation (required while the permissionless MockKeystoneForwarder is in use)
    const body: SettlementBody = { station: st.icao, date, tmaxC: d.tmaxC, isVoid: d.isVoid, sourcesHash: sourcesHash(iem, awc) }
    const attestation = signDigest(attesterKey, settlementDigest(BigInt(cfg.chainId), resolver, body))
    const payload = encodeReport(body, attestation)
    runtime.log(`${st.icao} ${ymd}: report payload ${payload}`)

    // 5) DON-signed report → forwarder → Resolver.onReport
    const report = runtime
      .report({ encodedPayload: hexToBase64(payload), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' })
      .result()
    const wr = evm.writeReport(runtime, { receiver: resolver, report, gasConfig: { gasLimit: cfg.gasLimit } }).result()
    const txHash = bytesToHex(wr.txHash ?? new Uint8Array(32))
    // NOTE: TX_STATUS_SUCCESS only means the forwarder tx did not revert. Mock/Keystone forwarders swallow a
    // reverting onReport and emit ReportProcessed(result=false); confirm via Resolver.LadderResolved / resultOf.
    if (wr.txStatus !== TxStatus.SUCCESS) throw new Error(`writeReport ${wr.txStatus}: ${wr.errorMessage ?? ''}`)
    runtime.log(`${st.icao} ${ymd}: writeReport tx ${txHash}`)
    outcomes.push({ station: st.icao, date, tmaxC: d.tmaxC, isVoid: d.isVoid, sourcesHash: body.sourcesHash, txHash })
  }
  return JSON.stringify(outcomes)
}

export const initWorkflow = (config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)]
