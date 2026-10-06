// Isotherm settlement report encoding + attester signature.
// Byte-for-byte contract with isotherm/src/Resolver.sol (contracts builder):
//   report      = abi.encode(bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash, bytes attestation)
//   attestation = 65-byte ECDSA (r||s||v, v∈{27,28}) by `attester` over the EIP-712 digest
//                 Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash)
//                 domain { name: "Isotherm Resolver", version: "1", chainId, verifyingContract: resolver }
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  type Address,
  type Hex,
  bytesToHex,
  encodeAbiParameters,
  hashTypedData,
  hexToBytes,
  keccak256,
  parseAbiParameters,
  stringToBytes,
  stringToHex,
} from 'viem'

export type SettlementBody = {
  station: string // ICAO, 4 chars, e.g. "RCSS"
  date: number // station-local calendar date as yyyymmdd, e.g. 20261005
  tmaxC: number // integer °C (0 when voided)
  isVoid: boolean // true = sources disagreed
  sourcesHash: Hex // keccak256 of the canonical per-source summary
}

export const stationToBytes4 = (icao: string): Hex => {
  if (!/^[A-Z0-9]{4}$/.test(icao)) throw new Error(`bad ICAO ${icao}`)
  return stringToHex(icao, { size: 4 })
}

/** Canonical, consensus-stable source summary (derived only from DON-agreed values). */
export const sourcesHash = (iem: { tmax: number; obs: number }, awc: { tmax: number; obs: number }): Hex =>
  keccak256(stringToBytes(`IEM:${iem.tmax}:${iem.obs}|AWC:${awc.tmax}:${awc.obs}`))

export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: 'station', type: 'bytes4' },
    { name: 'date', type: 'uint32' },
    { name: 'tmaxC', type: 'int16' },
    { name: 'isVoid', type: 'bool' },
    { name: 'sourcesHash', type: 'bytes32' },
  ],
} as const

/** Equals Resolver.settlementDigest(station, date, tmaxC, isVoid, sourcesHash). */
export const settlementDigest = (chainId: bigint, resolver: Address, b: SettlementBody): Hex =>
  hashTypedData({
    domain: { name: 'Isotherm Resolver', version: '1', chainId, verifyingContract: resolver },
    types: SETTLEMENT_TYPES,
    primaryType: 'Settlement',
    message: { station: stationToBytes4(b.station), date: b.date, tmaxC: b.tmaxC, isVoid: b.isVoid, sourcesHash: b.sourcesHash },
  })

/** Deterministic (RFC6979) secp256k1 signature over a 32-byte digest. Synchronous, pure JS: QuickJS-safe. */
export const signDigest = (privateKey: Hex, digest: Hex): Hex => {
  const sig = secp256k1.sign(hexToBytes(digest), hexToBytes(privateKey))
  const out = new Uint8Array(65)
  out.set(sig.toCompactRawBytes(), 0)
  out[64] = 27 + sig.recovery
  return bytesToHex(out)
}

export const REPORT_PARAMS = parseAbiParameters(
  'bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash, bytes attestation',
)

/** Payload delivered to Resolver.onReport(metadata, report). */
export const encodeReport = (b: SettlementBody, attestation: Hex): Hex =>
  encodeAbiParameters(REPORT_PARAMS, [stationToBytes4(b.station), b.date, b.tmaxC, b.isVoid, b.sourcesHash, attestation])
