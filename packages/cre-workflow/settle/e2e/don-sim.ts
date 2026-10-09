// FORK ONLY. Stands in for a Chainlink DON on an anvil fork of Monad testnet, so the production KeystoneForwarder
// (0xF834…4482, "KeystoneForwarder 1.0.0") can be exercised end to end without a deployment:
//   - registers a throwaway signer set on the forked forwarder (its owner is impersonated; anvil only),
//   - builds the 109-byte production report header (version 1, real timestamp, donId/configVersion, workflow id,
//     10-byte name, workflow owner, reportId 0x0000) exactly as live DON reports on Monad testnet carry it,
//   - signs keccak256(keccak256(rawReport) || reportContext) with f+1 signers (r || s || v, v = 0/1; the forwarder adds 27).
// The signer keys are derived from public strings and are worthless. Nothing here can touch live testnet: the live
// forwarder only accepts the real DON's signers.
import { secp256k1 } from '@noble/curves/secp256k1'
import { type Address, type Hex, bytesToHex, concat, encodeFunctionData, hexToBytes, keccak256, parseAbi, sha256, stringToBytes, stringToHex, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const KEYSTONE_ABI = parseAbi([
  'function owner() view returns (address)',
  'function typeAndVersion() view returns (string)',
  'function setConfig(uint32 donId, uint32 configVersion, uint8 f, address[] signers)',
  'function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)',
  'function getTransmissionInfo(address receiver, bytes32 workflowExecutionId, bytes2 reportId) view returns ((bytes32 transmissionId, uint8 state, address transmitter, bool invalidReceiver, bool success, uint80 gasLimit))',
  'event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)',
  'error InvalidSignatureCount(uint256 expected, uint256 received)',
  'error InvalidSigner(address signer)',
  'error InvalidConfig(uint64 configId)',
  'error InsufficientGasForRouting(bytes32 transmissionId)',
  'error AlreadyAttempted(bytes32 transmissionId)',
])

/** IRouter.TransmissionState */
export const TX_STATE = ['NOT_ATTEMPTED', 'SUCCEEDED', 'INVALID_RECEIVER', 'FAILED'] as const

/** n throwaway signer keys, derived from public strings (fork only). */
export const forkSignerKeys = (n: number, tag = 'isotherm-fork-don-signer'): Hex[] =>
  Array.from({ length: n }, (_, i) => keccak256(stringToBytes(`${tag}-${i}`)))
export const addressOf = (k: Hex): Address => privateKeyToAccount(k).address

/** The 10-byte workflow-name field: the first 10 hex characters of sha256(name), as ASCII (CRE encoding). */
export const workflowNameField = (name: string): Hex => stringToHex(sha256(stringToBytes(name)).slice(2, 12), { size: 10 })

export type HeaderFields = {
  executionId: Hex
  timestamp: number
  donId: number
  configVersion: number
  workflowId: Hex
  workflowName: string
  workflowOwner: Address
  reportId?: Hex
}

/** Production report header (109 bytes), the layout KeystoneForwarder._getMetadata reads. */
export const productionHeader = (h: HeaderFields): Hex => {
  const out = concat([
    '0x01',
    h.executionId,
    toHex(h.timestamp, { size: 4 }),
    toHex(h.donId, { size: 4 }),
    toHex(h.configVersion, { size: 4 }),
    h.workflowId,
    workflowNameField(h.workflowName),
    h.workflowOwner,
    h.reportId ?? '0x0000',
  ])
  if ((out.length - 2) / 2 !== 109) throw new Error(`header is ${(out.length - 2) / 2} bytes`)
  return out
}

/** DON signatures over keccak256(keccak256(rawReport) || reportContext); v = recovery id (0/1). */
export const donSign = (rawReport: Hex, reportContext: Hex, keys: Hex[]): Hex[] => {
  const digest = keccak256(concat([keccak256(rawReport), reportContext]))
  return keys.map((k) => {
    const s = secp256k1.sign(hexToBytes(digest), hexToBytes(k), { lowS: true })
    const out = new Uint8Array(65)
    out.set(s.toCompactRawBytes(), 0)
    out[64] = s.recovery
    return bytesToHex(out)
  })
}

/** A 96-byte report context (config digest | sequence number | padding), as live DON reports carry. */
export const reportContextFor = (seed: string): Hex => concat([keccak256(stringToBytes(`${seed}-digest`)), toHex(BigInt(keccak256(stringToBytes(`${seed}-seq`))) & 0xffffffffn, { size: 32 }), toHex(0, { size: 32 })])

export const reportCalldata = (receiver: Address, rawReport: Hex, reportContext: Hex, signatures: Hex[]): Hex =>
  encodeFunctionData({ abi: KEYSTONE_ABI, functionName: 'report', args: [receiver, rawReport, reportContext, signatures] })

/** Gas-limit sizing rule for the DON target (DON-CUTOVER.md §2): 1.5 x the measured minimum through the production
 *  KeystoneForwarder, rounded up to 10k, never below 350k. */
export const recommendGasLimit = (minimum: number) => Math.max(350_000, Math.ceil((minimum * 1.5) / 10_000) * 10_000)
