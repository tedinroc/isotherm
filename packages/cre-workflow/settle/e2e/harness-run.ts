// HARNESS RUNNER (fallback, NOT the CRE engine): runs the same onCron handler in the CRE SDK test harness (Bun, not
// WASM/QuickJS) with real HTTP, real eth_call reads and real delivery through the MockKeystoneForwarder - exactly the
// call `cre workflow simulate --broadcast` makes - so ladders still settle if nobody has run `cre login` yet.
// Reports carry the same EIP-712 attester signature; the Resolver cannot tell the two paths apart, by design.
// Invoked by scripts/run-official.sh --harness (which does the preflight, spacing guard and receipt confirmation).
//
// Env: ISOTHERM_RPC (default live testnet), ISOTHERM_ATTESTER_KEY_FILE, ISOTHERM_TX_KEY_FILE (read in-process, never
//      printed), HARNESS_BROADCAST=1 to send (otherwise stops before sending), HARNESS_EXTRA=ICAO:YYYY-MM-DD,...,
//      HARNESS_AT=<unix s> (fork tests only), HARNESS_CONFIG (default ./config.testnet.json).
import { EvmMock, HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { readFileSync } from 'node:fs'
import { type Hex, bytesToHex, concat, keccak256, stringToBytes } from 'viem'
import { configSchema } from '../config'
import { decodeReport } from '../report'
import { onCron } from '../workflow'
import { cronPayload, MONAD_TESTNET_SELECTOR } from '../test/helpers'
import { deployments, makeRpc, simulatorHeader } from './chain'

const env = (k: string) => process.env[k] || undefined
const RPC = env('ISOTHERM_RPC') ?? 'https://testnet-rpc.monad.xyz'
const readKey = (file: string | undefined): Hex => {
  if (!file) throw new Error('key file env missing')
  const k = readFileSync(file, 'utf8').trim()
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex
}
const cfg = configSchema.parse({
  ...JSON.parse(readFileSync(new URL(`../${(env('HARNESS_CONFIG') ?? './config.testnet.json').replace(/^\.\//, '')}`, import.meta.url), 'utf8')),
  ...(env('HARNESS_EXTRA') ? { extraTargets: env('HARNESS_EXTRA')!.split(',').map((s) => ({ icao: s.split(':')[0], date: s.split(':')[1] })) } : {}),
})
const BROADCAST = env('HARNESS_BROADCAST') === '1'
const at = Number(env('HARNESS_AT') ?? Math.floor(Date.now() / 1000))
const rpc = makeRpc(RPC)
const forwarder = deployments.activeForwarder as Hex

test('harness run', () => {
  const attesterKey = readKey(env('ISOTHERM_ATTESTER_KEY_FILE'))
  HttpActionsMock.testInstance().sendRequest = (req) => {
    const r = Bun.spawnSync(['curl', '-sS', '--max-time', '10', '-A', 'isotherm-cre-harness/1.0', '-w', '\n%{http_code}', req.url])
    const raw = r.stdout.toString()
    const i = raw.lastIndexOf('\n')
    console.log(`[http] ${raw.slice(i + 1) || 'ERR'} ${Math.max(i, 0)}B ${req.url}`)
    return { statusCode: Number(raw.slice(i + 1)) || 0, body: new TextEncoder().encode(i > 0 ? raw.slice(0, i) : ''), headers: {} }
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
    const rawReport = concat([simulatorHeader(keccak256(stringToBytes(`isotherm-harness-${r.station}-${r.date}-${r.validUntil}`))), payload])
    if (!BROADCAST) {
      console.log(`[not sent] ${r.station} ${r.date} tmaxC=${r.tmaxC} isVoid=${r.isVoid} validUntil=${r.validUntil} (HARNESS_BROADCAST!=1)`)
      return { txStatus: 2, txHash: new Uint8Array(32) }
    }
    const p = Bun.spawnSync(['bun', new URL('./send-report.ts', import.meta.url).pathname, RPC, forwarder, bytesToHex(input.receiver as Uint8Array), rawReport, input.gasConfig!.gasLimit.toString()], {
      env: { ...process.env, ISOTHERM_TX_KEY_FILE: env('ISOTHERM_TX_KEY_FILE') ?? '' },
    })
    if (p.exitCode !== 0) throw new Error(`send-report failed: ${p.stderr.toString().slice(0, 300)}`)
    const s = JSON.parse(p.stdout.toString().trim().split('\n').pop()!)
    console.log(`[sent] ${r.station} ${r.date} tmaxC=${r.tmaxC} isVoid=${r.isVoid} tx ${s.hash} status=${s.status} gasUsed=${s.gasUsed}/${s.gasLimit} ${s.ms} ms`)
    return { txStatus: s.status === 'success' ? 2 : 1, txHash: Buffer.from(s.hash.slice(2), 'hex') }
  }
  const ns = new Map([['ISOTHERM_ATTESTER_KEY', attesterKey]])
  const rt = newTestRuntime(new Map([['main', ns], ['default', ns]]), { timeProvider: () => at * 1000 }, cfg)
  const out = onCron(rt, cronPayload(at))
  for (const l of rt.getLogs()) console.log(`[USER LOG] ${l}`)
  console.log(`[result] ${out}`)
})
