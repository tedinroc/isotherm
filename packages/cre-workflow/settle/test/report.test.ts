// v1 report encoding + attestation, byte-compared with the contracts agent's vector (script/attestation-vector.json:
// cast-signed with the PUBLIC test key 0xa11ce, digest cross-checked against the live Resolver's settlementDigest).
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { type Hex, hashDomain, keccak256, recoverTypedDataAddress, stringToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  buildSignedReport,
  bytes4ToStation,
  canonicalSources,
  decodeReport,
  encodeReport,
  SETTLEMENT_TYPEHASH,
  SETTLEMENT_TYPES,
  settlementDigest,
  settlementDomain,
  signDigest,
  sourcesHashOf,
  stationToBytes4,
} from '../report'
import { recoverSigner } from './helpers'

const vectorUrl = new URL('../../../../script/attestation-vector.json', import.meta.url)
const deploymentsUrl = new URL('../../../../deployments/testnet.json', import.meta.url)
const VECTOR_KEY = `0x${'0'.repeat(59)}a11ce` as Hex // public test-only key used for the vector (cast wallet sign)
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

describe('attestation vector (script/attestation-vector.json)', () => {
  const v = JSON.parse(readFileSync(vectorUrl, 'utf8'))
  const m = v.typedData.message
  const body = { station: bytes4ToStation(m.station), date: m.date, tmaxC: m.tmaxC, isVoid: m.isVoid, sourcesHash: m.sourcesHash as Hex, validUntil: BigInt(m.validUntil) }
  const resolver = v.typedData.domain.verifyingContract

  test('typehash and domain separator match the contract', () => {
    const typeString = 'Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash,uint64 validUntil)'
    expect(keccak256(stringToBytes(typeString))).toBe(SETTLEMENT_TYPEHASH)
    expect(SETTLEMENT_TYPEHASH).toBe(v.typehash)
    const ds = hashDomain({ domain: settlementDomain(10143n, resolver), types: { EIP712Domain: v.typedData.types.EIP712Domain } })
    expect(ds).toBe(v.domainSeparator)
  })
  test('digest, signature and full report bytes are identical', () => {
    expect(privateKeyToAccount(VECTOR_KEY).address).toBe(v.signer)
    expect(settlementDigest(10143n, resolver, body)).toBe(v.digest)
    expect(signDigest(VECTOR_KEY, v.digest)).toBe(v.signature)
    const built = buildSignedReport(VECTOR_KEY, 10143n, resolver, body)
    expect(built.payload).toBe(v.report)
    expect(decodeReport(v.report)).toEqual({ ...body, signature: v.signature })
  })
  test('the vector and the live deployment agree on the domain', () => {
    if (!existsSync(deploymentsUrl)) return
    const d = JSON.parse(readFileSync(deploymentsUrl, 'utf8'))
    expect(d.params.settlementTypehash).toBe(SETTLEMENT_TYPEHASH)
    expect(d.params.resolverDomainSeparator).toBe(v.domainSeparator)
    expect(d.resolver).toBe(resolver)
  })
})

describe('encoding rules', () => {
  const key = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as Hex
  const resolver = '0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B' as const
  const body = { station: 'RJTT', date: 20261006, tmaxC: 26, isVoid: false, sourcesHash: keccak256('0x01'), validUntil: 1791400000n }

  test('7 head words + 65-byte signature; viem recovers the attester; signature is low-s with v 27/28', async () => {
    const { payload, signature, digest } = buildSignedReport(key, 10143n, resolver, body)
    expect((payload.length - 2) / 2).toBe(7 * 32 + 32 + 96) // heads + bytes length + 65 bytes padded to 96
    const v = Number.parseInt(signature.slice(-2), 16)
    expect([27, 28]).toContain(v)
    expect(BigInt(`0x${signature.slice(66, 130)}`) <= N / 2n).toBe(true)
    const signer = await recoverTypedDataAddress({ domain: settlementDomain(10143n, resolver), types: SETTLEMENT_TYPES, primaryType: 'Settlement', message: { ...body, station: stationToBytes4('RJTT') }, signature })
    expect(signer).toBe(privateKeyToAccount(key).address)
    expect(recoverSigner(digest, signature)).toBe(signer)
  })
  test('negative temperatures round-trip (int16)', () => {
    const b = { ...body, tmaxC: -12 }
    expect(decodeReport(buildSignedReport(key, 10143n, resolver, b).payload).tmaxC).toBe(-12)
  })
  test('refuses malformed reports', () => {
    const sig = signDigest(key, settlementDigest(10143n, resolver, body))
    expect(() => encodeReport({ ...body, isVoid: true }, sig)).toThrow('VOID')
    expect(() => encodeReport({ ...body, tmaxC: 71 }, sig)).toThrow('range')
    expect(() => encodeReport({ ...body, tmaxC: 25.5 }, sig)).toThrow('integer')
    expect(() => encodeReport(body, '0x1234')).toThrow('65 bytes')
    expect(() => stationToBytes4('rcss')).toThrow()
  })
  test('the domain binds chainId and resolver: a signature for another deployment does not verify here', () => {
    const d1 = settlementDigest(10143n, resolver, body)
    expect(settlementDigest(143n, resolver, body)).not.toBe(d1)
    expect(settlementDigest(10143n, '0x1c7a8a5df93f7f33c778c2163d8887e9249475f1', body)).not.toBe(d1)
    expect(settlementDigest(10143n, resolver, { ...body, validUntil: body.validUntil + 1n })).not.toBe(d1)
  })
})

describe('sourcesHash', () => {
  test('canonical string is stable and documented', () => {
    const s = { tmaxC: 29, nObs: 50, nHours: 24, lastLocal: '23:30', complete: true }
    const c = canonicalSources('RCSS', 20261005, 'SETTLED', [
      { name: 'IEM', stats: s },
      { name: 'AWC', stats: s },
      { name: 'OGIMET', stats: null },
    ])
    expect(c).toBe('isotherm-sources-v1|RCSS|20261005|SETTLED|IEM:29,50,24,23:30,1|AWC:29,50,24,23:30,1|OGIMET:-')
    expect(sourcesHashOf(c)).toBe(keccak256(stringToBytes(c)))
    const empty = { tmaxC: null, nObs: 0, nHours: 0, lastLocal: null, complete: false }
    expect(canonicalSources('RCSS', 20251115, 'VOID', [{ name: 'IEM', stats: empty }])).toBe('isotherm-sources-v1|RCSS|20251115|VOID|IEM:null,0,0,-,0')
  })
})
