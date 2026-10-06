// "Login-free local simulator": runs the REAL workflow handler (onCron) inside the official CRE SDK test runtime,
// but wires its capabilities to the real world instead of mocks:
//   HTTP capability  -> real HTTPS GETs to IEM + aviationweather.gov (synchronous curl)
//   EVM read         -> real eth_call (anvil fork of Monad testnet, or live testnet)
//   EVM writeReport  -> exactly what `cre workflow simulate --broadcast` does: prepend the simulator's 109-byte
//                       report header and send MockKeystoneForwarder.report(receiver, rawReport, ctx, sigs).
// It first deploys the contracts builder's Resolver (isotherm/src, compiled by ../../onchain) and registers RCSS.
//
// Differences from the real CLI simulator: JS runs in Bun, not QuickJS/WASM (the WASM build is checked separately
// by `cre workflow build`), and DON report signatures are empty (MockKeystoneForwarder ignores them anyway).
//
// Anvil fork (no MON needed; uses public anvil dev keys + anvil_setBalance):
//   ISOTHERM_E2E_RPC=http://127.0.0.1:18845 bun test --timeout 120000 ./e2e/anvil.e2e.test.ts
// Live Monad testnet (spends ~0.3 MON from the deployer):
//   ISOTHERM_E2E_LIVE=1 ISOTHERM_E2E_RPC=https://testnet-rpc.monad.xyz \
//   ISOTHERM_DEPLOYER_KEY="$(cat ~/.config/isotherm/deployer.key)" ISOTHERM_ATTESTER_KEY="$(cat ../../.secrets/attester.key)" \
//   bun test --timeout 180000 ./e2e/anvil.e2e.test.ts
import { expect } from 'bun:test'
import { EvmMock, HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { appendFileSync, readFileSync } from 'node:fs'
import {
  type Address,
  type Hex,
  bytesToHex,
  concat,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http as viemHttp,
  keccak256,
  parseAbi,
  parseEther,
  sha256,
  stringToBytes,
  stringToHex,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { onCron, type Config } from '../workflow'

const RPC = process.env.ISOTHERM_E2E_RPC
const LIVE = process.env.ISOTHERM_E2E_LIVE === '1'
const MOCK_FORWARDER = '0xB9F79d863261869B234c481D1f9A7af84AeAd192' as Address
const MONAD_TESTNET_SELECTOR = 2183018362218727504n
const WORKFLOW_NAME = 'isotherm-settle'
const with0x = (k: string) => (k.startsWith('0x') ? k : `0x${k}`) as Hex
// Fork mode: well-known anvil dev keys (#0 deployer/owner/transmitter, #9 attester). Live mode: keys from env.
const DEPLOYER_KEY = LIVE ? with0x(process.env.ISOTHERM_DEPLOYER_KEY ?? '') : ('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex)
const ATTESTER_KEY = LIVE ? with0x(process.env.ISOTHERM_ATTESTER_KEY ?? '') : ('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as Hex)

const sh = (cmd: string[], input?: string, env?: Record<string, string>): string => {
  const r = Bun.spawnSync(cmd, { stdin: input ? new TextEncoder().encode(input) : undefined, env: env ? { ...process.env, ...env } : undefined })
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}
const rpcSync = (method: string, params: unknown[]) => {
  const out = sh(['curl', '-sS', '--max-time', '30', '-H', 'content-type: application/json', '--data-binary', '@-', RPC!],
    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
  const j = JSON.parse(out)
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
  return j.result
}
const b64 = (hex: Hex) => Buffer.from(hex.slice(2), 'hex').toString('base64')
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
const evidence = (line: string) => {
  console.log(line)
  appendFileSync(new URL(`../../../logs/e2e-${LIVE ? 'live' : 'anvil'}.log`, import.meta.url), `${new Date().toISOString()} ${line}\n`)
}

/** consensustypes.Metadata.Encode() with the simulator's fixed identity (standalone_engine.go). */
const simulatorHeader = (executionId: Hex): Hex => {
  const nameHash = sha256(stringToBytes(WORKFLOW_NAME)).slice(2, 12) // first 10 hex chars, as ASCII
  return concat([
    '0x01',
    executionId,
    toHex(100, { size: 4 }), // timestamp: hard-coded 100 in fakeConsensusNoDAG
    toHex(1, { size: 4 }), // don id
    toHex(1, { size: 4 }), // don config version
    `0x${'11'.repeat(32)}`, // workflow id
    stringToHex(nameHash, { size: 10 }),
    `0x${'aa'.repeat(20)}`, // workflow owner
    '0x0001', // report id
  ])
}

const FORWARDER_ABI = parseAbi([
  'event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)',
])

test('E2E: cron -> resultOf read -> live IEM+AWC -> report -> MockKeystoneForwarder -> Resolver', async () => {
  if (!RPC) {
    console.log('ISOTHERM_E2E_RPC not set; skipping')
    return
  }
  if (LIVE && (DEPLOYER_KEY.length !== 66 || ATTESTER_KEY.length !== 66)) throw new Error('live mode needs ISOTHERM_DEPLOYER_KEY + ISOTHERM_ATTESTER_KEY')
  const deployer = privateKeyToAccount(DEPLOYER_KEY)
  const attester = privateKeyToAccount(ATTESTER_KEY)
  const pub = createPublicClient({ transport: viemHttp(RPC) })
  const chainId = await pub.getChainId()
  expect(chainId).toBe(10143)
  const chain = { id: chainId, name: 'monad-testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const
  if (!LIVE) await pub.request({ method: 'anvil_setBalance' as any, params: [deployer.address, toHex(parseEther('100'))] as any })
  const bal0 = await pub.getBalance({ address: deployer.address })
  evidence(`mode=${LIVE ? 'LIVE monad-testnet' : 'anvil-fork'} rpc=${RPC} block=${await pub.getBlockNumber()} deployer=${deployer.address} balance=${bal0} attester=${attester.address}`)

  // 1) Deploy the builder's Resolver (unmodified) and register RCSS (UTC+8). Tight gas: estimate, then +5%.
  const art = JSON.parse(readFileSync(new URL('../../../onchain/out/Resolver.sol/Resolver.json', import.meta.url), 'utf8'))
  const wallet = createWalletClient({ chain, transport: viemHttp(RPC), account: deployer })
  const pad = (g: bigint) => (g * 105n) / 100n
  const deployData = { abi: art.abi, bytecode: art.bytecode.object as Hex, args: [deployer.address, MOCK_FORWARDER, attester.address, deployer.address] }
  const { encodeDeployData } = await import('viem')
  const deployGas = pad(await pub.estimateGas({ account: deployer.address, data: encodeDeployData(deployData) }))
  const deployHash = await wallet.deployContract({ ...deployData, gas: deployGas })
  const dep = await pub.waitForTransactionReceipt({ hash: deployHash, pollingInterval: 250 })
  const resolver = dep.contractAddress!
  evidence(`deploy Resolver tx=${deployHash} status=${dep.status} address=${resolver} gasUsed=${dep.gasUsed} gasLimit=${deployGas}`)
  const regArgs = [stringToHex('RCSS', { size: 4 }), 28800] as const
  const regGas = pad(await pub.estimateContractGas({ address: resolver, abi: art.abi, functionName: 'registerStation', args: regArgs, account: deployer.address }))
  const regHash = await wallet.writeContract({ address: resolver, abi: art.abi, functionName: 'registerStation', args: regArgs, gas: regGas })
  const reg = await pub.waitForTransactionReceipt({ hash: regHash, pollingInterval: 250 })
  evidence(`registerStation(RCSS,+8h) tx=${regHash} status=${reg.status} gasUsed=${reg.gasUsed} gasLimit=${regGas}`)

  // 2) Wire the SDK test runtime's capabilities to the real world
  const httpLog: string[] = []
  HttpActionsMock.testInstance().sendRequest = (req) => {
    const t0 = performance.now()
    const raw = sh(['curl', '-sS', '--max-time', '30', '-w', '\n%{http_code}', req.url])
    const i = raw.lastIndexOf('\n')
    const body = raw.slice(0, i)
    const code = Number(raw.slice(i + 1))
    httpLog.push(`${code} ${body.length}B ${Math.round(performance.now() - t0)}ms ${req.url}`)
    return { statusCode: code, body: new TextEncoder().encode(body), headers: {} }
  }
  const evm = EvmMock.testInstance(MONAD_TESTNET_SELECTOR)
  let reads = 0
  evm.callContract = (req) => {
    reads++
    const result = rpcSync('eth_call', [{ to: bytesToHex(req.call!.to), data: bytesToHex(req.call!.data) }, 'latest']) as Hex
    return { data: b64(result) }
  }
  const sent: { hash: Hex; status: string; gasUsed: string; gasLimit: string; ms: number; rawReport: Hex }[] = []
  evm.writeReport = (req) => {
    const payload = bytesToHex(req.report!.rawReport).slice(2 + 109 * 2) // drop the test runtime's dummy header
    const rawReport = concat([simulatorHeader(keccak256(stringToBytes(`isotherm-e2e-${Date.now()}`))), `0x${payload}`])
    const out = sh(['bun', new URL('./send-report.ts', import.meta.url).pathname, RPC!, MOCK_FORWARDER, bytesToHex(req.receiver), rawReport, req.gasConfig!.gasLimit.toString()],
      undefined, { ISOTHERM_TX_KEY: DEPLOYER_KEY })
    const r = JSON.parse(out.trim().split('\n').pop()!)
    sent.push({ ...r, rawReport })
    return { txStatus: r.status === 'success' ? 2 : 1, txHash: Buffer.from(r.hash.slice(2), 'hex') }
  }

  const config: Config = {
    schedule: '0 30 16 * * *',
    chainSelectorName: 'monad-testnet',
    chainId: '10143',
    resolverAddress: resolver,
    readSettled: true,
    gasLimit: '180000', // measured ~149k used on the fork; Monad charges the limit
    iemBaseUrl: 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py',
    awcBaseUrl: 'https://aviationweather.gov/api/data/metar',
    minObs: 40,
    dateOverride: '2026-10-05',
    stations: [{ icao: 'RCSS', tzOffsetMin: 480 }],
  }
  const ns = new Map([['ISOTHERM_ATTESTER_KEY', ATTESTER_KEY]])
  const runtime = newTestRuntime<Config>(new Map([['main', ns], ['default', ns]]), {}, config)

  // 3) Run #1: should settle
  const t0 = performance.now()
  const out1 = JSON.parse(onCron(runtime))
  const ms = Math.round(performance.now() - t0)
  for (const l of runtime.getLogs()) evidence(`[USER LOG] ${l}`)
  for (const l of httpLog) evidence(`[HTTP] ${l}`)
  evidence(`workflow result #1: ${json(out1)} (${ms} ms wall: 1 eth_call + 2 live HTTP + 1 tx)`)
  expect(sent.length).toBe(1)
  evidence(`rawReport sent to forwarder (${(sent[0].rawReport.length - 2) / 2} bytes): ${sent[0].rawReport}`)
  const rcpt = await pub.getTransactionReceipt({ hash: sent[0].hash })
  const processed = rcpt.logs.filter((l) => l.address.toLowerCase() === MOCK_FORWARDER.toLowerCase()).map((l) => decodeEventLog({ abi: FORWARDER_ABI, data: l.data, topics: l.topics }))
  const resolved = rcpt.logs.filter((l) => l.address.toLowerCase() === resolver.toLowerCase()).map((l) => decodeEventLog({ abi: art.abi, data: l.data, topics: l.topics }))
  evidence(`report tx=${sent[0].hash} status=${rcpt.status} gasUsed=${rcpt.gasUsed} gasLimit=${sent[0].gasLimit} confirm=${sent[0].ms}ms`)
  evidence(`MockKeystoneForwarder.ReportProcessed.result=${json(processed.map((e: any) => e.args.result))}`)
  evidence(`Resolver.LadderResolved=${json(resolved.map((e: any) => e.args))}`)
  expect(rcpt.status).toBe('success')
  expect((processed[0] as any).args.result).toBe(true)
  const r = (await pub.readContract({ address: resolver, abi: art.abi, functionName: 'resultOf', args: [stringToHex('RCSS', { size: 4 }), 20261005] })) as any
  evidence(`resultOf(RCSS,20261005)=${json(r)}`)
  expect(Number(r.status)).toBe(1)
  expect(Number(r.tmaxC)).toBe(29)

  // 4) Run #2: EVM read sees the result and skips (no HTTP, no tx)
  const httpBefore = httpLog.length
  const out2 = JSON.parse(onCron(runtime))
  evidence(`workflow result #2: ${json(out2)}`)
  expect(out2[0].skipped).toBe('already-resolved')
  expect(httpLog.length).toBe(httpBefore)
  expect(sent.length).toBe(1)
  expect(reads).toBe(2)
  const bal1 = await pub.getBalance({ address: deployer.address })
  evidence(`deployer spent ${Number(bal0 - bal1) / 1e18} MON for deploy+register+report`)
})
