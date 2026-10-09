// FORK ONLY (refuses anything but a loopback anvil). Used by scripts/don-rehearse-fork.sh.
//   setup   : public test attester on the Resolver; test DON (donId 1, configVersion 1, f = 3, 10 signers) on the
//             production KeystoneForwarder. Both owners are impersonated on the fork.
//   prepare : moves the fork's clock to the next moment a cutover is allowed (the gates of scripts/don-cutover.sh) at
//             least --lead seconds ahead. Any vault ladder that falls due on the way is settled first through the Mac
//             path (MockKeystoneForwarder, test attester) at day end + 2 h 5 min, as the hourly Mac job would.
//             Prints {safe, unsafe (12 min earlier, inside the :25-:35 block), settledOnTheWay}; it does not warp to
//             `safe` itself, so the caller can test the refusal at `unsafe` first.
//   target  : the next vault ladder still open after the switch (the first DON settlement), with its first DON
//             attempt time (day end + 2 h + 30 s, the 02:00-local cron); falls back to the next RCSS day if the vault
//             has none
//   mock-target --station RJTT : a station-date whose day is over and that has no result (for a Mac-path check)
//   don     : deliver a DON-signed report (production header, 4 signatures) through the production forwarder
//   mock    : deliver a report through the MockKeystoneForwarder with the CRE simulator's header (the Mac path)
//   warp    : move the fork's clock so the latest block is at an ISO time (mines 80 blocks so the finalized tag follows)
//   transfer-owner : Resolver ownership to an anvil dev account (Ownable2Step: transfer + accept), for the key-file rehearsal
//   bun e2e/don-fork-deliver.ts <mode> --rpc URL [--station RCSS --date 20261009 --tmax 27 --gas 420000]
//                                          [--org-owner 0x.. --workflow-id 0x..] [--at ISO] [--to 0x..] [--lead S]
import { type Address, type Hex, concat, decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, stringToBytes, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { intToYmd } from '../plan'
import { buildSignedReport, bytes4ToStation, stationToBytes4 } from '../report'
import { TEST_ATTESTER_KEY } from '../test/helpers'
import { FORWARDER_ABI, abi, deployments, makeRpc, simulatorHeader } from './chain'
import { windowCheck } from './don-ops'
import { KEYSTONE_ABI, addressOf, donSign, forkSignerKeys, productionHeader, reportCalldata, reportContextFor } from './don-sim'

const args = process.argv.slice(2)
const mode = args[0]
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : undefined
}
const url = opt('rpc') ?? ''
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error('fork only: --rpc must be a loopback anvil')
const rpc = makeRpc(url)
if (!String(rpc.call('web3_clientVersion')).toLowerCase().includes('anvil')) throw new Error('fork only: not an anvil node')
const R = abi('Resolver')
const V = abi('CollateralVault')
const RESOLVER = deployments.resolver as Address
const VAULT = deployments.vault as Address
const PROD = deployments.keystoneForwarder as Address
const MOCK = deployments.mockForwarder as Address
const OWNER = deployments.roles.owner as Address
const TRANSMITTER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address // anvil dev account #2
const view = (to: Address, a: any, functionName: string, a2: unknown[] = []) =>
  rpc.call('eth_call', [{ to, data: encodeFunctionData({ abi: a, functionName, args: a2 } as any) }, 'latest'])
const read = (to: Address, a: any, functionName: string, a2: unknown[] = []): any =>
  decodeFunctionResult({ abi: a, functionName, data: view(to, a, functionName, a2) } as any)
const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z')

const outcome = (rcpt: any, forwarder: Address) => {
  const processed = rcpt.logs.filter((l: any) => l.address.toLowerCase() === forwarder.toLowerCase()).map((l: any) => decodeEventLog({ abi: KEYSTONE_ABI, data: l.data, topics: l.topics }).args.result)
  const resolved = rcpt.logs.filter((l: any) => l.address.toLowerCase() === RESOLVER.toLowerCase()).map((l: any) => (decodeEventLog({ abi: R, data: l.data, topics: l.topics }) as any).args)
  return { status: rcpt.status, gasUsed: Number(BigInt(rcpt.gasUsed)), reportProcessed: processed[0] ?? null, ladderResolved: resolved[0] ? { status: Number(resolved[0].status), tmaxC: Number(resolved[0].tmaxC), caller: resolved[0].caller } : null }
}
const bodyFor = (station: string, date: number, tmaxC: number) => {
  const now = rpc.blockTime()
  return {
    station,
    date,
    tmaxC,
    isVoid: false,
    sourcesHash: keccak256(stringToBytes(`isotherm-sources-v1|fork-rehearsal|${station}|${date}`)),
    validUntil: BigInt(now + 1500),
  }
}
const print = (o: unknown) => console.log(`[fork] ${JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)

/** The Mac path: simulator header, test attester, MockKeystoneForwarder, 200k gas (what run-official.sh sends). */
const deliverMock = (station: string, date: number, tmaxC: number, gas = 200_000n) => {
  const b = bodyFor(station, date, tmaxC)
  const { payload } = buildSignedReport(TEST_ATTESTER_KEY, 10143n, RESOLVER, b)
  const raw = concat([simulatorHeader(keccak256(stringToBytes(`fork-rehearsal-mock-${b.station}-${b.date}-${rpc.blockTime()}`))), payload])
  const { hash, rcpt } = rpc.send(TRANSMITTER, MOCK, encodeFunctionData({ abi: FORWARDER_ABI, functionName: 'report', args: [RESOLVER, raw, '0x', []] }), gas)
  return { path: 'mock', forwarder: MOCK, station: b.station, date: b.date, tmaxC: b.tmaxC, gasLimit: Number(gas), tx: hash, ...outcome(rcpt, MOCK) }
}
/** warpTo mines 80 blocks 1 s apart (so the finalized tag follows); start 79 s early so the last block is at `t`. */
const warp = (t: number) => {
  if (t - 79 <= rpc.blockTime()) throw new Error(`cannot warp backwards to ${iso(t)}`)
  rpc.warpTo(t - 79)
}
const offsetOf = (station: string) => Number(deployments.stations[station].utcOffsetSeconds)
const localDate = (station: string, t: number) => Number(new Date((t + offsetOf(station)) * 1000).toISOString().slice(0, 10).replace(/-/g, ''))
const dayEnd = (station: string, date: number) => Number(read(RESOLVER, R, 'dayEnd', [stationToBytes4(station), date]))
const resultOf = (station: string, date: number) => read(RESOLVER, R, 'resultOf', [stationToBytes4(station), date]) as { status: number; finalAt: bigint }
type Ladder = { station: string; date: number; end: number; status: number; finalAt: number }
const ladders = (): Ladder[] => {
  const n = Number(read(VAULT, V, 'ladderCount'))
  return Array.from({ length: n }, (_, i) => {
    const l = read(VAULT, V, 'ladderAt', [BigInt(i)]) as { station: Hex; date: number }
    const station = bytes4ToStation(l.station)
    const r = resultOf(station, Number(l.date))
    return { station, date: Number(l.date), end: dayEnd(station, Number(l.date)), status: Number(r.status), finalAt: Number(r.finalAt) }
  })
}
/** first minute-40 at or after t (:40 is outside the :55-:10 and :25-:35 blocks) */
const nextMinute40 = (t: number) => {
  const h = Math.floor(t / 3600) * 3600
  return h + 2400 >= t ? h + 2400 : h + 3600 + 2400
}

if (mode === 'setup') {
  rpc.impersonate(OWNER)
  rpc.write(OWNER, RESOLVER, R, 'setAttester', [privateKeyToAccount(TEST_ATTESTER_KEY).address], 200_000n)
  const fOwner = `0x${(view(PROD, KEYSTONE_ABI, 'owner') as string).slice(26)}` as Address
  rpc.impersonate(fOwner)
  rpc.write(fOwner, PROD, KEYSTONE_ABI as any, 'setConfig', [1, 1, 3, forkSignerKeys(10, 'isotherm-fork-don-signer-v1').map(addressOf)], 3_000_000n)
  rpc.call('anvil_setBalance', [TRANSMITTER, toHex(10n ** 20n)])
  rpc.call('anvil_setBalance', [privateKeyToAccount(TEST_ATTESTER_KEY).address, toHex(10n ** 18n)]) // run-official.sh preflight wants >= 0.025 MON
  print({ setup: 'ok', attester: privateKeyToAccount(TEST_ATTESTER_KEY).address, forwarderOwnerImpersonated: fOwner, testDon: { donId: 1, configVersion: 1, f: 3, signers: 10 } })
} else if (mode === 'prepare') {
  const lead = Number(opt('lead') ?? 900)
  const settledOnTheWay: unknown[] = []
  for (let iter = 0; iter < 8; iter++) {
    const now = rpc.blockTime()
    const all = ladders()
    const pending = all.filter((l) => l.status === 0)
    const due = pending.filter((l) => l.end <= now)
    if (due.length) {
      // the Mac job's first attempt is at its :05 run after day end + 2 h
      const at = Math.max(...due.map((l) => l.end + 7200 + 300))
      if (at - 79 > now) warp(at)
      else rpc.call('anvil_mine', [toHex(1), toHex(1)])
      for (const l of due) settledOnTheWay.push({ ...deliverMock(l.station, l.date, 27), at: iso(rpc.blockTime()), why: 'due on the way: settled through the Mac path, as the hourly job would' })
      continue
    }
    // after every open challenge window, at minute :40, outside the time blocks
    const lastFinal = Math.max(0, ...all.filter((l) => l.status === 1).map((l) => l.finalAt))
    let t = nextMinute40(Math.max(now + lead, lastFinal + 60))
    for (let k = 0; k < 48 && !windowCheck(t).ok; k++) t += 3600
    // nothing may be due, or due within the hour after t: otherwise pass that day end and settle it like the Mac job
    const soon = pending.filter((l) => l.end <= t + 3600)
    if (soon.length) {
      warp(Math.max(Math.min(...soon.map((l) => l.end)) + 1, now + 80))
      continue
    }
    print({ now: iso(now), safe: iso(t), unsafe: iso(t - 720), settledOnTheWay, ladders: all.map((l) => `${l.station} ${l.date} ${['open', 'Settled', 'Void'][l.status]}`) })
    process.exit(0)
  }
  throw new Error('prepare: no cutover window found')
} else if (mode === 'target') {
  const now = rpc.blockTime()
  const open = ladders()
    .filter((l) => l.status === 0 && l.end > now)
    .sort((a, b) => a.end - b.end)[0]
  if (open) print({ station: open.station, date: open.date, inVault: true, attemptAt: iso(open.end + 7200 + 30), dayEnd: iso(open.end) })
  else {
    // no open vault ladder: the next RCSS day that ends at least an hour from now
    let d = localDate('RCSS', now)
    while (dayEnd('RCSS', d) <= now + 3600) d = localDate('RCSS', dayEnd('RCSS', d) + 1)
    print({ station: 'RCSS', date: d, inVault: false, attemptAt: iso(dayEnd('RCSS', d) + 7200 + 30), dayEnd: iso(dayEnd('RCSS', d)) })
  }
} else if (mode === 'mock-target') {
  const station = opt('station') ?? 'RJTT'
  const now = rpc.blockTime()
  for (let back = 0; back <= 14; back++) {
    const d = localDate(station, now - back * 86400)
    if (dayEnd(station, d) <= now && Number(resultOf(station, d).status) === 0) {
      print({ station, date: d, ymd: intToYmd(d), dayEnd: iso(dayEnd(station, d)) })
      process.exit(0)
    }
  }
  throw new Error(`mock-target: no open ${station} day in the last 14 days`)
} else if (mode === 'don') {
  const b = bodyFor(opt('station') ?? 'RCSS', Number(opt('date')), Number(opt('tmax') ?? 27))
  const { payload } = buildSignedReport(TEST_ATTESTER_KEY, 10143n, RESOLVER, b)
  const raw = concat([
    productionHeader({ executionId: keccak256(stringToBytes(`fork-rehearsal-${b.station}-${b.date}-${rpc.blockTime()}-${opt('org-owner')}`)), timestamp: rpc.blockTime(), donId: 1, configVersion: 1, workflowId: (opt('workflow-id') ?? keccak256(stringToBytes('isotherm-settle fork test workflow id'))) as Hex, workflowName: 'isotherm-settle', workflowOwner: opt('org-owner') as Address }),
    payload,
  ])
  const ctx = reportContextFor('fork-rehearsal')
  const gas = BigInt(opt('gas') ?? 420_000)
  const { hash, rcpt } = rpc.send(TRANSMITTER, PROD, reportCalldata(RESOLVER, raw, ctx, donSign(raw, ctx, forkSignerKeys(4, 'isotherm-fork-don-signer-v1'))), gas)
  print({ path: 'don', forwarder: PROD, transmitter: TRANSMITTER, station: b.station, date: b.date, tmaxC: b.tmaxC, gasLimit: Number(gas), tx: hash, ...outcome(rcpt, PROD) })
} else if (mode === 'mock') {
  print(deliverMock(opt('station') ?? 'RCSS', Number(opt('date')), Number(opt('tmax') ?? 27), BigInt(opt('gas') ?? 200_000)))
} else if (mode === 'warp') {
  warp(Math.floor(Date.parse(opt('at')!) / 1000))
  print({ warpedTo: iso(rpc.blockTime()) })
} else if (mode === 'transfer-owner') {
  const to = opt('to') as Address
  const ownable = [
    { type: 'function', name: 'transferOwnership', stateMutability: 'nonpayable', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
    { type: 'function', name: 'acceptOwnership', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  ] as const
  rpc.impersonate(OWNER)
  rpc.write(OWNER, RESOLVER, ownable as any, 'transferOwnership', [to], 200_000n)
  rpc.impersonate(to)
  rpc.write(to, RESOLVER, ownable as any, 'acceptOwnership', [], 200_000n)
  print({ resolverOwner: `0x${(view(RESOLVER, R, 'owner') as string).slice(26)}` })
} else {
  console.error('usage: bun e2e/don-fork-deliver.ts setup|prepare|target|mock-target|don|mock|warp|transfer-owner --rpc http://127.0.0.1:PORT ...')
  process.exit(2)
}
