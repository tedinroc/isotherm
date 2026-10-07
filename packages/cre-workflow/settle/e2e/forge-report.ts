// FORK ONLY: deliver a deliberately WRONG settlement (a "stolen attester key" report) so the challenge watcher can be
// tested end to end. Signs with the fork's test attester key (public anvil key #9) and sends through the
// MockKeystoneForwarder from anvil's unlocked dev account #1. Refuses any non-loopback RPC and the live attester key.
//   ISOTHERM_RPC=http://127.0.0.1:PORT ISOTHERM_ATTESTER_KEY_FILE=... bun e2e/forge-report.ts RCSS 20261008 31
import { readFileSync } from 'node:fs'
import { type Address, type Hex, concat, encodeFunctionData, keccak256, stringToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildSignedReport } from '../report'
import { deployments, FORWARDER_ABI, makeRpc, simulatorHeader } from './chain'
import { isLoopbackRpc } from './http'

const RPC = process.env.ISOTHERM_RPC ?? ''
if (!isLoopbackRpc(RPC)) throw new Error(`forge-report is for anvil forks only (ISOTHERM_RPC=${RPC})`)
const raw = readFileSync(process.env.ISOTHERM_ATTESTER_KEY_FILE ?? '', 'utf8').trim()
const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
if (privateKeyToAccount(key).address.toLowerCase() === String(deployments.roles.attester).toLowerCase()) throw new Error('refusing the LIVE attester key')
const [icao, date, tmax] = process.argv.slice(2)
const rpc = makeRpc(RPC)
const now = Number(BigInt(rpc.call('eth_getBlockByNumber', ['latest', false]).timestamp))
const body = { station: icao, date: Number(date), tmaxC: Number(tmax), isVoid: false, sourcesHash: keccak256(stringToBytes(`forged-for-watcher-test|${icao}|${date}|${tmax}`)), validUntil: BigInt(now + 600) }
const s = buildSignedReport(key, 10143n, deployments.resolver as Address, body)
const rawReport = concat([simulatorHeader(keccak256(stringToBytes(`isotherm-forged-${icao}-${date}`))), s.payload])
const { hash, rcpt } = rpc.send('0x70997970C51812dc3A010C7d01b50e0d17dc79C8', deployments.mockForwarder as Address, encodeFunctionData({ abi: FORWARDER_ABI, functionName: 'report', args: [deployments.resolver, rawReport, '0x', []] }), 200_000n)
console.log(`[forged] ${icao} ${date} tmaxC=${tmax} signed by the fork's test attester; tx ${hash} status=${rcpt.status} gasUsed=${BigInt(rcpt.gasUsed)}`)
