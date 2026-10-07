// Sends (Mock)KeystoneForwarder.report(receiver, rawReport, reportContext, signatures) - the exact call the CRE
// simulator's FakeEVMChain.WriteReport makes - and prints the receipt as JSON. The signing key is read from the file
// named by ISOTHERM_TX_KEY_FILE (never from argv or stdout). Gas limit is passed explicitly: Monad bills the LIMIT.
// usage: bun e2e/send-report.ts <rpc> <forwarder> <receiver> <rawReportHex> <gasLimit>
import { readFileSync } from 'node:fs'
import { type Address, type Hex, createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const [rpc, forwarder, receiver, rawReport, gasLimit] = process.argv.slice(2)
const file = process.env.ISOTHERM_TX_KEY_FILE
if (!file) throw new Error('ISOTHERM_TX_KEY_FILE missing')
const raw = readFileSync(file, 'utf8').trim()
const account = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex)
const pub = createPublicClient({ transport: http(rpc) })
const chainId = await pub.getChainId()
const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const
const wallet = createWalletClient({ chain, account, transport: http(rpc) })
const t0 = performance.now()
const hash = await wallet.writeContract({
  address: forwarder as Address,
  abi: parseAbi(['function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)']),
  functionName: 'report',
  args: [receiver as Address, rawReport as Hex, '0x', []],
  gas: BigInt(gasLimit),
})
const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 60_000 })
console.log(JSON.stringify({ hash, status: r.status, gasUsed: r.gasUsed.toString(), gasLimit, blockNumber: r.blockNumber.toString(), from: account.address, ms: Math.round(performance.now() - t0) }))
