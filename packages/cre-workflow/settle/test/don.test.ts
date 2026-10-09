// Offline checks for the DON cutover tooling (scripts/don-*.sh, e2e/don-*.ts): the cutover time window, the
// production report header the fork rehearsal builds, DON signatures, and the gas sizing rule. No RPC, no keys.
import { describe, expect, test } from 'bun:test'
import { type Hex, concat, keccak256, recoverAddress, slice, stringToBytes } from 'viem'
import { simulatorHeader } from '../e2e/chain'
import { windowCheck } from '../e2e/don-ops'
import { addressOf, donSign, forkSignerKeys, productionHeader, recommendGasLimit, reportContextFor, workflowNameField } from '../e2e/don-sim'

const at = (hhmm: string) => Date.parse(`2026-10-10T${hhmm}:00Z`) / 1000

describe('cutover time window (UTC)', () => {
  test('refuses the Mac job (:05), the 02:00-local crons (:00) and the DON hourly run (:30)', () => {
    for (const t of ['09:55', '09:59', '10:00', '10:05', '10:10', '10:25', '10:30', '10:35']) expect(windowCheck(at(t)).ok).toBe(false)
    for (const t of ['10:11', '10:24', '10:36', '10:40', '10:54']) expect(windowCheck(at(t)).ok).toBe(true)
  })
  test('refuses 16:45-18:15, the daily first attempts (RJTT 17:00Z, RCSS 18:00Z)', () => {
    for (const t of ['16:45', '17:00', '17:40', '18:00', '18:15']) expect(windowCheck(at(t)).ok).toBe(false)
    for (const t of ['16:40', '16:44', '18:16', '18:40']) expect(windowCheck(at(t)).ok).toBe(true)
  })
})

describe('production report header (fork rehearsal)', () => {
  const owner = '0x93CF74f0Cb2dF7A43a8BB8ff1445fc622bEaf4F9' as const
  const id = keccak256(stringToBytes('workflow id'))
  const raw = productionHeader({ executionId: keccak256(stringToBytes('exec')), timestamp: 1791576030, donId: 1, configVersion: 1, workflowId: id, workflowName: 'isotherm-settle', workflowOwner: owner })

  test('is 109 bytes, and the forwarder metadata rawReport[45:109] carries the id and owner where Resolver._checkWorkflowMetadata reads them', () => {
    expect((raw.length - 2) / 2).toBe(109)
    const metadata = slice(raw, 45, 109)
    expect(slice(metadata, 0, 32)).toBe(id) // metadata[0:32]
    expect(slice(metadata, 42, 62).toLowerCase()).toBe(owner.toLowerCase()) // metadata[42:62]
    expect(slice(raw, 107, 109)).toBe('0x0000') // reportId of the live DON reports
  })
  test('encodes the workflow name the same way as the CRE simulator header', () => {
    expect(workflowNameField('isotherm-settle')).toBe(slice(simulatorHeader(`0x${'00'.repeat(32)}` as Hex), 77, 87))
    expect(slice(raw, 77, 87)).toBe(workflowNameField('isotherm-settle'))
  })
  test('DON signatures recover to the configured signers over keccak256(keccak256(rawReport) || reportContext)', async () => {
    const ctx = reportContextFor('unit')
    expect((ctx.length - 2) / 2).toBe(96)
    const keys = forkSignerKeys(4, 'unit')
    const sigs = donSign(raw, ctx, keys)
    const digest = keccak256(concat([keccak256(raw), ctx]))
    for (let i = 0; i < keys.length; i++) {
      const v = Number.parseInt(sigs[i].slice(-2), 16)
      expect([0, 1]).toContain(v) // the forwarder adds 27
      const sig = `${sigs[i].slice(0, -2)}${(v + 27).toString(16)}` as Hex
      expect(await recoverAddress({ hash: digest, signature: sig })).toBe(addressOf(keys[i]))
    }
  })
})

describe('gas sizing rule for the DON target', () => {
  test('max(350k, ceil10k(1.5 x minimum))', () => {
    expect(recommendGasLimit(278_887)).toBe(420_000) // evidence/don-gas-fork.json
    expect(recommendGasLimit(312_814)).toBe(470_000) // 6 signatures
    expect(recommendGasLimit(150_000)).toBe(350_000) // floor
  })
})
