// Worker bindings, vars and secrets, plus the parsed runtime config.
import { getAddress, isAddress, parseEther, parseUnits, type Address } from 'viem';
import { DEPLOYMENTS } from './deployments';

export interface Env {
  ISO_KV: KVNamespace;
  RELAYER: DurableObjectNamespace;
  // vars (wrangler.toml [vars]); all optional, defaults below
  RPC_URL?: string;
  CHAIN_ID?: string;
  ALLOWED_ORIGINS?: string;
  DRIP_ENABLED?: string;
  DRIP_MON?: string;
  DRIP_AUSD?: string;
  DRIP_DAILY_CAP?: string;
  DRIP_PER_IP_PER_DAY?: string;
  DRIP_ADDRESS_COOLDOWN_H?: string;
  RELAYER_MIN_MON?: string;
  AUSD_FLOAT_TARGET?: string;
  RELAY_ENABLED?: string;
  RELAY_MAX_AUSD?: string;
  RELAY_PER_ADDRESS_PER_DAY?: string;
  RELAY_DAILY_CAP?: string;
  GAS_MULTIPLIER_PCT?: string;
  MAKER_ADDRESSES?: string;
  TEAM_ADDRESSES?: string;
  STATS_START_BLOCK?: string;
  STATS_SCAN_MAX_WINDOWS?: string;
  REAL_STATIONS?: string;
  // secrets (wrangler secret put …)
  RELAYER_KEY?: string;
  SNAPSHOT_TOKEN?: string;
  ADMIN_TOKEN?: string;
}

export interface Config {
  rpcUrl: string;
  chainId: number;
  allowedOrigins: string[];
  dripEnabled: boolean;
  dripMon: bigint;
  dripAusd: bigint;
  dripDailyCap: number;
  dripPerIpPerDay: number;
  dripAddressCooldownMs: number;
  relayerMinMon: bigint;
  ausdFloatTarget: bigint;
  relayEnabled: boolean;
  relayMaxAusd: bigint;
  relayPerAddressPerDay: number;
  relayDailyCap: number;
  gasMultiplierPct: number;
  makerAddresses: Address[];
  teamAddresses: Address[];
  statsStartBlock: bigint | null;
  statsScanMaxWindows: number;
  realStations: string[];
}

const DEFAULT_ORIGINS = [
  'https://isotherm.pages.dev',
  'https://*.isotherm.pages.dev',
  'http://localhost:*',
  'http://127.0.0.1:*',
];

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const list = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const addrList = (v?: string) => list(v).filter((x) => isAddress(x)).map((x) => getAddress(x));

export function configFrom(env: Env): Config {
  const makers = addrList(env.MAKER_ADDRESSES);
  for (const m of DEPLOYMENTS.makers) if (!makers.includes(m)) makers.push(m);
  const team = addrList(env.TEAM_ADDRESSES);
  for (const t of DEPLOYMENTS.team) if (!team.includes(t) && !makers.includes(t)) team.push(t);
  return {
    rpcUrl: env.RPC_URL || 'https://testnet-rpc.monad.xyz',
    chainId: num(env.CHAIN_ID, 10143),
    allowedOrigins: env.ALLOWED_ORIGINS ? list(env.ALLOWED_ORIGINS) : DEFAULT_ORIGINS,
    dripEnabled: (env.DRIP_ENABLED ?? '1') === '1',
    dripMon: parseEther(env.DRIP_MON || '0.15'),
    dripAusd: parseUnits(env.DRIP_AUSD || '1000', 6),
    dripDailyCap: num(env.DRIP_DAILY_CAP, 150),
    dripPerIpPerDay: num(env.DRIP_PER_IP_PER_DAY, 3),
    dripAddressCooldownMs: num(env.DRIP_ADDRESS_COOLDOWN_H, 24) * 3600_000,
    relayerMinMon: parseEther(env.RELAYER_MIN_MON || '0.3'),
    ausdFloatTarget: parseUnits(env.AUSD_FLOAT_TARGET || '50000', 6),
    relayEnabled: (env.RELAY_ENABLED ?? '1') === '1',
    relayMaxAusd: parseUnits(env.RELAY_MAX_AUSD || '500', 6),
    relayPerAddressPerDay: num(env.RELAY_PER_ADDRESS_PER_DAY, 20),
    relayDailyCap: num(env.RELAY_DAILY_CAP, 400),
    gasMultiplierPct: num(env.GAS_MULTIPLIER_PCT, 108),
    makerAddresses: makers,
    teamAddresses: team,
    statsStartBlock: env.STATS_START_BLOCK ? BigInt(env.STATS_START_BLOCK) : DEPLOYMENTS.deployBlock,
    statsScanMaxWindows: num(env.STATS_SCAN_MAX_WINDOWS, 30),
    realStations: env.REAL_STATIONS ? list(env.REAL_STATIONS) : ['RCSS', 'RJTT', 'ZGSZ', 'RKSI', 'VHHH'],
  };
}
