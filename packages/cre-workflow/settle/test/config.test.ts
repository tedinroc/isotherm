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
  test('config.don.json (DON target) equals config.testnet.json except a gasLimit sized for the production forwarder', () => {
    const read = (n: string) => JSON.parse(readFileSync(new URL(`../${n}`, import.meta.url), 'utf8'))
    const don = configSchema.parse(read('config.don.json'))
    const mac = configSchema.parse(read('config.testnet.json'))
    expect({ ...don, gasLimit: 'x' }).toEqual({ ...mac, gasLimit: 'x' })
    // evidence/don-gas-fork.json: a 278,875-278,887 gas minimum (it varies with the report bytes) through
    // KeystoneForwarder 1.0.0 with 4 DON signatures; rule max(350k, ceil10k(1.5 x 278,887)) = 420k. The DON
    // transmitter pays it, not the attester.
    expect(BigInt(don.gasLimit)).toBeGreaterThanOrEqual(420000n)
    expect(BigInt(don.gasLimit)).toBeLessThanOrEqual(1000000n)
    const ev = new URL('../../evidence/don-gas-fork.json', import.meta.url)
    if (existsSync(ev)) expect(Number(don.gasLimit)).toBeGreaterThanOrEqual(JSON.parse(readFileSync(ev, 'utf8')).recommendedGasLimit)
  })
  test('workflow.yaml: testnet-don deploys to the private registry with config.don.json; testnet keeps the Mac config', () => {
    const wf = Bun.YAML.parse(readFileSync(new URL('../workflow.yaml', import.meta.url), 'utf8')) as any
    const proj = Bun.YAML.parse(readFileSync(new URL('../../project.yaml', import.meta.url), 'utf8')) as any
    expect(wf['testnet-don']['user-workflow']).toEqual({ 'workflow-name': 'isotherm-settle', 'deployment-registry': 'private' })
    expect(wf['testnet-don']['workflow-artifacts']).toEqual({ 'workflow-path': './main.ts', 'config-path': './config.don.json', 'secrets-path': '../secrets.yaml' })
    expect(wf.testnet['workflow-artifacts']['config-path']).toBe('./config.testnet.json')
    expect(wf.testnet['user-workflow']['deployment-registry']).toBeUndefined()
    expect(proj['testnet-don'].rpcs).toEqual(proj.testnet.rpcs)
    // secrets.yaml holds names only (the value goes to the Vault DON from the owner's terminal)
    const secrets = Bun.YAML.parse(readFileSync(new URL('../../secrets.yaml', import.meta.url), 'utf8')) as any
    expect(secrets).toEqual({ secretsNames: { ISOTHERM_ATTESTER_KEY: ['ISOTHERM_ATTESTER_KEY_ALL'] } })
  })
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
