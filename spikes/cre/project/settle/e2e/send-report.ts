// Sends (Mock)KeystoneForwarder.report(receiver, rawReport, reportContext, signatures) — the exact call the CRE
// simulator's FakeEVMChain.WriteReport makes — and prints the receipt as JSON. The signing key comes from the
// environment (ISOTHERM_TX_KEY), never from argv, so it does not show up in `ps`.
// usage: bun e2e/send-report.ts <rpc> <forwarder> <receiver> <rawReportHex> <gasLimit>
import { type Address, type Hex, createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const [rpc, forwarder, receiver, rawReport, gasLimit] = process.argv.slice(2)
const key = process.env.ISOTHERM_TX_KEY as Hex | undefined
if (!key) throw new Error('ISOTHERM_TX_KEY missing')
const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex)
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
  gas: BigInt(gasLimit), // Monad bills the gas LIMIT: never let the client pad it
})
const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 })
console.log(JSON.stringify({ hash, status: r.status, gasUsed: r.gasUsed.toString(), gasLimit, effectiveGasPrice: r.effectiveGasPrice.toString(), blockNumber: r.blockNumber.toString(), from: account.address, ms: Math.round(performance.now() - t0) }))
