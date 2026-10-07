// Synchronous JSON-RPC helpers for the anvil-fork e2e (the CRE SDK harness calls capabilities synchronously).
// Fork only: uses anvil's unlocked dev accounts and impersonation; never a real key.
import { readFileSync } from 'node:fs'
import { type Abi, type Address, type Hex, concat, encodeFunctionData, sha256, stringToBytes, stringToHex, toHex } from 'viem'

export const ROOT = new URL('../../../../', import.meta.url)
export const deployments = JSON.parse(readFileSync(new URL('deployments/testnet.json', ROOT), 'utf8'))
export const abi = (name: string) => JSON.parse(readFileSync(new URL(`packages/abi/${name}.json`, ROOT), 'utf8')) as Abi

export const FORWARDER_ABI = [
  {
    type: 'function',
    name: 'report',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'receiver', type: 'address' },
      { name: 'rawReport', type: 'bytes' },
      { name: 'reportContext', type: 'bytes' },
      { name: 'signatures', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'ReportProcessed',
    inputs: [
      { name: 'receiver', type: 'address', indexed: true },
      { name: 'workflowExecutionId', type: 'bytes32', indexed: true },
      { name: 'reportId', type: 'bytes2', indexed: true },
      { name: 'result', type: 'bool', indexed: false },
    ],
  },
] as const

export const makeRpc = (url: string) => {
  let id = 0
  const call = (method: string, params: unknown[] = []): any => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }, (_, v) => (typeof v === 'bigint' ? toHex(v) : v))
    const r = Bun.spawnSync(['curl', '-sS', '--max-time', '60', '-H', 'content-type: application/json', '--data-binary', '@-', url], { stdin: new TextEncoder().encode(body) })
    if (r.exitCode !== 0) throw new Error(`curl ${method}: ${r.stderr.toString()}`)
    const j = JSON.parse(r.stdout.toString())
    if (j.error) {
      const e = new Error(`${method}: ${JSON.stringify(j.error)}`) as Error & { data?: Hex }
      e.data = j.error.data
      throw e
    }
    return j.result
  }
  const send = (from: Address, to: Address, data: Hex, gas: bigint) => {
    const hash = call('eth_sendTransaction', [{ from, to, data, gas: toHex(gas) }]) as Hex
    for (let i = 0; i < 200; i++) {
      const rcpt = call('eth_getTransactionReceipt', [hash])
      if (rcpt) return { hash, rcpt }
      Bun.sleepSync(50)
    }
    throw new Error(`no receipt for ${hash} after 10 s`)
  }
  const write = (from: Address, to: Address, abiDef: Abi, functionName: string, args: unknown[], gas = 3_000_000n) => {
    const r = send(from, to, encodeFunctionData({ abi: abiDef, functionName, args } as any), gas)
    if (r.rcpt.status !== '0x1') throw new Error(`${functionName} reverted (${r.hash})`)
    return r
  }
  const impersonate = (who: Address) => {
    call('anvil_impersonateAccount', [who])
    call('anvil_setBalance', [who, toHex(10n ** 20n)])
  }
  const blockTime = (tag = 'latest') => Number(BigInt(call('eth_getBlockByNumber', [tag, false]).timestamp))
  const warpTo = (t: number, mine = 80) => {
    call('evm_setNextBlockTimestamp', [toHex(t)])
    call('anvil_mine', [toHex(mine), toHex(1)]) // `mine` blocks 1 s apart: the finalized tag (latest - 64) moves too
  }
  return { call, send, write, impersonate, blockTime, warpTo }
}

/** The CRE simulator's 109-byte report header (consensustypes.Metadata, fixed sim identity: standalone_engine.go). */
export const simulatorHeader = (executionId: Hex, workflowName = 'isotherm-settle'): Hex =>
  concat([
    '0x01',
    executionId,
    toHex(100, { size: 4 }), // timestamp: hard-coded 100 by the simulator
    toHex(1, { size: 4 }), // don id
    toHex(1, { size: 4 }), // don config version
    `0x${'11'.repeat(32)}`, // workflow id
    stringToHex(sha256(stringToBytes(workflowName)).slice(2, 12), { size: 10 }),
    `0x${'aa'.repeat(20)}`, // workflow owner
    '0x0001', // report id
  ])
