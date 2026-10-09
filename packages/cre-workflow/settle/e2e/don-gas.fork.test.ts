// Gas for a DON-signed Isotherm report delivered through the PRODUCTION KeystoneForwarder (0xF834…4482) into the
// live v1 Resolver (0x9c78…962B), measured on an anvil fork of Monad testnet. This sizes `gasLimit` for the
// `testnet-don` target (settle/config.don.json). Nothing is sent to live testnet.
//
// Setup on the fork only:
//   - the forwarder owner is impersonated and registers donId 1 / configVersion 1 with f = 3 and 10 throwaway signers,
//     the shape of the live DON reports on Monad testnet (4 signatures, 96-byte report context, reportId 0x0000);
//   - the Resolver owner is impersonated: setForwarder(production), setAttester(public test key),
//     setExpectedWorkflow(test id, test org owner), so both metadata checks run (the most expensive onReport path).
// Each trial is replayed from one EVM snapshot with identical calldata, so only the transaction gas limit changes.
//
// Run with scripts/don-gas-fork.sh (its own anvil on 19341; evidence in evidence/don-gas-fork.{txt,json}).
import { describe, expect, test as bunTest } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { type Address, type Hex, concat, decodeErrorResult, decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, keccak256, stringToBytes, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildSignedReport, stationToBytes4 } from '../report'
import { TEST_ATTESTER_KEY } from '../test/helpers'
import { FORWARDER_ABI, abi, deployments, makeRpc, simulatorHeader } from './chain'
import { KEYSTONE_ABI, TX_STATE, addressOf, donSign, forkSignerKeys, productionHeader, recommendGasLimit, reportCalldata, reportContextFor } from './don-sim'

const RPC = process.env.ISOTHERM_FORK_RPC
const LIVE = process.env.ISOTHERM_LIVE_COMPARE_RPC // optional: read-only eth_estimateGas on live testnet for comparison
const OUT = process.env.ISOTHERM_DON_GAS_OUT
const RESOLVER = deployments.resolver as Address
const PROD = deployments.keystoneForwarder as Address
const MOCK = deployments.mockForwarder as Address
const OWNER = deployments.roles.owner as Address
const TRANSMITTER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address // anvil dev account #2 (unlocked, fork only)
const TEST_ATTESTER = privateKeyToAccount(TEST_ATTESTER_KEY).address
const TEST_WORKFLOW_ID = keccak256(stringToBytes('isotherm-settle fork test workflow id'))
const TEST_ORG_OWNER = `0x${keccak256(stringToBytes('isotherm fork test org owner')).slice(26)}` as Address
const R = abi('Resolver')
const ev = (line: string) => console.log(line)

const maybe = RPC ? describe : describe.skip
maybe('DON gas: production KeystoneForwarder -> v1 Resolver (anvil fork)', () => {
  const rpc = makeRpc(RPC ?? 'http://127.0.0.1:1')
  const view = (to: Address, a: any, functionName: string, args: unknown[] = []) =>
    decodeFunctionResult({ abi: a, functionName, data: rpc.call('eth_call', [{ to, data: encodeFunctionData({ abi: a, functionName, args } as any) }, 'latest']) } as any) as any
  const result: Record<string, unknown> = { measuredAt: new Date().toISOString(), forwarder: PROD, resolver: RESOLVER }

  // one DON-signed report, reused for every trial
  let target = { station: 'RCSS', date: 0 }
  const make = (nSig: number, configVersion: number, opts: { isVoid?: boolean } = {}) => {
    const now = rpc.blockTime()
    const body = {
      station: target.station,
      date: target.date,
      tmaxC: opts.isVoid ? 0 : 27,
      isVoid: !!opts.isVoid,
      sourcesHash: keccak256(stringToBytes(`isotherm-sources-v1|${target.station}|${target.date}|fork-gas-test`)),
      validUntil: BigInt(now + 1500),
    }
    const { payload } = buildSignedReport(TEST_ATTESTER_KEY, 10143n, RESOLVER, body)
    const raw = concat([
      productionHeader({ executionId: keccak256(stringToBytes(`isotherm-don-gas-${nSig}-${configVersion}-${opts.isVoid}`)), timestamp: now, donId: 1, configVersion, workflowId: TEST_WORKFLOW_ID, workflowName: 'isotherm-settle', workflowOwner: TEST_ORG_OWNER }),
      payload,
    ])
    const ctx = reportContextFor(`isotherm-don-gas-${configVersion}`)
    const sigs = donSign(raw, ctx, forkSignerKeys(nSig, `isotherm-fork-don-signer-v${configVersion}`))
    return { raw, ctx, sigs, data: reportCalldata(RESOLVER, raw, ctx, sigs), calldataBytes: 0 }
  }

  type Trial = { gasLimit: number; outcome: 'settled' | 'result=false' | 'reverted'; gasUsed: number; state?: string; why?: string }
  const trial = (data: Hex, gasLimit: number): Trial => {
    const snap = rpc.call('evm_snapshot')
    try {
      const { rcpt } = rpc.send(TRANSMITTER, PROD, data, BigInt(gasLimit))
      const gasUsed = Number(BigInt(rcpt.gasUsed))
      if (rcpt.status !== '0x1') {
        let why = 'reverted'
        try {
          rpc.call('eth_call', [{ from: TRANSMITTER, to: PROD, data, gas: toHex(gasLimit) }, 'latest'])
        } catch (e: any) {
          try {
            why = decodeErrorResult({ abi: KEYSTONE_ABI, data: e.data }).errorName
          } catch {
            why = String(e.message).slice(0, 80)
          }
        }
        return { gasLimit, outcome: 'reverted', gasUsed, why }
      }
      const processed = rcpt.logs.filter((l: any) => l.address.toLowerCase() === PROD.toLowerCase()).map((l: any) => decodeEventLog({ abi: KEYSTONE_ABI, data: l.data, topics: l.topics }).args as any)
      const resolved = rcpt.logs.filter((l: any) => l.address.toLowerCase() === RESOLVER.toLowerCase()).map((l: any) => decodeEventLog({ abi: R, data: l.data, topics: l.topics }) as any)
      const ok = processed[0]?.result === true && resolved.some((e: any) => e.eventName === 'LadderResolved')
      const info = view(PROD, KEYSTONE_ABI, 'getTransmissionInfo', [RESOLVER, processed[0].workflowExecutionId, processed[0].reportId])
      return { gasLimit, outcome: ok ? 'settled' : 'result=false', gasUsed, state: TX_STATE[Number(info.state)] }
    } finally {
      rpc.call('evm_revert', [snap])
    }
  }
  /** Lowest gas limit (1-gas precision) at which the report settles, between a failing and a passing limit. */
  const minimum = (data: Hex, lo: number, hi: number) => {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (trial(data, mid).outcome === 'settled') hi = mid
      else lo = mid
    }
    return hi
  }

  bunTest('fork setup: production forwarder with a test DON config; Resolver pointed at it (owner impersonated)', () => {
    expect(Number(BigInt(rpc.call('eth_chainId')))).toBe(10143)
    expect(view(PROD, KEYSTONE_ABI, 'typeAndVersion')).toBe('KeystoneForwarder 1.0.0')
    expect(view(RESOLVER, R, 'supportsInterface', ['0x805f2132'])).toBe(true) // IReceiver
    const fOwner = view(PROD, KEYSTONE_ABI, 'owner') as Address
    rpc.impersonate(fOwner)
    rpc.write(fOwner, PROD, KEYSTONE_ABI as any, 'setConfig', [1, 1, 3, forkSignerKeys(10, 'isotherm-fork-don-signer-v1').map(addressOf)], 3_000_000n)
    rpc.write(fOwner, PROD, KEYSTONE_ABI as any, 'setConfig', [1, 2, 5, forkSignerKeys(16, 'isotherm-fork-don-signer-v2').map(addressOf)], 5_000_000n)
    rpc.impersonate(OWNER)
    rpc.write(OWNER, RESOLVER, R, 'setForwarder', [PROD], 200_000n)
    rpc.write(OWNER, RESOLVER, R, 'setAttester', [TEST_ATTESTER], 200_000n)
    rpc.write(OWNER, RESOLVER, R, 'setExpectedWorkflow', [TEST_WORKFLOW_ID, TEST_ORG_OWNER], 200_000n)
    rpc.call('anvil_setBalance', [TRANSMITTER, toHex(10n ** 20n)])
    // a station-date that is over and has no result on the live chain
    const now = rpc.blockTime()
    for (let back = 1; back <= 10 && !target.date; back++) {
      const d = Number(new Date((now + 8 * 3600 - back * 86400) * 1000).toISOString().slice(0, 10).replace(/-/g, ''))
      if (Number(view(RESOLVER, R, 'resultOf', [stationToBytes4('RCSS'), d]).status) === 0) target = { station: 'RCSS', date: d }
    }
    expect(target.date).toBeGreaterThan(0)
    Object.assign(result, { forkBlock: Number(BigInt(rpc.call('eth_blockNumber'))), forkTime: new Date(now * 1000).toISOString(), target, testDon: { donId: 1, configVersion: 1, f: 3, signers: 10 } })
    ev(`fork block ${result.forkBlock} at ${result.forkTime}; forwarder owner ${fOwner} impersonated; test DON v1 f=3 (4 sigs), v2 f=5 (6 sigs)`)
    ev(`Resolver: forwarder -> ${view(RESOLVER, R, 'forwarder')}, attester -> public test key, expected workflow (id, owner) pinned; target ${target.station} ${target.date}`)
  })

  bunTest('4 DON signatures (the live DON shape): sweep, exact minimum, recommended limit', () => {
    const settled = make(4, 1)
    const voided = make(4, 1, { isVoid: true })
    ev(`rawReport ${(settled.raw.length - 2) / 2} bytes (109 header + ${(settled.raw.length - 2) / 2 - 109} payload), calldata ${(settled.data.length - 2) / 2} bytes`)
    const sweep = [200_000, 225_000, 250_000, 275_000, 300_000, 320_000, 350_000, 400_000, 500_000].map((g) => trial(settled.data, g))
    for (const t of sweep) ev(`  gas limit ${String(t.gasLimit).padStart(7)} -> ${t.outcome.padEnd(13)} gasUsed ${t.gasUsed}${t.state ? ` transmission ${t.state}` : ''}${t.why ? ` (${t.why})` : ''}`)
    const lo = Math.max(...sweep.filter((t) => t.outcome !== 'settled').map((t) => t.gasLimit), 150_000)
    const hi = Math.min(...sweep.filter((t) => t.outcome === 'settled').map((t) => t.gasLimit))
    expect(hi).toBeLessThan(Number.POSITIVE_INFINITY)
    const minSettled = minimum(settled.data, lo, hi)
    const minVoid = minimum(voided.data, 150_000, 500_000)
    const below = trial(settled.data, minSettled - 1)
    const at = trial(settled.data, minSettled)
    const generous = trial(settled.data, 1_000_000)
    ev(`  minimum (Settled report): ${minSettled}; at ${minSettled - 1}: ${below.outcome}${below.state ? ` (${below.state})` : ''}${below.why ? ` (${below.why})` : ''}`)
    ev(`  minimum (Void report):    ${minVoid}`)
    ev(`  gas actually used with a 1,000,000 limit: ${generous.gasUsed} (anvil reports gas used; Monad bills the limit)`)
    expect(at.outcome).toBe('settled')
    expect(below.outcome).not.toBe('settled')
    const basis = Math.max(minSettled, minVoid)
    const rec = recommendGasLimit(basis)
    ev(`  recommended gasLimit for testnet-don: max(350,000, ceil10k(${basis} x 1.5)) = ${rec}`)
    Object.assign(result, {
      fourSignatures: { sweep, minimumSettled: minSettled, minimumVoid: minVoid, belowMinimum: below, gasUsedAt1M: generous.gasUsed, calldataBytes: (settled.data.length - 2) / 2 },
      recommendedGasLimit: rec,
      rule: 'max(350000, ceil10k(minimum x 1.5))',
    })
  })

  bunTest('headroom: 6 DON signatures (f = 5) still settle at the recommended limit', () => {
    const six = make(6, 2)
    const min6 = minimum(six.data, 150_000, 600_000)
    const rec = result.recommendedGasLimit as number
    const atRec = trial(six.data, rec)
    ev(`  minimum with 6 signatures: ${min6}; at the recommended ${rec}: ${atRec.outcome}`)
    expect(atRec.outcome).toBe('settled')
    Object.assign(result, { sixSignatures: { minimumSettled: min6, atRecommended: atRec.outcome } })
  })

  bunTest('config.don.json carries the measured limit; the Mac target keeps 200k (too low for the DON path)', () => {
    const don = JSON.parse(readFileSync(new URL('../config.don.json', import.meta.url), 'utf8'))
    const rec = result.recommendedGasLimit as number
    expect(Number(don.gasLimit)).toBeGreaterThanOrEqual(rec)
    const settled = make(4, 1)
    const atDon = trial(settled.data, Number(don.gasLimit))
    const at200 = trial(settled.data, 200_000)
    ev(`  config.don.json gasLimit ${don.gasLimit}: ${atDon.outcome}; config.testnet.json 200000 through the production forwarder: ${at200.outcome}${at200.state ? ` (${at200.state})` : ''}${at200.why ? ` (${at200.why})` : ''}`)
    expect(atDon.outcome).toBe('settled')
    Object.assign(result, { configDonGasLimit: Number(don.gasLimit), atConfigDon: atDon.outcome, at200kThroughProduction: at200 })
  })

  bunTest('rejections still hold on the production path (a wrong signer set or a wrong workflow owner never settles)', () => {
    const good = make(4, 1)
    // signatures from keys the forwarder does not know: the forwarder itself reverts
    const strangers = donSign(good.raw, good.ctx, forkSignerKeys(4, 'not-in-the-config'))
    const bad = trial(reportCalldata(RESOLVER, good.raw, good.ctx, strangers), 500_000)
    ev(`  unknown DON signers -> ${bad.outcome} (${bad.why})`)
    expect(bad.outcome).toBe('reverted')
    // a report from another workflow owner: forwarder accepts, Resolver rejects (InvalidWorkflowOwner), result=false
    const now = rpc.blockTime()
    const payload = `0x${good.raw.slice(2 + 109 * 2)}` as Hex
    const otherRaw = concat([productionHeader({ executionId: keccak256(stringToBytes('other-owner')), timestamp: now, donId: 1, configVersion: 1, workflowId: TEST_WORKFLOW_ID, workflowName: 'isotherm-settle', workflowOwner: `0x${'aa'.repeat(20)}` }), payload])
    const other = trial(reportCalldata(RESOLVER, otherRaw, good.ctx, donSign(otherRaw, good.ctx, forkSignerKeys(4, 'isotherm-fork-don-signer-v1'))), 500_000)
    ev(`  workflow owner 0xaa…aa (the simulator's fixed owner) -> ${other.outcome}`)
    expect(other.outcome).toBe('result=false')
    // the MockKeystoneForwarder can no longer deliver while the Resolver points at the production forwarder
    const mockRaw = concat([simulatorHeader(keccak256(stringToBytes('mock-after-switch'))), payload])
    const snap = rpc.call('evm_snapshot')
    const { rcpt } = rpc.send(TRANSMITTER, MOCK, encodeFunctionData({ abi: FORWARDER_ABI, functionName: 'report', args: [RESOLVER, mockRaw, '0x', []] }), 500_000n)
    const mockResult = rcpt.logs.filter((l: any) => l.address.toLowerCase() === MOCK.toLowerCase()).map((l: any) => decodeEventLog({ abi: FORWARDER_ABI, data: l.data, topics: l.topics }).args.result)[0]
    rpc.call('evm_revert', [snap])
    ev(`  MockKeystoneForwarder delivery after the switch -> ReportProcessed.result=${mockResult} (InvalidSender inside the Resolver)`)
    expect(mockResult).toBe(false)
  })

  bunTest('fork gas tracks live Monad: eth_estimateGas of the same read-only calls (no transaction)', () => {
    if (!LIVE) {
      ev('  skipped: ISOTHERM_LIVE_COMPARE_RPC not set')
      return
    }
    const live = makeRpc(LIVE)
    // A mock delivery whose attestation is signed by a non-attester key: onReport reverts inside (InvalidAttestation),
    // the mock swallows it, so eth_estimateGas succeeds on both. Same Resolver code path up to the signature check.
    const now = rpc.blockTime()
    const body = { station: 'RJTT', date: target.date, tmaxC: 26, isVoid: false, sourcesHash: keccak256(stringToBytes('gas-compare')), validUntil: BigInt(now + 3600) }
    const { payload } = buildSignedReport('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 10143n, RESOLVER, body)
    const calls: [string, Address, Hex][] = [
      ['MockKeystoneForwarder.report (rejected attestation)', MOCK, encodeFunctionData({ abi: FORWARDER_ABI, functionName: 'report', args: [RESOLVER, concat([simulatorHeader(keccak256(stringToBytes('cmp'))), payload]), '0x', []] })],
      ['Resolver.resultOf (cold storage read)', RESOLVER, encodeFunctionData({ abi: R, functionName: 'resultOf', args: [stationToBytes4('RCSS'), 20261008] })],
      ['Resolver.settlementDigest (EIP-712 hashing)', RESOLVER, encodeFunctionData({ abi: R, functionName: 'settlementDigest', args: [stationToBytes4('RJTT'), 20261006, 26, false, body.sourcesHash, body.validUntil] })],
    ]
    // a fresh fork state for the comparison: undo the setup's Resolver changes in a snapshot
    const snap = rpc.call('evm_snapshot')
    rpc.write(OWNER, RESOLVER, R, 'setExpectedWorkflow', ['0x'.padEnd(66, '0'), '0x0000000000000000000000000000000000000000'], 200_000n)
    rpc.write(OWNER, RESOLVER, R, 'setForwarder', [MOCK], 200_000n)
    rpc.write(OWNER, RESOLVER, R, 'setAttester', [deployments.roles.attester], 200_000n)
    const rows = calls.map(([name, to, data]) => {
      const f = Number(BigInt(rpc.call('eth_estimateGas', [{ from: TRANSMITTER, to, data }])))
      const l = Number(BigInt(live.call('eth_estimateGas', [{ from: TRANSMITTER, to, data }])))
      ev(`  ${name.padEnd(52)} live ${l}  fork ${f}  live - fork ${l - f} (${(((l - f) / f) * 100).toFixed(2)} %)`)
      return { name, live: l, fork: f, delta: l - f }
    })
    rpc.call('evm_revert', [snap])
    for (const r of rows) expect(Math.abs(r.delta) / r.fork).toBeLessThan(0.02)
    result.liveVsFork = rows
  })

  bunTest('reference: the latest live DON transmissions through the same forwarder (read-only)', () => {
    if (!LIVE) {
      ev('  skipped: ISOTHERM_LIVE_COMPARE_RPC not set')
      return
    }
    // Monad bills the gas limit and its receipts report gasUsed = gas limit, so live receipts cannot show what a
    // report consumed; the fork above is where consumption is measured. This records what live DON reports send.
    const live = makeRpc(LIVE)
    const topic = '0x3617b009e9785c42daebadb6d3fb553243a4bf586d07ea72d65d80013ce116b5' // ReportProcessed(address,bytes32,bytes2,bool)
    const head = Number(BigInt(live.call('eth_blockNumber')))
    const found: { block: number; tx: Hex }[] = []
    for (let to = head; to > head - 4000 && found.length < 3; to -= 100) {
      const logs = live.call('eth_getLogs', [{ address: PROD, topics: [topic], fromBlock: toHex(to - 99), toBlock: toHex(to) }]) as any[]
      for (const l of logs.reverse()) if (found.length < 3 && !found.some((f) => f.tx === l.transactionHash)) found.push({ block: Number(BigInt(l.blockNumber)), tx: l.transactionHash })
    }
    const rows = found.map(({ block, tx }) => {
      const t = live.call('eth_getTransactionByHash', [tx])
      const r = live.call('eth_getTransactionReceipt', [tx])
      const { args } = decodeFunctionData({ abi: KEYSTONE_ABI, data: t.input })
      const row = { block, tx, gasLimit: Number(BigInt(t.gas)), receiptGasUsed: Number(BigInt(r.gasUsed)), signatures: (args[3] as Hex[]).length, rawReportBytes: ((args[1] as Hex).length - 2) / 2 }
      ev(`  live DON tx ${tx.slice(0, 12)}… block ${block}: gas limit ${row.gasLimit}, receipt gasUsed ${row.receiptGasUsed}, ${row.signatures} signatures, rawReport ${row.rawReportBytes} bytes`)
      return row
    })
    if (!rows.length) ev('  no live DON transmission in the last 4,000 blocks')
    result.liveDonReference = rows
  })

  bunTest('write evidence', () => {
    if (OUT) writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
    ev(`[don-gas] ${JSON.stringify({ recommendedGasLimit: result.recommendedGasLimit, minimumSettled: (result.fourSignatures as any)?.minimumSettled, minimumVoid: (result.fourSignatures as any)?.minimumVoid, sixSignatures: (result.sixSignatures as any)?.minimumSettled })}`)
  })
})
