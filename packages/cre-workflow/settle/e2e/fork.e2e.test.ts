// Anvil-fork e2e against the LIVE v1 bytecode (Resolver 0x9c78…962B, Vault 0xae36…7B39, MockKeystoneForwarder
// 0xB9F7…d192), through the real forwarder, exactly as `cre workflow simulate --broadcast` delivers reports.
//
//   A. encoding round trip: our v1 report + EIP-712 attestation is ACCEPTED through MockKeystoneForwarder;
//      tampered / expired / wrong-signer / wrong-domain / high-s / replayed reports are REJECTED.
//   B. the real workflow handler (onCron, CRE SDK harness) does a catch-up run over the vault's due ladders:
//      settles 2 ladders, keeps a disagreeing one PENDING, VOIDs it only after the 36 h deadline (before the
//      on-chain 48 h stale window), then the vault pays out from those results.
//
// Safety: the fork shares the live Resolver's EIP-712 domain (same chainId and address), so anything signed here
// with the REAL attester key would also be valid on live testnet until validUntil. This test therefore never touches
// the real key: it impersonates the owner on the fork and points the Resolver's attester at a public anvil test key.
//
// Run with scripts/fork-e2e.sh (starts its own anvil on 19300-19349 and stops only that PID).
import { describe, expect, test as bunTest } from 'bun:test'
import { EvmMock, HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { readFileSync } from 'node:fs'
import { type Address, type Hex, bytesToHex, concat, decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, stringToBytes, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type Config, configSchema } from '../config'
import { dayEndSec, intToYmd } from '../plan'
import { buildSignedReport, REPORT_PARAMS, settlementDigest, signDigest, stationToBytes4 } from '../report'
import { onCron, type RunSummary } from '../workflow'
import { cronPayload, fx, MONAD_TESTNET_SELECTOR, parseSourceUrl, shiftFixture, TEST_ATTESTER_KEY } from '../test/helpers'
import { abi, deployments, FORWARDER_ABI, makeRpc, simulatorHeader } from './chain'

const RPC = process.env.ISOTHERM_FORK_RPC
const RESOLVER = deployments.resolver as Address
const VAULT = deployments.vault as Address
const FORWARDER = deployments.mockForwarder as Address
const OWNER = deployments.roles.owner as Address
const OPERATOR = deployments.roles.operator as Address
const TX_FROM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address // anvil dev account #1 (unlocked, fork only)
const ATTESTER = privateKeyToAccount(TEST_ATTESTER_KEY).address
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex // anvil #1 key, public
const R = abi('Resolver')
const V = abi('CollateralVault')
const ev = (line: string) => console.log(line)
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))

const maybe = RPC ? describe : describe.skip
maybe('fork e2e (live v1 bytecode)', () => {
  const rpc = makeRpc(RPC ?? 'http://127.0.0.1:1')
  const flipTmax = (p: Hex) => (p.slice(0, 2 + 64 * 2 + 62) + '1b' + p.slice(2 + 64 * 3)) as Hex // tmaxC word 26 -> 27
  const view = (to: Address, a: any, functionName: string, args: unknown[] = [], tag = 'latest') =>
    decodeFunctionResult({ abi: a, functionName, data: rpc.call('eth_call', [{ to, data: encodeFunctionData({ abi: a, functionName, args } as any) }, tag]) } as any) as any
  const resultOf = (icao: string, date: number) => view(RESOLVER, R, 'resultOf', [stationToBytes4(icao), date])
  /** Deliver a payload like the CRE simulator: header + payload -> MockKeystoneForwarder.report, gas 200k. */
  const deliver = (payload: Hex, tag: string) => {
    const raw = concat([simulatorHeader(keccak256(stringToBytes(`isotherm-fork-${tag}`))), payload])
    const { hash, rcpt } = rpc.send(TX_FROM, FORWARDER, encodeFunctionData({ abi: FORWARDER_ABI, functionName: 'report', args: [RESOLVER, raw, '0x', []] }), 200_000n)
    const processed = rcpt.logs.filter((l: any) => l.address.toLowerCase() === FORWARDER.toLowerCase()).map((l: any) => decodeEventLog({ abi: FORWARDER_ABI, data: l.data, topics: l.topics }).args.result)
    const resolved = rcpt.logs.filter((l: any) => l.address.toLowerCase() === RESOLVER.toLowerCase()).map((l: any) => decodeEventLog({ abi: R, data: l.data, topics: l.topics }) as any)
    return { hash, status: rcpt.status, gasUsed: Number(BigInt(rcpt.gasUsed)), result: processed[0] as boolean, resolved }
  }
  /** Why would onReport reject this? eth_call it as the forwarder and decode the custom error. */
  const whyRejected = (payload: Hex): string => {
    try {
      rpc.call('eth_call', [{ from: FORWARDER, to: RESOLVER, data: encodeFunctionData({ abi: R, functionName: 'onReport', args: ['0x', payload] }) }, 'latest'])
      return 'accepted'
    } catch (e: any) {
      const data = e.data ?? (String(e.message).match(/0x[0-9a-f]{8,}/i) ?? [])[0]
      try {
        const d = decodeErrorResult({ abi: R, data })
        return `${d.errorName}(${d.args?.map(String).join(',') ?? ''})`
      } catch {
        return String(e.message).slice(0, 120)
      }
    }
  }

  let t0 = 0
  bunTest('fork setup: live v1 contracts present; test attester installed via owner impersonation', () => {
    expect(Number(BigInt(rpc.call('eth_chainId')))).toBe(10143)
    for (const a of [RESOLVER, VAULT, FORWARDER]) expect((rpc.call('eth_getCode', [a, 'latest']) as string).length).toBeGreaterThan(1000)
    expect(view(RESOLVER, R, 'attester')).toBe(deployments.roles.attester)
    expect(view(RESOLVER, R, 'forwarder')).toBe(FORWARDER)
    expect(view(RESOLVER, R, 'owner')).toBe(OWNER)
    t0 = rpc.blockTime()
    ev(`fork block ${BigInt(rpc.call('eth_blockNumber'))} time ${new Date(t0 * 1000).toISOString()} | live attester ${deployments.roles.attester} (real key NOT used)`)
    rpc.impersonate(OWNER)
    rpc.write(OWNER, RESOLVER, R, 'setAttester', [ATTESTER], 200_000n)
    rpc.call('anvil_setBalance', [TX_FROM, toHex(10n ** 20n)])
    expect(view(RESOLVER, R, 'attester')).toBe(ATTESTER)
    ev(`fork: Resolver.attester -> public test key ${ATTESTER}`)
  })

  bunTest('A. v1 report accepted through MockKeystoneForwarder; tampered reports rejected', () => {
    const now = rpc.blockTime()
    const vu = BigInt(now + 1500)
    const base = { station: 'RCSS', date: 20261006, tmaxC: 25, isVoid: false, sourcesHash: keccak256(stringToBytes('isotherm-sources-v1|RCSS|20261006|SETTLED|fork-test')), validUntil: vu }
    // our digest == the contract's settlementDigest
    const onchainDigest = view(RESOLVER, R, 'settlementDigest', [stationToBytes4('RCSS'), 20261006, 25, false, base.sourcesHash, vu])
    expect(settlementDigest(10143n, RESOLVER, base)).toBe(onchainDigest)

    const good = buildSignedReport(TEST_ATTESTER_KEY, 10143n, RESOLVER, base)
    const rjtt = { ...base, station: 'RJTT', tmaxC: 26 }
    const rjttGood = buildSignedReport(TEST_ATTESTER_KEY, 10143n, RESOLVER, rjtt)
    // tampered variants (all for RJTT 2026-10-06, which has no result yet)
    const sigS = BigInt(`0x${rjttGood.signature.slice(66, 130)}`)
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const v = Number.parseInt(rjttGood.signature.slice(130, 132), 16)
    const highS = `${rjttGood.signature.slice(0, 66)}${toHex(N - sigS, { size: 32 }).slice(2)}${(v === 27 ? 28 : 27).toString(16)}` as Hex
    // raw signer + encoder without our encoder's own sanity checks (to prove the CONTRACT refuses these too)
    const rawSigned = (b: typeof rjtt, key = TEST_ATTESTER_KEY, chainId = 10143n, verifying: Address = RESOLVER): Hex =>
      encodeAbiParameters(REPORT_PARAMS, [stationToBytes4(b.station), b.date, b.tmaxC, b.isVoid, b.sourcesHash, b.validUntil, signDigest(key, settlementDigest(chainId, verifying, b))])
    const dayAfterTomorrow = Number(new Date((now + 2 * 86400 + 9 * 3600) * 1000).toISOString().slice(0, 10).replace(/-/g, ''))
    const cases: [string, Hex][] = [
      ['tmaxC byte flipped after signing', flipTmax(rjttGood.payload)],
      ['signed by a non-attester key', rawSigned(rjtt, OTHER_KEY)],
      ['expired (validUntil = now - 1)', rawSigned({ ...rjtt, validUntil: BigInt(now - 1) })],
      ['signed for chainId 143 (mainnet domain)', rawSigned(rjtt, TEST_ATTESTER_KEY, 143n)],
      ['signed for the v0 Resolver address', rawSigned(rjtt, TEST_ATTESTER_KEY, 10143n, '0x1c7a8a5df93f7f33c778c2163d8887e9249475f1')],
      ['malleated high-s signature', encodeAbiParameters(REPORT_PARAMS, [stationToBytes4('RJTT'), rjtt.date, rjtt.tmaxC, false, rjtt.sourcesHash, rjtt.validUntil, highS])],
      [`day not over (RJTT ${dayAfterTomorrow})`, rawSigned({ ...rjtt, date: dayAfterTomorrow })],
      ['tmaxC out of range (71)', rawSigned({ ...rjtt, tmaxC: 71 })],
      ['VOID flag flipped after signing', (rjttGood.payload.slice(0, 2 + 64 * 3) + '0'.repeat(63) + '1' + rjttGood.payload.slice(2 + 64 * 4)) as Hex],
    ]
    for (const [name, payload] of cases) {
      const why = whyRejected(payload)
      const d = deliver(payload, name)
      ev(`REJECTED  ${name.padEnd(40)} tx ${d.status === '0x1' ? 'success' : 'reverted'} gas ${d.gasUsed} ReportProcessed.result=${d.result} onReport would revert: ${why}`)
      expect(d.status).toBe('0x1') // the mock forwarder never reverts...
      expect(d.result).toBe(false) // ...it reports result=false
      expect(why).not.toBe('accepted')
      expect(Number(resultOf('RJTT', 20261006).status)).toBe(0)
    }

    const a = deliver(good.payload, 'rcss-good')
    ev(`ACCEPTED  RCSS 20261006 tmax 25  tx ${a.hash} gasUsed ${a.gasUsed} ReportProcessed.result=${a.result} LadderResolved=${json(a.resolved.map((e: any) => e.args))}`)
    expect([a.status, a.result]).toEqual(['0x1', true])
    expect(a.resolved[0].eventName).toBe('LadderResolved')
    expect(a.resolved[0].args).toMatchObject({ station: '0x52435353', date: 20261006, status: 1, tmaxC: 25, sourcesHash: base.sourcesHash, caller: FORWARDER })
    const r = resultOf('RCSS', 20261006)
    expect(Number(r.status)).toBe(1)
    expect(Number(r.tmaxC)).toBe(25)
    expect(r.finalAt - r.resolvedAt).toBe(900n)
    expect(a.gasUsed).toBeLessThan(170_000)

    const replay = deliver(good.payload, 'rcss-replay')
    ev(`REJECTED  replay of the accepted RCSS report               ReportProcessed.result=${replay.result} onReport would revert: ${whyRejected(good.payload)}`)
    expect(replay.result).toBe(false)

    const b = deliver(rjttGood.payload, 'rjtt-good')
    ev(`ACCEPTED  RJTT 20261006 tmax 26  tx ${b.hash} gasUsed ${b.gasUsed} ReportProcessed.result=${b.result}`)
    expect(b.result).toBe(true)
    expect(Number(resultOf('RJTT', 20261006).tmaxC)).toBe(26)

    // direct call from an EOA (not the forwarder) reverts outright
    let direct = ''
    try {
      rpc.call('eth_estimateGas', [{ from: TX_FROM, to: RESOLVER, data: encodeFunctionData({ abi: R, functionName: 'onReport', args: ['0x', good.payload] }) }])
    } catch (e: any) {
      direct = decodeErrorResult({ abi: R, data: e.data }).errorName
    }
    ev(`REVERTS   direct onReport from an EOA: ${direct}`)
    expect(direct).toBe('InvalidSender')
  })

  // ------------------------------------------------------------------------------------------------ B
  // Wire the CRE SDK harness to the fork: HTTP from captured fixtures (relabelled to the fork's future dates),
  // EVM reads = eth_call at the requested tag, writeReport = the simulator's forwarder call.
  const wire = (awcDisagree: Set<string>) => {
    const urls: string[] = []
    HttpActionsMock.testInstance().sendRequest = (req) => {
      urls.push(req.url)
      const { kind, icao, ymd } = parseSourceUrl(req.url)
      const ext = { iem: 'csv', awc: 'json', ogimet: 'txt' }[kind]
      let body = shiftFixture(kind, fx(`${kind}_${icao}_2026-10-05.${ext}`), '2026-10-05', ymd)
      if (kind === 'awc' && awcDisagree.has(`${icao}:${ymd}`)) {
        body = JSON.stringify((JSON.parse(body) as { rawOb: string }[]).map((r) => ({ ...r, rawOb: r.rawOb.replace(/ (\d{2})\/(\d{2}) /, (_, t, d) => ` ${Number(t) + 2}/${d} `) })))
      }
      return { statusCode: 200, body: new TextEncoder().encode(body), headers: {} }
    }
    const evm = EvmMock.testInstance(MONAD_TESTNET_SELECTOR)
    const reads: string[] = []
    evm.callContract = (req) => {
      const abs = req.blockNumber?.absVal as Uint8Array | undefined
      const tag = abs && abs.length === 1 && abs[0] === 3 ? 'finalized' : 'latest'
      reads.push(tag)
      const out = rpc.call('eth_call', [{ to: bytesToHex(req.call!.to as Uint8Array), data: bytesToHex(req.call!.data as Uint8Array) }, tag]) as Hex
      return { data: Buffer.from(out.slice(2), 'hex').toString('base64') }
    }
    const sent: ReturnType<typeof deliver>[] = []
    evm.writeReport = (input) => {
      const payload = `0x${bytesToHex(input.report!.rawReport as Uint8Array).slice(2 + 109 * 2)}` as Hex
      expect(input.gasConfig!.gasLimit).toBe(200000n)
      const d = deliver(payload, `wf-${sent.length}-${Date.now()}`)
      sent.push(d)
      return { txStatus: d.status === '0x1' ? 2 : 1, txHash: Buffer.from(d.hash.slice(2), 'hex') }
    }
    return { urls, reads, sent }
  }
  const runWorkflow = (cfg: Config, triggerSec: number) => {
    const ns = new Map([['ISOTHERM_ATTESTER_KEY', TEST_ATTESTER_KEY]])
    const rt = newTestRuntime(new Map([['main', ns], ['default', ns]]), { timeProvider: () => triggerSec * 1000 }, cfg)
    const out: RunSummary = JSON.parse(onCron(rt, cronPayload(triggerSec)))
    for (const l of rt.getLogs()) ev(`  [USER LOG] ${l.length > 300 ? `${l.slice(0, 300)}…` : l}`)
    return out
  }

  test('B. catch-up over the vault: settle 2, keep a disagreeing one PENDING, VOID it after 36 h, vault pays out', () => {
    const cfg = configSchema.parse(JSON.parse(readFileSync(new URL('../config.anvil.json', import.meta.url), 'utf8')))
    const now = rpc.blockTime()
    // D1 = tomorrow (Taipei), D2 = the day after: the only dates a ladder can still be created for on this fork.
    const ymdAt = (t: number, offMin: number) => new Date((t + offMin * 60) * 1000).toISOString().slice(0, 10)
    const D1 = Number(ymdAt(now + 86400, 480).replace(/-/g, ''))
    const D2 = Number(ymdAt(now + 2 * 86400, 480).replace(/-/g, ''))
    const before = Number(view(VAULT, V, 'ladderCount'))
    rpc.impersonate(OPERATOR)
    let created = 0
    // Live state moves under us (the maker opens real ladders): reuse a ladder that already exists on the fork.
    const ensure = (icao: string, date: number, off: number, strikes: number[], closeLocalMin: number) => {
      const existing = view(VAULT, V, 'ladderSeries', [stationToBytes4(icao), date]) as Hex[]
      if (existing.length) {
        const ks = existing.map((id) => Number(view(VAULT, V, 'getSeries', [id]).strikeC))
        ev(`ladder ${icao} ${date} already exists on the live chain (strikes ${ks}); reusing it on the fork`)
        return
      }
      const close = dayEndSec(date, off) - 86400 + closeLocalMin * 60
      const r = rpc.write(OPERATOR, VAULT, V, 'createLadder', [stationToBytes4(icao), date, strikes, BigInt(close)], 2_000_000n)
      created++
      ev(`createLadder ${icao} ${date} strikes ${strikes} close ${new Date(close * 1000).toISOString()} gasUsed ${Number(BigInt(r.rcpt.gasUsed))}`)
    }
    ensure('RCSS', D1, 480, [28, 29, 30], 17 * 60 + 30)
    ensure('RJTT', D1, 540, [21, 22, 23], 19 * 60 + 30)
    ensure('RCSS', D2, 480, [29], 17 * 60 + 30)
    expect(Number(view(VAULT, V, 'ladderCount'))).toBe(before + created)
    const rcssD2 = `RCSS:${intToYmd(D2)}`

    // 02:00 Taipei on D2+1: D1 (both cities) and D2 RCSS are due; D2's AWC is tampered (+2 C) -> sources disagree.
    const t1 = dayEndSec(D2, 480) + 7200
    rpc.warpTo(t1)
    let io = wire(new Set([rcssD2]))
    let out = runWorkflow(cfg, t1 + 80)
    ev(`run 1 @ ${new Date((t1 + 80) * 1000).toISOString()}: ${json(out.outcomes.map((o) => [o.station, o.date, o.action, o.tmaxC, o.confirmed]))} ladders=${json(out.ladders)} budget=${json(out.budget)}`)
    const mine = (o: RunSummary) => o.outcomes.filter((x) => [D1, D2].includes(x.date))
    expect(mine(out).map((o) => `${o.station}:${o.date}:${o.action}`)).toEqual([`RJTT:${D1}:settled`, `RCSS:${D1}:settled`, `RCSS:${D2}:pending`])
    expect(mine(out).filter((o) => o.action === 'settled').every((o) => o.confirmed === 'resolved')).toBe(true)
    expect(Number(resultOf('RCSS', D1).tmaxC)).toBe(29) // relabelled 10-05 data: RCSS 29, RJTT 22
    expect(Number(resultOf('RJTT', D1).tmaxC)).toBe(22)
    expect(Number(resultOf('RCSS', D2).status)).toBe(0)
    expect(io.reads.filter((t) => t === 'finalized').length).toBeGreaterThanOrEqual(3)
    for (const s of io.sent) ev(`  forwarder tx ${s.hash} gasUsed ${s.gasUsed} ReportProcessed.result=${s.result}`)

    // an hour later: only the disagreeing ladder is still due; still PENDING, no tx
    rpc.warpTo(t1 + 3600, 70)
    io = wire(new Set([rcssD2]))
    out = runWorkflow(cfg, t1 + 3600 + 70)
    expect(mine(out).map((o) => o.action)).toEqual(['pending'])
    expect(io.sent).toHaveLength(0)
    ev(`run 2 (+1 h): ${json(mine(out).map((o) => [o.station, o.date, o.action, o.reason]))}, txs=0`)

    // past our 36 h deadline but before the on-chain stale window: the workflow VOIDs it
    const t3 = dayEndSec(D2, 480) + 129600 + 1800
    rpc.warpTo(t3)
    const staleAt = Number(view(RESOLVER, R, 'staleAt', [stationToBytes4('RCSS'), D2]))
    io = wire(new Set([rcssD2]))
    out = runWorkflow(cfg, t3 + 80)
    expect(mine(out).map((o) => `${o.action}:${o.confirmed}`)).toEqual(['voided:resolved'])
    const rv = resultOf('RCSS', D2)
    expect(Number(rv.status)).toBe(2)
    expect(Number(rv.resolvedAt)).toBeLessThan(staleAt)
    ev(`run 3 (dayEnd + 36.5 h): RCSS ${D2} VOID at ${Number(rv.resolvedAt)} < staleAt ${staleAt} (anyone could void from there)`)

    // vault payouts once final (challenge window 900 s), for every series of the three ladders
    rpc.warpTo(t3 + 1000, 2)
    const payouts = (icao: string, date: number, tmax: number | null) =>
      (view(VAULT, V, 'ladderSeries', [stationToBytes4(icao), date]) as Hex[]).map((id) => {
        const k = Number(view(VAULT, V, 'getSeries', [id]).strikeC)
        const got = view(VAULT, V, 'payoutHalves', [id]).map(Number)
        const want = tmax === null ? [1, 1] : tmax >= k ? [2, 0] : [0, 2]
        expect(got).toEqual(want)
        return `k${k}:${got.join('/')}`
      })
    ev(`vault payoutHalves (YES/NO halves): RCSS ${D1} [${payouts('RCSS', D1, 29)}] | RJTT ${D1} [${payouts('RJTT', D1, 22)}] | RCSS ${D2} void [${payouts('RCSS', D2, null)}]`)
  })
})
