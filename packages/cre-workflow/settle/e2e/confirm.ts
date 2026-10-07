// Confirms report txs on chain. The (Mock)KeystoneForwarder never reverts when onReport fails, so tx status proves
// nothing: decode ReportProcessed(result) and the Resolver's LadderResolved instead.
//   bun e2e/confirm.ts [--rpc URL] 0xtx1 0xtx2 ...      exit 4 if any report was not accepted
import { type Hex, createPublicClient, decodeEventLog, http, parseAbi } from 'viem'

const args = process.argv.slice(2)
const ri = args.indexOf('--rpc')
const rpc = ri >= 0 ? args.splice(ri, 2)[1] : 'https://testnet-rpc.monad.xyz'
const pub = createPublicClient({ transport: http(rpc) })
const ABI = parseAbi([
  'event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)',
  'event LadderResolved(bytes4 indexed station, uint32 indexed date, uint8 status, int16 tmaxC, bytes32 sourcesHash, address caller)',
])
let bad = 0
for (const h of args) {
  const r = await pub.getTransactionReceipt({ hash: h as Hex })
  const ev = r.logs.flatMap((l) => {
    try {
      return [decodeEventLog({ abi: ABI, data: l.data, topics: l.topics })]
    } catch {
      return []
    }
  })
  const processed = ev.find((e) => e.eventName === 'ReportProcessed') as any
  const resolved = ev.find((e) => e.eventName === 'LadderResolved') as any
  const ok = r.status === 'success' && processed?.args.result === true && !!resolved
  if (!ok) bad++
  const st = resolved ? `${Buffer.from(resolved.args.station.slice(2), 'hex').toString()} ${resolved.args.date} status=${['None', 'Settled', 'Void'][resolved.args.status]} tmaxC=${resolved.args.tmaxC}` : '-'
  console.log(`${h} block ${r.blockNumber} status=${r.status} gasUsed=${r.gasUsed} ReportProcessed.result=${processed?.args.result} LadderResolved: ${st} ${ok ? 'OK' : 'NOT ACCEPTED'}`)
}
process.exit(bad ? 4 : 0)
