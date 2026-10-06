// Unit + handler tests using the official CRE SDK test harness (no CRE login, no WASM).
// Fixtures in ./fixtures are real IEM / aviationweather.gov responses captured by scripts/live-check.ts.
import { describe, expect } from 'bun:test'
import { hexToBase64 } from '@chainlink/cre-sdk'
import { EvmMock, HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { type Hex, bytesToHex, decodeAbiParameters, encodeFunctionResult, hexToString, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { localDayWindow, metarObsTimeMs, parseAwcRaw, parseIemCsv, parseMetarTempC, previousLocalDate } from './metar'
import { REPORT_PARAMS, SETTLEMENT_TYPES } from './report'
import { onCron, RESOLVER_ABI, type Config } from './workflow'

const MONAD_TESTNET = 2183018362218727504n
// Throwaway, publicly-known test key (anvil account #9). Never holds value.
const ATTESTER_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as Hex
const ATTESTER = privateKeyToAccount(ATTESTER_KEY).address
const RESOLVER = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const
const HEADER = 109 // forwarder metadata header length inside rawReport

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const baseConfig = (over: Partial<Config> = {}): Config => ({
  schedule: '0 30 16 * * *',
  chainSelectorName: 'monad-testnet',
  chainId: '10143',
  resolverAddress: RESOLVER,
  readSettled: true,
  gasLimit: '250000',
  iemBaseUrl: 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py',
  awcBaseUrl: 'https://aviationweather.gov/api/data/metar',
  minObs: 40,
  dateOverride: '2026-10-05',
  stations: [{ icao: 'RCSS', tzOffsetMin: 480 }],
  ...over,
})

const runtimeWith = (config: Config) => {
  // getSecret() asks for namespace "main" in SDK 1.23; the test runtime's own default is "default".
  const ns = new Map([['ISOTHERM_ATTESTER_KEY', ATTESTER_KEY]])
  const secrets = new Map([['main', ns], ['default', ns]])
  return newTestRuntime<Config>(secrets, { timeProvider: () => Date.UTC(2026, 9, 5, 16, 30) }, config)
}

const mockHttp = (iem: string, awc: string) => {
  const http = HttpActionsMock.testInstance()
  const seen: string[] = []
  http.sendRequest = (req) => {
    seen.push(req.url)
    const body = req.url.includes('mesonet.agron.iastate.edu') ? iem : awc
    return { statusCode: 200, body: new TextEncoder().encode(body), headers: {} }
  }
  return seen
}

/** resultOf() reply in the capability's JSON form (bytes are base64). */
const resultOfReply = (status: number) => ({
  data: hexToBase64(
    encodeFunctionResult({
      abi: RESOLVER_ABI,
      functionName: 'resultOf',
      result: { status, tmaxC: 0, resolvedAt: 0n, sourcesHash: `0x${'00'.repeat(32)}` },
    }),
  ),
})

const payloadOf = (rawReport: Uint8Array): Hex => `0x${bytesToHex(rawReport).slice(2 + HEADER * 2)}` as Hex

describe('metar parsing', () => {
  test('temperature groups incl. negatives, missing dewpoint, no false positives', () => {
    expect(parseMetarTempC('RCSS 051530Z 11007KT 9999 VCSH FEW010 BKN022 22/22 Q1017')).toBe(22)
    expect(parseMetarTempC('RKSI 150000Z 32010KT CAVOK M05/M12 Q1030')).toBe(-5)
    expect(parseMetarTempC('RJTT 150000Z 32010KT R16R/1200 9999 05/ Q1030')).toBe(5)
    expect(parseMetarTempC('KJFK 150000Z 1/2SM FG Q1030')).toBe(null)
  })
  test('local-day window for UTC+8 and month-boundary ddhhmmZ anchoring', () => {
    const w = localDayWindow('2026-10-01', 480)
    expect(new Date(w.startMs).toISOString()).toBe('2026-09-30T16:00:00.000Z')
    expect(new Date(metarObsTimeMs('METAR RCSS 301630Z 1', w)!).toISOString()).toBe('2026-09-30T16:30:00.000Z')
    expect(new Date(metarObsTimeMs('METAR RCSS 011530Z 1', w)!).toISOString()).toBe('2026-10-01T15:30:00.000Z')
    expect(previousLocalDate(Date.UTC(2026, 9, 5, 16, 30), 480)).toBe('2026-10-05')
    expect(previousLocalDate(Date.UTC(2026, 9, 5, 15, 59), 480)).toBe('2026-10-04')
  })
  test('real fixtures: both sources agree with the Polymarket-resolved highs', () => {
    for (const [ymd, want] of [['2026-10-03', 30], ['2026-10-04', 35], ['2026-10-05', 29]] as const) {
      const w = localDayWindow(ymd, 480)
      expect(parseIemCsv(fx(`iem_RCSS_${ymd}.csv`), 'RCSS', w).tmax).toBe(want)
      expect(parseAwcRaw(fx(`awc_RCSS_${ymd}.txt`), 'RCSS', w).tmax).toBe(want)
    }
  })
})

describe('onCron handler (SDK test runtime)', () => {
  test('happy path: reads resultOf, fetches 2 sources, writes EIP-712-attested report with tight gas', async () => {
    const urls = mockHttp(fx('iem_RCSS_2026-10-05.csv'), fx('awc_RCSS_2026-10-05.txt'))
    const evm = EvmMock.testInstance(MONAD_TESTNET)
    let readCalls = 0
    evm.callContract = () => {
      readCalls++
      return resultOfReply(0)
    }
    let captured: { receiver: Hex; rawReport: Uint8Array; gasLimit: bigint } | undefined
    evm.writeReport = (input) => {
      captured = { receiver: bytesToHex(input.receiver), rawReport: input.report!.rawReport, gasLimit: input.gasConfig!.gasLimit }
      return { txStatus: 2 /* SUCCESS */, txHash: new Uint8Array(32).fill(0xab) }
    }

    const out = JSON.parse(onCron(runtimeWith(baseConfig())))
    expect(readCalls).toBe(1)
    expect(urls.length).toBe(2)
    expect(out[0]).toMatchObject({ station: 'RCSS', date: 20261005, tmaxC: 29, isVoid: false })
    expect(captured!.receiver.toLowerCase()).toBe(RESOLVER.toLowerCase())
    expect(captured!.gasLimit).toBe(250000n)

    const payload = payloadOf(captured!.rawReport)
    const [station, date, tmaxC, isVoid, sourcesHash, attestation] = decodeAbiParameters(REPORT_PARAMS, payload)
    expect([hexToString(station), date, tmaxC, isVoid]).toEqual(['RCSS', 20261005, 29, false])
    const signer = await recoverTypedDataAddress({
      domain: { name: 'Isotherm Resolver', version: '1', chainId: 10143n, verifyingContract: RESOLVER },
      types: SETTLEMENT_TYPES,
      primaryType: 'Settlement',
      message: { station, date, tmaxC, isVoid, sourcesHash },
      signature: attestation,
    })
    expect(signer).toBe(ATTESTER)

    writeFileSync(
      new URL('./fixtures/report_RCSS_2026-10-05.json', import.meta.url),
      JSON.stringify({ resolver: RESOLVER, attester: ATTESTER, chainId: 10143, payload }, null, 2) + '\n',
    )
  })

  test('already resolved -> no HTTP, no write', () => {
    const urls = mockHttp('', '')
    const evm = EvmMock.testInstance(MONAD_TESTNET)
    evm.callContract = () => resultOfReply(1)
    evm.writeReport = () => {
      throw new Error('must not write')
    }
    const out = JSON.parse(onCron(runtimeWith(baseConfig())))
    expect(out[0].skipped).toBe('already-resolved')
    expect(urls.length).toBe(0)
  })

  test('sources disagree -> VOID report (isVoid=true, tmaxC=0)', () => {
    const awcTampered = fx('awc_RCSS_2026-10-05.txt').replace(' 29/', ' 31/')
    mockHttp(fx('iem_RCSS_2026-10-05.csv'), awcTampered)
    const evm = EvmMock.testInstance(MONAD_TESTNET)
    let payload: Hex | undefined
    evm.writeReport = (input) => {
      payload = payloadOf(input.report!.rawReport)
      return { txStatus: 2, txHash: new Uint8Array(32) }
    }
    const out = JSON.parse(onCron(runtimeWith(baseConfig({ readSettled: false }))))
    expect(out[0]).toMatchObject({ isVoid: true, tmaxC: 0 })
    const [, , tmaxC, isVoid] = decodeAbiParameters(REPORT_PARAMS, payload!)
    expect([tmaxC, isVoid]).toEqual([0, true])
  })

  test('thin coverage -> no report (retry next run)', () => {
    const iem = fx('iem_RCSS_2026-10-05.csv').split('\n').slice(0, 20).join('\n')
    mockHttp(iem, fx('awc_RCSS_2026-10-05.txt'))
    const evm = EvmMock.testInstance(MONAD_TESTNET)
    evm.writeReport = () => {
      throw new Error('must not write')
    }
    const out = JSON.parse(onCron(runtimeWith(baseConfig({ readSettled: false }))))
    expect(String(out[0].skipped)).toContain('coverage')
  })
})
