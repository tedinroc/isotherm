// Evidence records for settlements delivered by a Chainlink DON (path "don"), read from the chain, so a DON run is
// documented the same way the Mac job documents its own runs (settle-runs.jsonl, path "official" or
// "harness-fallback"). Each LadderResolved is classified by its `caller` field, which is the Resolver's msg.sender,
// i.e. the forwarder that called onReport (or the account that called voidIfStale):
//   KeystoneForwarder 0xF834…4482  -> path "don"   (DON transmitter, f+1 DON signatures, workflow id/owner in metadata)
//   MockKeystoneForwarder 0xB9F7…d192 -> path "mac" (CRE CLI simulation or harness on the Mac: see settle-runs.jsonl)
//   anything else (voidIfStale)    -> path "stale-void"
// The attestation signer is compared with Resolver.attester() at the settlement's own block, so a later attester
// rotation does not change an old record.
// Records are appended to <out>/don-runs.jsonl (one per tx, de-duplicated); "don" ones also get
// <out>/settlement-<ICAO>-<date>-don.json. Read-only: eth_getLogs (<= 100 blocks per call), eth_getTransaction(Receipt).
//   bun e2e/don-evidence.ts --rpc URL --out DIR [--ladders N] [--from-block A --to-block B] [--cre-executions FILE]
//   --ladders N   newest N vault ladders that have a result; the block is found from Result.resolvedAt (default 8)
//   --cre-executions FILE   optional `cre execution list --output json` capture; the closest SUCCESS run is attached
//   bun e2e/don-evidence.ts --rpc URL --tx HASH   diagnose one forwarder report tx, accepted or not (prints only)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, createPublicClient, decodeEventLog, decodeFunctionData, getAddress, http, parseAbi, recoverAddress, slice, hexToString, zeroAddress } from 'viem'
import { bytes4ToStation, decodeReport, settlementDigest } from '../report'
import { abi, deployments } from './chain'
import { KEYSTONE_ABI } from './don-sim'

const args = process.argv.slice(2)
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : undefined
}
const rpc = opt('rpc') ?? 'https://testnet-rpc.monad.xyz'
const outDir = opt('out') ?? 'var/evidence'
const c = createPublicClient({ transport: http(rpc, { timeout: 60_000, retryCount: 3 }) })
const R = abi('Resolver')
const V = abi('CollateralVault')
const RESOLVER = getAddress(deployments.resolver)
const PROD = getAddress(deployments.keystoneForwarder)
const MOCK = getAddress(deployments.mockForwarder)
const LADDER_RESOLVED = parseAbi(['event LadderResolved(bytes4 indexed station, uint32 indexed date, uint8 status, int16 tmaxC, bytes32 sourcesHash, address caller)'])
const STATUS = ['None', 'Settled', 'Void']
const network = rpc === 'https://testnet-rpc.monad.xyz' ? 'LIVE Monad testnet 10143' : `anvil fork (${rpc})`
const read = (address: Address, a: any, functionName: string, a2: unknown[] = []) => c.readContract({ address, abi: a, functionName, args: a2 } as any) as Promise<any>

/** First block whose timestamp is >= t (binary search; Monad testnet makes ~2.5 blocks per second). */
const blockAtOrAfter = async (t: number, hi: bigint) => {
  let lo = hi > 3_000_000n ? hi - 3_000_000n : 0n
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    if (Number((await c.getBlock({ blockNumber: mid })).timestamp) >= t) hi = mid
    else lo = mid
  }
  return hi
}
const logsIn = async (from: bigint, to: bigint, topics?: (Hex | null)[]) => {
  const all: any[] = []
  for (let a = from; a <= to; a += 100n) {
    const b = a + 99n < to ? a + 99n : to
    all.push(...(await c.getLogs({ address: RESOLVER, event: LADDER_RESOLVED[0], fromBlock: a, toBlock: b, args: topics ? { station: topics[0] ?? undefined, date: topics[1] ?? undefined } : undefined } as any)))
  }
  return all
}

const executions: any[] = (() => {
  const f = opt('cre-executions')
  if (!f || !existsSync(f)) return []
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    return Array.isArray(j) ? j : []
  } catch {
    return []
  }
})()

const describeLog = async (log: any) => {
  const tx = await c.getTransaction({ hash: log.transactionHash })
  const rc = await c.getTransactionReceipt({ hash: log.transactionHash })
  const block = await c.getBlock({ blockNumber: rc.blockNumber })
  const ev = decodeEventLog({ abi: LADDER_RESOLVED, data: log.data, topics: log.topics }).args as any
  const to = tx.to ? getAddress(tx.to) : null
  const caller = getAddress(ev.caller)
  const path = caller === PROD ? 'don' : caller === MOCK ? 'mac' : 'stale-void'
  const base: Record<string, unknown> = {
    path,
    pathLabel:
      path === 'don'
        ? 'DON: the Isotherm CRE workflow deployed to a Chainlink DON (private registry); report delivered by the DON transmitter through KeystoneForwarder 0xF834…4482 with DON signatures, plus the v1 EIP-712 attestation'
        : path === 'mac'
          ? 'MAC: delivered through the MockKeystoneForwarder by the Mac job (CRE CLI simulation, or the labelled harness fallback; settle-runs.jsonl names which)'
          : 'STALE VOID: voidIfStale, no report',
    network,
    station: bytes4ToStation(ev.station),
    date: Number(ev.date),
    status: STATUS[Number(ev.status)],
    tmaxC: Number(ev.tmaxC),
    sourcesHash: ev.sourcesHash,
    txHash: log.transactionHash,
    block: Number(rc.blockNumber),
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    caller,
    sender: tx.from,
    to,
    gasLimit: Number(tx.gas),
  }
  // report(address,bytes,bytes,bytes[]) = 0x11289565, sent straight to the forwarder (the DON transmitter and the
  // CRE simulator both do); anything else keeps the chain-level fields only
  if (path === 'stale-void' || to !== caller || !tx.input.startsWith('0x11289565')) return base
  const { args: a } = decodeFunctionData({ abi: KEYSTONE_ABI, data: tx.input }) as any
  const raw = a[1] as Hex
  const processed = rc.logs
    .filter((l) => getAddress(l.address) === to)
    .map((l) => decodeEventLog({ abi: KEYSTONE_ABI, data: l.data, topics: l.topics }).args as any)[0]
  const payload = slice(raw, 109)
  const body = decodeReport(payload)
  const signer = await recoverAddress({ hash: settlementDigest(10143n, RESOLVER, body), signature: body.signature })
  const attester = (await c.readContract({ address: RESOLVER, abi: R, functionName: 'attester', blockNumber: rc.blockNumber } as any).catch(() => read(RESOLVER, R, 'attester'))) as Address
  Object.assign(base, {
    report: {
      workflowExecutionId: slice(raw, 1, 33),
      reportTimestamp: new Date(Number(BigInt(slice(raw, 33, 37))) * 1000).toISOString(),
      donId: Number(BigInt(slice(raw, 37, 41))),
      donConfigVersion: Number(BigInt(slice(raw, 41, 45))),
      workflowId: slice(raw, 45, 77),
      workflowNameField: hexToString(slice(raw, 77, 87)),
      workflowOwner: getAddress(slice(raw, 87, 107)),
      reportId: slice(raw, 107, 109),
      signatures: (a[3] as Hex[]).length,
      signaturesCheckedBy: path === 'don' ? 'KeystoneForwarder: f+1 signers of the registered DON config' : 'nobody: the MockKeystoneForwarder ignores signatures (the attestation is the check)',
      reportContextBytes: (a[2].length - 2) / 2,
      validUntil: new Date(Number(body.validUntil) * 1000).toISOString(),
    },
    reportProcessed: processed?.result ?? null,
    attestation: { signer, attesterAtBlock: attester, matches: getAddress(signer) === getAddress(attester) },
  })
  if (path === 'don' && executions.length) {
    const t = Number(block.timestamp) * 1000
    const near = executions
      .filter((e) => e.status === 'SUCCESS' && Date.parse(e.startedAt) <= t && t - Date.parse(e.startedAt) < 15 * 60_000)
      .sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt))[0]
    if (near) base.creExecution = { uuid: near.uuid, status: near.status, startedAt: near.startedAt, finishedAt: near.finishedAt ?? null, workflowName: near.workflowName }
  }
  return base
}

/** --tx HASH: diagnose ONE forwarder report transaction, accepted or not (a rejected report emits no LadderResolved,
 *  so the ladder scan cannot see it). Prints the workflow ID/owner the report carried next to the Resolver's pins. */
if (opt('tx')) {
  const hash = opt('tx') as Hex
  const tx = await c.getTransaction({ hash })
  const rc = await c.getTransactionReceipt({ hash })
  if (!tx.input.startsWith('0x11289565')) throw new Error(`${hash} is not a forwarder report() call`)
  const { args: a } = decodeFunctionData({ abi: KEYSTONE_ABI, data: tx.input }) as any
  if (getAddress(a[0]) !== RESOLVER) throw new Error(`${hash} delivers to ${a[0]}, not the Isotherm Resolver ${RESOLVER}`)
  const raw = a[1] as Hex
  const to = tx.to ? getAddress(tx.to) : null
  const processed = rc.logs.filter((l) => getAddress(l.address) === to).map((l) => decodeEventLog({ abi: KEYSTONE_ABI, data: l.data, topics: l.topics }).args as any)[0]
  const body = decodeReport(slice(raw, 109))
  const at = { blockNumber: rc.blockNumber }
  const pin = async (fn: string) => (await c.readContract({ address: RESOLVER, abi: R, functionName: fn, ...at } as any)) as string
  const diag = {
    txHash: hash,
    block: Number(rc.blockNumber),
    forwarder: to === PROD ? 'KeystoneForwarder (DON)' : to === MOCK ? 'MockKeystoneForwarder (Mac)' : to,
    receiver: a[0],
    reportProcessed: processed?.result ?? null,
    station: body.station,
    date: Number(body.date),
    tmaxC: Number(body.tmaxC),
    isVoid: body.isVoid,
    report: { workflowId: slice(raw, 45, 77), workflowOwner: getAddress(slice(raw, 87, 107)), donId: Number(BigInt(slice(raw, 37, 41))), signatures: (a[3] as Hex[]).length },
    resolverAtBlock: { forwarder: await pin('forwarder'), expectedWorkflowId: await pin('expectedWorkflowId'), expectedWorkflowOwner: await pin('expectedWorkflowOwner'), attester: await pin('attester') },
  }
  const hints: string[] = []
  if (diag.resolverAtBlock.forwarder !== to) hints.push('the Resolver pointed at another forwarder (InvalidSender)')
  if (diag.resolverAtBlock.expectedWorkflowOwner !== zeroAddress && getAddress(diag.resolverAtBlock.expectedWorkflowOwner) !== diag.report.workflowOwner)
    hints.push(`the report's workflow owner ${diag.report.workflowOwner} is not the pinned owner (InvalidWorkflowOwner): fix with setExpectedWorkflow(0x00…00, ${diag.report.workflowOwner}) only if the report's workflow ID ${diag.report.workflowId} is our deployed one (cre workflow get); otherwise it came from another workflow and the pin did its job`)
  const signer = await recoverAddress({ hash: settlementDigest(10143n, RESOLVER, body), signature: body.signature })
  if (getAddress(signer) !== getAddress(diag.resolverAtBlock.attester)) hints.push(`attestation signed by ${signer}, not the attester (InvalidAttestation)`)
  console.log(JSON.stringify({ ...diag, attestationSigner: signer, hints }, null, 2))
  console.log(`[don-evidence] ${JSON.stringify({ tx: hash, reportProcessed: diag.reportProcessed, hints: hints.length })}`)
  process.exit(0)
}

const logs: any[] = []
const latest = await c.getBlockNumber()
if (opt('from-block')) {
  logs.push(...(await logsIn(BigInt(opt('from-block')!), BigInt(opt('to-block') ?? latest))))
} else {
  const n = Number(await read(getAddress(deployments.vault), V, 'ladderCount'))
  const want = Number(opt('ladders') ?? 8)
  let found = 0
  for (let i = n - 1; i >= 0 && found < want; i--) {
    const l = await read(getAddress(deployments.vault), V, 'ladderAt', [BigInt(i)])
    const r = await read(RESOLVER, R, 'resultOf', [l.station, l.date])
    if (Number(r.status) === 0) continue
    found++
    const b = await blockAtOrAfter(Number(r.resolvedAt), latest)
    const hits = await logsIn(b > 20n ? b - 20n : 0n, b + 79n > latest ? latest : b + 79n, [l.station, l.date])
    if (!hits.length) console.log(`  ${bytes4ToStation(l.station)} ${l.date}: resolved at ${new Date(Number(r.resolvedAt) * 1000).toISOString()} but no LadderResolved found near block ${b}`)
    logs.push(...hits)
  }
}

mkdirSync(outDir, { recursive: true })
const file = join(outDir, 'don-runs.jsonl')
const seen = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).txHash) : [])
let added = 0
for (const log of logs) {
  const rec = { recordedAt: new Date().toISOString(), ...(await describeLog(log)) } as any
  const tag = `${rec.path.padEnd(10)} ${rec.station} ${rec.date} ${rec.status}${rec.status === 'Settled' ? ` ${rec.tmaxC} C` : ''} tx ${rec.txHash} block ${rec.block} from ${rec.sender}${rec.report ? ` (${rec.report.signatures} ${rec.path === 'don' ? 'DON' : 'unchecked simulator'} sigs, workflow owner ${rec.report.workflowOwner}, ReportProcessed.result=${rec.reportProcessed}, attestation ${rec.attestation.matches ? 'by the attester' : 'NOT by the attester'})` : ''}`
  if (seen.has(rec.txHash)) {
    console.log(`  known  ${tag}`)
    continue
  }
  appendFileSync(file, `${JSON.stringify(rec)}\n`)
  if (rec.path === 'don') writeFileSync(join(outDir, `settlement-${rec.station}-${rec.date}-don.json`), `${JSON.stringify(rec, null, 2)}\n`)
  seen.add(rec.txHash)
  added++
  console.log(`  NEW    ${tag}`)
}
console.log(`[don-evidence] ${JSON.stringify({ scanned: logs.length, added, file })}`)
