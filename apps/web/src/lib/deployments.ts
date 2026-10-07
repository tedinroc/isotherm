// Normalised view of deployments/testnet.json (copied to src/generated/ at build time by
// scripts/copy-deployments.mjs). The contracts workstream owns the file format, so the lookup is by key name
// rather than by a fixed path: any nested key that names the contract and holds an address is accepted.
import { getAddress, isAddress, type Address } from 'viem';
import raw from "../generated/deployments.json";

export interface Deployments {
  source: string;
  chainId: number;
  resolver: Address;
  vault: Address;
  zap: Address;
  ausd: Address;
  ausdFaucet: Address;
  kuruRouter: Address;
  marginAccount: Address;
  mockForwarder: Address;
  keystoneForwarder: Address;
  multicall3: Address;
  makers: Address[];
  team: Address[];
  deployBlock: bigint | null;
  /** Resolver challenge window in seconds as deployed (`params.challengeWindow`, 900 on v1); null when not recorded. */
  challengeWindow: number | null;
  /** seriesId -> canonical Kuru market, when the deployment file records them. */
  markets: Record<string, Address>;
}

const DEFAULTS = {
  ausd: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
  ausdFaucet: '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C',
  kuruRouter: '0x7EFbE105Ca7415dE98F96622173458ac1c054630',
  marginAccount: '0xd029C2D98ff85D8F64799017fE00a59B1159CE02',
  mockForwarder: '0xB9F79d863261869B234c481D1f9A7af84AeAd192',
  keystoneForwarder: '0xF8344CFd5c43616a4366C34E3EEE75af79a74482',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  resolver: '0x1c7a8a5df93f7f33c778c2163d8887e9249475f1',
  vault: '0xc83fe722eb5bd29a0355c090f14ccb0605153713',
  zap: '0x1b1d91ebd1590c7814aedcae66ac6ded492c792e',
} as const;

type Flat = { path: string; key: string; value: unknown }[];
function flatten(x: unknown, path = '', out: Flat = []): Flat {
  if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      out.push({ path: p, key: k, value: v });
      flatten(v, p, out);
    }
  }
  return out;
}

export function normalizeDeployments(input: unknown): Deployments {
  const flat = flatten(input);
  const addrOf = (v: unknown): Address | null => {
    if (typeof v === 'string' && isAddress(v)) return getAddress(v);
    if (v && typeof v === 'object' && 'address' in (v as object)) {
      const a = (v as { address: unknown }).address;
      if (typeof a === 'string' && isAddress(a)) return getAddress(a);
    }
    return null;
  };
  const pick = (re: RegExp, not?: RegExp): Address | null => {
    for (const f of flat) {
      if (!re.test(f.key) || (not && (not.test(f.key) || not.test(f.path)))) continue;
      const a = addrOf(f.value);
      if (a) return a;
    }
    return null;
  };
  const NOT_IMPL = /impl|implementation|old|previous|legacy|feasibility/i;
  const picked = {
    resolver: pick(/^resolver$|^isothermresolver$/i, NOT_IMPL),
    vault: pick(/^(collateral)?vault$/i, NOT_IMPL),
    zap: pick(/^(isotherm)?zap$/i, NOT_IMPL),
    ausd: pick(/^ausd$|^collateral(token)?$/i),
    ausdFaucet: pick(/faucet/i),
    kuruRouter: pick(/^(kuru)?router$/i),
    marginAccount: pick(/margin/i),
    mockForwarder: pick(/mock.*forwarder/i),
    keystoneForwarder: pick(/^(keystone|prod(uction)?)forwarder$|^keystoneForwarder$/i),
    multicall3: pick(/multicall/i),
  };
  const roleList = (re: RegExp): Address[] => {
    const out: Address[] = [];
    for (const f of flat) {
      if (!re.test(f.key)) continue;
      const vals = Array.isArray(f.value) ? f.value : [f.value];
      for (const v of vals) {
        const a = addrOf(v);
        if (a && !out.includes(a)) out.push(a);
      }
    }
    return out;
  };
  const makers = roleList(/^maker(s|address|Address)?$/i);
  const team = roleList(/^(deployer|operator|taker\d*|owner|guardian|attester|relayer)$/i).filter((a) => !makers.includes(a));
  let deployBlock: bigint | null = null;
  for (const f of flat) {
    if (/^(deploy(ment)?block|startblock|fromblock|blocknumber)$/i.test(f.key)) {
      const n = typeof f.value === 'number' || typeof f.value === 'string' ? Number(f.value) : NaN;
      if (Number.isFinite(n) && n > 0) {
        deployBlock = deployBlock === null || BigInt(n) < deployBlock ? BigInt(n) : deployBlock;
      }
    }
  }
  let challengeWindow: number | null = null;
  for (const f of flat) {
    // exact key only: `maxChallengeWindow` is the resolver's upper bound, not the deployed value
    if (/^challengeWindow(Seconds)?$/i.test(f.key) && challengeWindow === null) {
      const n = typeof f.value === 'number' || typeof f.value === 'string' ? Number(f.value) : NaN;
      if (Number.isFinite(n) && n >= 0) challengeWindow = n;
    }
  }
  const markets: Record<string, Address> = {};
  for (const f of flat) {
    // e.g. { markets: { "0x<seriesId>": "0x<market>" } } or [{ seriesId, market }]
    if (/^markets?$/i.test(f.key) && f.value && typeof f.value === 'object') {
      for (const [k, v] of Object.entries(f.value as Record<string, unknown>)) {
        if (/^0x[0-9a-fA-F]{64}$/.test(k)) {
          const a = addrOf(v);
          if (a) markets[k.toLowerCase()] = a;
        } else if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          const id = typeof o.seriesId === 'string' ? o.seriesId : null;
          const a = addrOf(o.market);
          if (id && a) markets[id.toLowerCase()] = a;
        }
      }
    }
  }
  const obj = (input ?? {}) as Record<string, unknown>;
  return {
    source: typeof obj.source === 'string' ? obj.source : 'unknown',
    chainId: typeof obj.chainId === 'number' ? obj.chainId : 10143,
    resolver: picked.resolver ?? getAddress(DEFAULTS.resolver),
    vault: picked.vault ?? getAddress(DEFAULTS.vault),
    zap: picked.zap ?? getAddress(DEFAULTS.zap),
    ausd: picked.ausd ?? getAddress(DEFAULTS.ausd),
    ausdFaucet: picked.ausdFaucet ?? getAddress(DEFAULTS.ausdFaucet),
    kuruRouter: picked.kuruRouter ?? getAddress(DEFAULTS.kuruRouter),
    marginAccount: picked.marginAccount ?? getAddress(DEFAULTS.marginAccount),
    mockForwarder: picked.mockForwarder ?? getAddress(DEFAULTS.mockForwarder),
    keystoneForwarder: picked.keystoneForwarder ?? getAddress(DEFAULTS.keystoneForwarder),
    multicall3: picked.multicall3 ?? getAddress(DEFAULTS.multicall3),
    makers,
    team,
    deployBlock,
    challengeWindow,
    markets,
  };
}

export const DEPLOYMENTS: Deployments = normalizeDeployments(raw);
