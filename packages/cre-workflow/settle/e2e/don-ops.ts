// Chain-side helpers for scripts/don-cutover.sh and scripts/don-rollback.sh (the DON switch of the v1 Resolver).
// Reads are plain eth_call. The only writes are the Resolver owner calls, sent by `send`, which signs either with the
// key file named by ISOTHERM_OWNER_KEY_FILE (never printed, never on argv) or, on an anvil fork only, from an
// impersonated (unlocked) account.
//
//   bun e2e/don-ops.ts gates     --rpc URL [--now-from chain|clock] [--scan N]
//   bun e2e/don-ops.ts addr      (address of ISOTHERM_OWNER_KEY_FILE; prints the address only)
//   bun e2e/don-ops.ts send      --rpc URL --fn 'setForwarder(address)' --args a[,b] (--unlocked FROM | key file) [--dry]
//   bun e2e/don-ops.ts postcheck --rpc URL --mode don|mock [--org-owner ADDR] [--workflow-id 0x…  (don: the pinned ID, default zero)]
//   bun e2e/don-ops.ts set-active-forwarder --file deployments.json --forwarder ADDR
// Every subcommand ends with one machine-readable line: `[don-ops] {json}`.
import { readFileSync, writeFileSync } from 'node:fs'
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildSignedReport, bytes4ToStation } from '../report'
import { abi, deployments, simulatorHeader } from './chain'
import { productionHeader } from './don-sim'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : undefined
}
const out = (o: unknown) => console.log(`[don-ops] ${JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
const R = abi('Resolver')
const V = abi('CollateralVault')
const RESOLVER = getAddress(deployments.resolver)
const VAULT = getAddress(deployments.vault)
const PROD = getAddress(deployments.keystoneForwarder)
const MOCK = getAddress(deployments.mockForwarder)
const SIM_OWNER = `0x${'aa'.repeat(20)}` as Address // MockKeystoneForwarder's fixed workflow owner
const ZERO32 = `0x${'0'.repeat(64)}` as Hex

const chainFor = (rpc: string, id: number) => ({ id, name: `chain-${id}`, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }) as const
const client = (rpc: string) => createPublicClient({ transport: http(rpc, { timeout: 60_000, retryCount: 3 }) })
const read = (c: ReturnType<typeof client>, address: Address, a: any, functionName: string, a2: unknown[] = []) => c.readContract({ address, abi: a, functionName, args: a2 } as any) as Promise<any>

/** Times the switch must avoid (UTC): the Mac job (:05), the DON's 02:00-local fires (:00) and :30 runs, and the
 *  daily first settlement attempts (RJTT 17:00Z, RCSS 18:00Z). */
export const windowCheck = (t: number): { ok: boolean; reason: string } => {
  const d = new Date(t * 1000)
  const m = d.getUTCMinutes()
  const hm = d.getUTCHours() * 60 + m
  if (hm >= 16 * 60 + 45 && hm <= 18 * 60 + 15) return { ok: false, reason: '16:45-18:15 UTC: the daily first settlement attempts (RJTT 17:00Z, RCSS 18:00Z)' }
  if (m >= 55 || m <= 10) return { ok: false, reason: 'minute :55-:10: the Mac job runs at :05 and the 02:00-local crons fire at :00' }
  if (m >= 25 && m <= 35) return { ok: false, reason: 'minute :25-:35: the DON workflow runs hourly at :30' }
  return { ok: true, reason: 'outside every scheduled run' }
}

const keyFileAccount = () => {
  const f = process.env.ISOTHERM_OWNER_KEY_FILE
  if (!f) throw new Error('ISOTHERM_OWNER_KEY_FILE missing')
  const raw = readFileSync(f, 'utf8').trim()
  return privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex)
}

/** A structurally valid report whose attestation is signed by a public non-attester key: onReport passes the sender
 *  and metadata checks and then reverts InvalidAttestation. Used only in eth_call (nothing is sent). */
const probePayload = () =>
  buildSignedReport('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 10143n, RESOLVER, {
    station: 'RCSS',
    date: 20261001,
    tmaxC: 25,
    isVoid: false,
    sourcesHash: keccak256(stringToBytes('isotherm don-ops postcheck probe')),
    validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
  }).payload

const onReportAs = async (rpc: string, from: Address, metadata: Hex, payload: Hex): Promise<string> => {
  // raw JSON-RPC so the revert data comes back verbatim
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, to: RESOLVER, data: encodeFunctionData({ abi: R, functionName: 'onReport', args: [metadata, payload] }) }, 'latest'] }
  const j = (await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as any
  if (!j.error) return 'accepted'
  const data = (typeof j.error.data === 'string' ? j.error.data : j.error.data?.data) as Hex | undefined
  try {
    return decodeErrorResult({ abi: R, data: data as Hex }).errorName
  } catch {
    return `revert(${String(j.error.message).slice(0, 60)})`
  }
}
const metadataOf = (raw: Hex): Hex => `0x${raw.slice(2 + 45 * 2, 2 + 109 * 2)}` as Hex

async function gates() {
  const rpc = opt('rpc')!
  const c = client(rpc)
  const block = await c.getBlock({ blockTag: 'latest' })
  const now = opt('now-from') === 'clock' ? Math.floor(Date.now() / 1000) : Number(block.timestamp)
  const [owner, paused, forwarder, attester, expectedWorkflowId, expectedWorkflowOwner, count] = await Promise.all([
    read(c, RESOLVER, R, 'owner'),
    read(c, RESOLVER, R, 'paused'),
    read(c, RESOLVER, R, 'forwarder'),
    read(c, RESOLVER, R, 'attester'),
    read(c, RESOLVER, R, 'expectedWorkflowId'),
    read(c, RESOLVER, R, 'expectedWorkflowOwner'),
    read(c, VAULT, V, 'ladderCount'),
  ])
  const n = Number(count)
  const scan = Math.min(n, Number(opt('scan') ?? 16))
  const due = (await read(c, VAULT, V, 'duePendingLadders', [BigInt(n - scan), BigInt(scan)])) as { station: Hex; date: number }[]
  const dueSoon: unknown[] = []
  const challengeOpen: unknown[] = []
  for (let i = n - scan; i < n; i++) {
    const l = await read(c, VAULT, V, 'ladderAt', [BigInt(i)])
    const r = await read(c, RESOLVER, R, 'resultOf', [l.station, l.date])
    const station = bytes4ToStation(l.station)
    if (Number(r.status) === 0) {
      const end = Number(await read(c, RESOLVER, R, 'dayEnd', [l.station, l.date]))
      if (end > now && end <= now + 3600) dueSoon.push({ station, date: l.date, dayEnd: new Date(end * 1000).toISOString() })
    } else if (Number(r.status) === 1 && Number(r.finalAt) > now) {
      challengeOpen.push({ station, date: l.date, finalAt: new Date(Number(r.finalAt) * 1000).toISOString() })
    }
  }
  const window = windowCheck(now)
  const res = {
    now: new Date(now * 1000).toISOString(),
    nowFrom: opt('now-from') === 'clock' ? 'clock' : 'chain',
    block: Number(block.number),
    chainId: await c.getChainId(),
    resolver: { address: RESOLVER, owner, paused, forwarder, forwarderKind: forwarder === PROD ? 'keystone' : forwarder === MOCK ? 'mock' : 'other', attester, expectedWorkflowId, expectedWorkflowOwner },
    ladders: { count: n, scanned: scan, due: due.map((d) => ({ station: bytes4ToStation(d.station), date: d.date })), dueSoon, challengeOpen },
    window,
    nothingDue: due.length === 0 && dueSoon.length === 0,
    challengeClear: challengeOpen.length === 0,
  }
  console.log(`chain ${res.chainId} block ${res.block} at ${res.now} (${res.nowFrom}); Resolver owner ${owner}, paused=${paused}, forwarder ${forwarder} (${res.resolver.forwarderKind}), expectedWorkflow (${expectedWorkflowId}, ${expectedWorkflowOwner})`)
  console.log(`ladders: ${n} (newest ${scan} scanned); due ${JSON.stringify(res.ladders.due)}; due within 1 h ${JSON.stringify(dueSoon)}; challenge window open ${JSON.stringify(challengeOpen)}; time window: ${window.ok ? 'OK' : 'NO'} (${window.reason})`)
  out(res)
}

async function send() {
  const rpc = opt('rpc')!
  const fn = opt('fn')!
  const a = (opt('args') ?? '').split(',').filter(Boolean)
  const unlocked = opt('unlocked') as Address | undefined
  const c = client(rpc)
  const chainId = await c.getChainId()
  const fnAbi = parseAbi([`function ${fn}`])
  const data = encodeFunctionData({ abi: fnAbi, args: a } as any)
  const from = unlocked ? getAddress(unlocked) : keyFileAccount().address
  const gas = await c.estimateGas({ account: from, to: RESOLVER, data })
  const gasLimit = (gas * 12n + 9n) / 10n // Monad bills the limit: estimate x 1.2
  if (args.includes('--dry')) return out({ dry: true, from, to: RESOLVER, fn, args: a, data, estimate: gas, gasLimit })
  const wallet = unlocked
    ? createWalletClient({ chain: chainFor(rpc, chainId), account: from, transport: http(rpc) })
    : createWalletClient({ chain: chainFor(rpc, chainId), account: keyFileAccount(), transport: http(rpc) })
  const hash = await wallet.sendTransaction({ to: RESOLVER, data, gas: gasLimit } as any)
  const r = await c.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: 120_000 })
  console.log(`${fn} ${a.join(',')} from ${from}: tx ${hash} status ${r.status} block ${r.blockNumber} gas limit ${gasLimit}`)
  out({ from, to: RESOLVER, fn, args: a, hash, status: r.status, block: r.blockNumber, gasLimit, estimate: gas })
  if (r.status !== 'success') process.exit(1)
}

async function postcheck() {
  const rpc = opt('rpc')!
  const mode = opt('mode')
  const c = client(rpc)
  const [forwarder, expectedWorkflowId, expectedWorkflowOwner, paused] = await Promise.all([
    read(c, RESOLVER, R, 'forwarder'),
    read(c, RESOLVER, R, 'expectedWorkflowId'),
    read(c, RESOLVER, R, 'expectedWorkflowOwner'),
    read(c, RESOLVER, R, 'paused'),
  ])
  const payload = probePayload()
  const checks: { name: string; got: string; want: string }[] = []
  const add = (name: string, got: string, want: string) => checks.push({ name, got, want })
  if (mode === 'don') {
    const org = getAddress(opt('org-owner')!)
    // --workflow-id: the ID the cutover pinned (--pin-workflow-id), else zero (owner-only pin, any ID accepted)
    const pinnedId = (opt('workflow-id') ?? ZERO32).toLowerCase() as Hex
    const probeId = pinnedId === ZERO32 ? keccak256(stringToBytes('any workflow id')) : pinnedId
    const prodMeta = (owner: Address) => metadataOf(productionHeader({ executionId: ZERO32, timestamp: 0, donId: 1, configVersion: 1, workflowId: probeId, workflowName: 'isotherm-settle', workflowOwner: owner }))
    add('Resolver.forwarder()', forwarder, PROD)
    add('Resolver.expectedWorkflowId()', String(expectedWorkflowId).toLowerCase(), pinnedId)
    add('Resolver.expectedWorkflowOwner()', expectedWorkflowOwner, org)
    add('onReport from the production forwarder, workflow owner = org owner', await onReportAs(rpc, PROD, prodMeta(org), payload), 'InvalidAttestation')
    add('onReport from the production forwarder, workflow owner = 0xaa…aa', await onReportAs(rpc, PROD, prodMeta(SIM_OWNER), payload), 'InvalidWorkflowOwner')
    add('onReport from the MockKeystoneForwarder', await onReportAs(rpc, MOCK, metadataOf(simulatorHeader(ZERO32)), payload), 'InvalidSender')
  } else {
    add('Resolver.forwarder()', forwarder, MOCK)
    add('Resolver.expectedWorkflowId()', expectedWorkflowId, ZERO32)
    add('Resolver.expectedWorkflowOwner()', expectedWorkflowOwner, zeroAddress)
    add('onReport from the MockKeystoneForwarder (simulator metadata)', await onReportAs(rpc, MOCK, metadataOf(simulatorHeader(ZERO32)), payload), 'InvalidAttestation')
    add('onReport from the production forwarder', await onReportAs(rpc, PROD, metadataOf(simulatorHeader(ZERO32)), payload), 'InvalidSender')
  }
  if (paused) add('Resolver.paused()', 'true', 'false')
  for (const k of checks) console.log(`  ${k.got === k.want ? 'OK  ' : 'FAIL'} ${k.name}: ${k.got}${k.got === k.want ? '' : ` (want ${k.want})`}`)
  console.log('  (InvalidAttestation = the sender and workflow metadata were accepted; the probe carries a non-attester signature on purpose)')
  const ok = checks.every((k) => k.got === k.want)
  out({ mode, ok, checks })
  if (!ok) process.exit(1)
}

function setActiveForwarder() {
  const file = opt('file')!
  const fwd = getAddress(opt('forwarder')!)
  const d = JSON.parse(readFileSync(file, 'utf8'))
  if (![getAddress(d.mockForwarder), getAddress(d.keystoneForwarder)].includes(fwd)) throw new Error(`${fwd} is neither mockForwarder nor keystoneForwarder`)
  const before = d.activeForwarder
  d.activeForwarder = fwd
  writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`)
  out({ file, activeForwarder: { before, after: fwd } })
}

const main: Record<string, () => unknown> = {
  gates,
  send,
  postcheck,
  'set-active-forwarder': setActiveForwarder,
  addr: () => console.log(keyFileAccount().address),
}
if (import.meta.main) {
  if (!main[cmd]) {
    console.error('usage: bun e2e/don-ops.ts gates|addr|send|postcheck|set-active-forwarder ...')
    process.exit(2)
  }
  await main[cmd]()
}
