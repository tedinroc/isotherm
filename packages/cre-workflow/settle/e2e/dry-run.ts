// Live dry run (no login, no MON, no signature by the real attester): runs the real onCron handler in the CRE SDK
// harness against LIVE Monad testnet reads (eth_call) and LIVE METAR sources, and stops at writeReport: it reports
// what the workflow would deliver, and eth_call-simulates Resolver.onReport as the forwarder to show whether the
// contract would accept everything except the signature (which is a throwaway key here).
//   [DRY_CONFIG=./config.testnet.json] [DRY_EXTRA=RCSS:2026-10-06,RJTT:2026-10-06] [DRY_AT=<unix s>] \
//     bun test --timeout 120000 ./e2e/dry-run.ts        (scripts/dry-run.sh wraps this)
import { EvmMock, HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { readFileSync } from 'node:fs'
import { type Address, type Hex, bytesToHex, decodeErrorResult, encodeFunctionData } from 'viem'
import { configSchema } from '../config'
import { decodeReport } from '../report'
import { onCron } from '../workflow'
import { cronPayload, MONAD_TESTNET_SELECTOR } from '../test/helpers'
import { abi, deployments, makeRpc } from './chain'

const env = (k: string) => process.env[k] || undefined
const RPC = process.env.ISOTHERM_RPC ?? 'https://testnet-rpc.monad.xyz'
const cfgPath = env('DRY_CONFIG') ?? './config.testnet.json'
const cfg = configSchema.parse({
  ...JSON.parse(readFileSync(new URL(`../${cfgPath.replace(/^\.\//, '')}`, import.meta.url), 'utf8')),
  ...(env('DRY_EXTRA') ? { extraTargets: env('DRY_EXTRA')!.split(',').map((s) => ({ icao: s.split(':')[0], date: s.split(':')[1] })) } : {}),
})
const rpc = makeRpc(RPC)
const R = abi('Resolver')
const DRY_KEY = `0x${'42'.repeat(32)}` as Hex // throwaway: the live Resolver rejects its signature by design
const at = Number(env('DRY_AT') ?? Math.floor(Date.now() / 1000))

test('dry run', () => {
  const t0 = performance.now()
  HttpActionsMock.testInstance().sendRequest = (req) => {
    const r = Bun.spawnSync(['curl', '-sS', '--max-time', '30', '-A', 'isotherm-cre-dryrun/1.0', '-w', '\n%{http_code}', req.url])
    const raw = r.stdout.toString()
    const i = raw.lastIndexOf('\n')
    console.log(`[http] ${raw.slice(i + 1)} ${i}B ${req.url}`)
    return { statusCode: Number(raw.slice(i + 1)), body: new TextEncoder().encode(raw.slice(0, i)), headers: {} }
  }
  const evm = EvmMock.testInstance(MONAD_TESTNET_SELECTOR)
  evm.callContract = (req) => {
    const abs = req.blockNumber?.absVal as Uint8Array | undefined
    const tag = abs && abs.length === 1 && abs[0] === 3 ? 'finalized' : 'latest'
    const out = rpc.call('eth_call', [{ to: bytesToHex(req.call!.to as Uint8Array), data: bytesToHex(req.call!.data as Uint8Array) }, tag]) as Hex
    return { data: Buffer.from(out.slice(2), 'hex').toString('base64') }
  }
  evm.writeReport = (input) => {
    const payload = `0x${bytesToHex(input.report!.rawReport as Uint8Array).slice(2 + 109 * 2)}` as Hex
    const r = decodeReport(payload)
    let verdict = 'accepted'
    try {
      rpc.call('eth_call', [{ from: deployments.activeForwarder as Address, to: deployments.resolver as Address, data: encodeFunctionData({ abi: R, functionName: 'onReport', args: ['0x', payload] }) }, 'latest'])
    } catch (e: any) {
      try {
        verdict = decodeErrorResult({ abi: R, data: e.data }).errorName
      } catch {
        verdict = String(e.message).slice(0, 100)
      }
    }
    console.log(`[would write] ${r.station} ${r.date} tmaxC=${r.tmaxC} isVoid=${r.isVoid} validUntil=${r.validUntil} gasLimit=${input.gasConfig!.gasLimit} | onReport eth_call with a throwaway key: ${verdict} (InvalidAttestation expected; anything else is a real problem)`)
    return { txStatus: 2, txHash: new Uint8Array(32) }
  }
  const ns = new Map([['ISOTHERM_ATTESTER_KEY', DRY_KEY]])
  const rt = newTestRuntime(new Map([['main', ns], ['default', ns]]), { timeProvider: () => at * 1000 }, cfg)
  const out = onCron(rt, cronPayload(at))
  for (const l of rt.getLogs()) console.log(`[USER LOG] ${l}`)
  console.log(`[result] ${out}`)
  console.log(`[time] ${Math.round(performance.now() - t0)} ms against ${RPC}`)
})
