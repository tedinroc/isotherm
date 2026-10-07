// Config <-> deployments/testnet.json (single source of truth) <-> packages/abi.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { toFunctionSelector, toFunctionSignature } from 'viem'
import { RESOLVER_ABI, VAULT_ABI } from '../abi'
import { configSchema } from '../config'
import { testnetConfig } from './helpers'

const root = new URL('../../../../', import.meta.url)
const deployments = JSON.parse(readFileSync(new URL('deployments/testnet.json', root), 'utf8'))

describe('config files', () => {
  for (const name of ['config.testnet.json', 'config.anvil.json']) {
    test(`${name} points at the live v1 deployment`, () => {
      const c = configSchema.parse(JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')))
      expect(c.chainId).toBe(String(deployments.chainId))
      expect(c.resolverAddress).toBe(deployments.resolver)
      expect(c.vaultAddress).toBe(deployments.vault)
      expect(c.staleWindowSec).toBe(deployments.params.staleWindow)
      expect(c.voidAfterSec + c.attestationTtlSec).toBeLessThan(deployments.params.staleWindow)
      expect(c.hardVoidAfterSec + c.attestationTtlSec).toBeLessThan(deployments.params.staleWindow)
      expect(c.voidAfterSec).toBe(36 * 3600)
      expect(BigInt(c.gasLimit)).toBeGreaterThanOrEqual(170000n) // ~150k used on the fork
      expect(BigInt(c.gasLimit)).toBeLessThanOrEqual(220000n) // Monad bills the limit
      for (const s of c.stations) {
        const d = deployments.stations[s.icao]
        expect(d).toBeDefined()
        expect(s.utcOffsetMin * 60).toBe(d.utcOffsetSeconds) // Resolver.registerStation offset
        expect(s.tzName).toBe(d.tz)
      }
      expect(c.extraTargets).toEqual([])
    })
  }
  test('rejects a void deadline at or beyond the on-chain STALE_WINDOW', () => {
    expect(() => testnetConfig({ voidAfterSec: 171300, hardVoidAfterSec: 171300 })).toThrow('staleWindowSec') // 171300 + 1500 >= 172800
    expect(testnetConfig({ voidAfterSec: 171000, hardVoidAfterSec: 171000 }).voidAfterSec).toBe(171000) // 171000 + 1500 < 172800
    expect(() => testnetConfig({ hardVoidAfterSec: 129000 })).toThrow('hardVoidAfterSec') // backstop before the deadline
    expect(() => testnetConfig({ hardVoidAfterSec: 171400 })).toThrow('hardVoidAfterSec') // backstop + TTL past the stale window
    expect(() => testnetConfig({ attestationTtlSec: 3600 })).toThrow()
    expect(() => testnetConfig({ stations: [{ icao: 'RCSS', utcOffsetMin: 480, tzName: 'Asia/Taipei' }, { icao: 'RCSS', utcOffsetMin: 480, tzName: 'Asia/Taipei' }] })).toThrow('duplicate')
  })
})

describe('ABI fragments match packages/abi (exported from forge out by the contracts agent)', () => {
  const abiFile = (n: string) => JSON.parse(readFileSync(new URL(`packages/abi/${n}.json`, root), 'utf8')) as any[]
  const check = (mine: readonly any[], theirs: any[]) => {
    for (const f of mine) {
      const t = theirs.find((x) => x.type === 'function' && x.name === f.name)
      expect(t).toBeDefined()
      expect(toFunctionSelector(toFunctionSignature(t))).toBe(toFunctionSelector(toFunctionSignature(f)))
      expect(JSON.stringify(t.outputs.map(strip))).toBe(JSON.stringify(f.outputs.map(strip)))
    }
  }
  const strip = (o: any): any => ({ type: o.type, ...(o.components ? { components: o.components.map(strip) } : {}) })
  test('Resolver', () => check(RESOLVER_ABI, abiFile('Resolver')))
  test('CollateralVault', () => check(VAULT_ABI, abiFile('CollateralVault')))
  test('addresses.json agrees', () => {
    if (!existsSync(new URL('packages/abi/addresses.json', root))) return
    const a = JSON.parse(readFileSync(new URL('packages/abi/addresses.json', root), 'utf8'))
    expect([a.resolver, a.vault, a.mockForwarder]).toEqual([deployments.resolver, deployments.vault, deployments.mockForwarder])
  })
})
