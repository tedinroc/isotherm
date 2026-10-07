// Isotherm v1 settlement report + attestation. Byte-for-byte contract with src/Resolver.sol (v1, live at
// 0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B on Monad testnet 10143):
//
//   report    = abi.encode(bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash,
//                          uint64 validUntil, bytes signature)
//   signature = 65 bytes r||s||v (v in {27,28}, low-s) by the attester over the EIP-712 digest of
//               Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash,uint64 validUntil)
//               domain { name: "Isotherm Resolver", version: "1", chainId, verifyingContract: resolver }
//
// Accepted on chain only if: msg.sender == forwarder, not paused, block.timestamp <= validUntil, signer == attester,
// block.timestamp >= dayEnd(station,date), not already resolved, and tmaxC in [-90,70] unless isVoid.
// Pure JS (viem + @noble/curves): runs unchanged in Bun tests and in the CRE WASM (QuickJS) runtime.
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  type Address,
  type Hex,
  bytesToHex,
  decodeAbiParameters,
  encodeAbiParameters,
  hashTypedData,
  hexToBytes,
  keccak256,
  parseAbiParameters,
  stringToBytes,
  stringToHex,
} from 'viem'
import type { DayStats } from './settle-core'

export const SETTLEMENT_TYPEHASH = '0x5bbd6085fa1e132afc3602af7c54c19de8708e48567c4c8e2b19fe541e2a0535' as const
export const MIN_TMAX_C = -90
export const MAX_TMAX_C = 70

export type SettlementBody = {
  station: string // ICAO, 4 chars, e.g. "RCSS"
  date: number // station-local calendar date as yyyymmdd, e.g. 20261005
  tmaxC: number // integer degC (0 when isVoid)
  isVoid: boolean
  sourcesHash: Hex // keccak256 of the canonical source summary (see canonicalSources)
  validUntil: bigint // unix seconds, inclusive
}

export const stationToBytes4 = (icao: string): Hex => {
  if (!/^[A-Z0-9]{4}$/.test(icao)) throw new Error(`bad ICAO ${icao}`)
  return stringToHex(icao, { size: 4 })
}

export const bytes4ToStation = (b4: Hex): string => {
  const h = b4.toLowerCase()
  if (!/^0x[0-9a-f]{8}$/.test(h)) throw new Error(`bad bytes4 ${b4}`)
  let s = ''
  for (let i = 2; i < 10; i += 2) s += String.fromCharCode(Number.parseInt(h.slice(i, i + 2), 16))
  return s
}

export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: 'station', type: 'bytes4' },
    { name: 'date', type: 'uint32' },
    { name: 'tmaxC', type: 'int16' },
    { name: 'isVoid', type: 'bool' },
    { name: 'sourcesHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const

export const settlementDomain = (chainId: bigint, resolver: Address) =>
  ({ name: 'Isotherm Resolver', version: '1', chainId, verifyingContract: resolver }) as const

/** Equals Resolver.settlementDigest(station, date, tmaxC, isVoid, sourcesHash, validUntil). */
export const settlementDigest = (chainId: bigint, resolver: Address, b: SettlementBody): Hex =>
  hashTypedData({
    domain: settlementDomain(chainId, resolver),
    types: SETTLEMENT_TYPES,
    primaryType: 'Settlement',
    message: {
      station: stationToBytes4(b.station),
      date: b.date,
      tmaxC: b.tmaxC,
      isVoid: b.isVoid,
      sourcesHash: b.sourcesHash,
      validUntil: b.validUntil,
    },
  })

/** Deterministic (RFC 6979) low-s secp256k1 signature, r||s||v with v = 27/28. Synchronous: QuickJS-safe. */
export const signDigest = (privateKey: Hex, digest: Hex): Hex => {
  const sig = secp256k1.sign(hexToBytes(digest), hexToBytes(privateKey), { lowS: true })
  const out = new Uint8Array(65)
  out.set(sig.toCompactRawBytes(), 0)
  out[64] = 27 + sig.recovery
  return bytesToHex(out)
}

export const REPORT_PARAMS = parseAbiParameters(
  'bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash, uint64 validUntil, bytes signature',
)

/** Payload delivered to Resolver.onReport(metadata, report). */
export const encodeReport = (b: SettlementBody, signature: Hex): Hex => {
  if (!Number.isInteger(b.tmaxC)) throw new Error(`tmaxC must be an integer, got ${b.tmaxC}`)
  if (b.isVoid && b.tmaxC !== 0) throw new Error('a VOID report carries tmaxC = 0')
  if (!b.isVoid && (b.tmaxC < MIN_TMAX_C || b.tmaxC > MAX_TMAX_C)) throw new Error(`tmaxC ${b.tmaxC} out of range`)
  if ((signature.length - 2) / 2 !== 65) throw new Error('signature must be 65 bytes')
  return encodeAbiParameters(REPORT_PARAMS, [
    stationToBytes4(b.station),
    b.date,
    b.tmaxC,
    b.isVoid,
    b.sourcesHash,
    b.validUntil,
    signature,
  ])
}

export const decodeReport = (payload: Hex): SettlementBody & { signature: Hex } => {
  const [station, date, tmaxC, isVoid, sourcesHash, validUntil, signature] = decodeAbiParameters(REPORT_PARAMS, payload)
  return { station: bytes4ToStation(station), date, tmaxC, isVoid, sourcesHash, validUntil, signature }
}

/** Sign + encode in one step (what the workflow does per settled/voided station-date). */
export const buildSignedReport = (
  attesterKey: Hex,
  chainId: bigint,
  resolver: Address,
  b: SettlementBody,
): { digest: Hex; signature: Hex; payload: Hex } => {
  const digest = settlementDigest(chainId, resolver, b)
  const signature = signDigest(attesterKey, digest)
  return { digest, signature, payload: encodeReport(b, signature) }
}

// ------------------------------------------------------------------------------------------- sourcesHash
export type NamedStats = { name: 'IEM' | 'AWC' | 'OGIMET'; stats: (DayStats & { healthy?: boolean }) | null } // null = not fetched

const fmtStats = (s: (DayStats & { healthy?: boolean }) | null): string =>
  s === null
    ? '-'
    : s.healthy === false
      ? 'unavailable'
      : `${s.tmaxC === null ? 'null' : s.tmaxC},${s.nObs},${s.nHours},${s.lastLocal ?? '-'},${s.complete ? 1 : 0}`

/**
 * Canonical, consensus-stable summary of what the decision was based on (only DON-agreed values), e.g.
 *   isotherm-sources-v1|RCSS|20261005|SETTLED|IEM:29,50,24,23:30,1|AWC:29,50,24,23:30,1|OGIMET:-
 * per source: tmaxC,nObs,nHours,lastLocal,complete  |  "-" = not fetched  |  "unavailable" = error/timeout/throttle
 * Anyone can recompute it from the public METAR archives with settle-core.ts and compare it to the on-chain hash.
 */
export const canonicalSources = (icao: string, date: number, status: string, sources: NamedStats[]): string =>
  ['isotherm-sources-v1', icao, String(date), status, ...sources.map((s) => `${s.name}:${fmtStats(s.stats)}`)].join('|')

export const sourcesHashOf = (canonical: string): Hex => keccak256(stringToBytes(canonical))
