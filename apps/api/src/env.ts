// Worker bindings, vars and secrets, plus the parsed runtime config.
import { getAddress, isAddress, parseEther, parseUnits, type Address } from 'viem';
import { DEPLOYMENTS } from './deployments';
import { chooseRpcUrls, isLoopbackUrl } from './rpc';

export interface Env {
  ISO_KV: KVNamespace;
  RELAYER: DurableObjectNamespace;
  /** wrangler.toml [version_metadata]: this Worker version's id and upload (deploy) time, shown in /api/health. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  // vars (wrangler.toml [vars]); all optional, defaults below
  /** One endpoint only (an anvil fork for wrangler dev / the fork test). Wins over RPC_URLS; unset in production. */
  RPC_URL?: string;
  /** Comma list of Monad testnet endpoints, tried in order (default: Ankr, thirdweb, official). See src/rpc.ts. */
  RPC_URLS?: string;
  /** Client-side throttle per endpoint, requests per second (default 8; the official RPC allows 15 per client IP). */
  RPC_MAX_RPS?: string;
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
  RELAY_MIN_AUSD?: string;
  RELAY_PER_ADDRESS_PER_DAY?: string;
  RELAY_PER_IP_PER_DAY?: string;
  RELAY_DAILY_CAP?: string;
  RELAY_ALLOW_PERMIT?: string;
  DRIP_GAS_MON?: string;
  RELAY_COST_MON?: string;
  GAS_MULTIPLIER_PCT?: string;
  POST_LIMIT_PER_MIN?: string;
  MAKER_ADDRESSES?: string;
  TEAM_ADDRESSES?: string;
  STATS_START_BLOCK?: string;
  STATS_SCAN_MAX_WINDOWS?: string;
  /** Blocks the log scan stays behind the head (default 5 on public RPCs, 0 on a loopback fork). */
  STATS_SCAN_LAG_BLOCKS?: string;
  REAL_STATIONS?: string;
  // secrets (wrangler secret put …)
  RELAYER_KEY?: string;
  SNAPSHOT_TOKEN?: string;
  ADMIN_TOKEN?: string;
}

export interface Config {
  /** RPC endpoints in fallback order (RPC_URL, else RPC_URLS, else the defaults in src/rpc.ts). */
  rpcUrls: string[];
  /** RPC_URL / RPC_URLS entries that were not valid URLs (reported by position in /api/health, never in full). */
  rpcIgnored: string[];
  rpcSource: 'RPC_URL' | 'RPC_URLS' | 'default';
  rpcMaxRps: number;
  chainId: number;
  allowedOrigins: string[];
  dripEnabled: boolean;
  dripMon: bigint;
  dripAusd: bigint;
  dripDailyCap: number;
  dripPerIpPerDay: number;
  dripAddressCooldownMs: number;
  /** Reserve: drips and relays never take the relayer's MON below this (the cron refill may use it). */
  relayerMinMon: bigint;
  ausdFloatTarget: bigint;
  relayEnabled: boolean;
  relayMinAusd: bigint;
  relayMaxAusd: bigint;
  relayPerAddressPerDay: number;
  relayPerIpPerDay: number;
  relayDailyCap: number;
  /** EIP-2612 permit relays can be redirected to another series by a front-runner (security review v1, N10), so they
   *  are offered only for a vault WITHOUT mintSetWithAuthorization and only when this is set. */
  relayAllowPermit: boolean;
  /** Worst-case MON one drip costs in gas (MON leg 21,000 + AUSD leg ~78,752 gas at ~102 gwei, billed on the limit). */
  dripGasMon: bigint;
  /** Worst-case MON one relayed mint costs (gas limit x price; Monad bills the limit; fork: 334,228 gas x 102 gwei). */
  relayCostMon: bigint;
  gasMultiplierPct: number;
  /** POST /api/drip + /api/relay/mint requests per client network per minute (any outcome). */
  postLimitPerMin: number;
  makerAddresses: Address[];
  teamAddresses: Address[];
  statsStartBlock: bigint | null;
  statsScanMaxWindows: number;
  /** The scan reads logs only up to head - this many blocks: a lagging endpoint returns a truncated, error-free
   *  eth_getLogs result for blocks it has not seen, and load-balanced endpoints differ by a block or two. */
  statsScanLagBlocks: bigint;
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
  const rpc = chooseRpcUrls(env);
  const lag = num(env.STATS_SCAN_LAG_BLOCKS, rpc.urls.every(isLoopbackUrl) ? 0 : 5);
  return {
    rpcUrls: rpc.urls,
    rpcIgnored: rpc.ignored,
    rpcSource: rpc.source,
    rpcMaxRps: Math.max(0, num(env.RPC_MAX_RPS, 8)),
    chainId: num(env.CHAIN_ID, 10143),
    allowedOrigins: env.ALLOWED_ORIGINS ? list(env.ALLOWED_ORIGINS) : DEFAULT_ORIGINS,
    dripEnabled: (env.DRIP_ENABLED ?? '1') === '1',
    dripMon: parseEther(env.DRIP_MON || '0.15'),
    dripAusd: parseUnits(env.DRIP_AUSD || '1000', 6),
    // Conservative defaults (sized for a relayer holding about 0.6 MON); wrangler.toml sets the live values.
    dripDailyCap: num(env.DRIP_DAILY_CAP, 2),
    dripPerIpPerDay: num(env.DRIP_PER_IP_PER_DAY, 1),
    dripAddressCooldownMs: num(env.DRIP_ADDRESS_COOLDOWN_H, 24) * 3600_000,
    relayerMinMon: parseEther(env.RELAYER_MIN_MON || '0.1'),
    ausdFloatTarget: parseUnits(env.AUSD_FLOAT_TARGET || '50000', 6),
    relayEnabled: (env.RELAY_ENABLED ?? '1') === '1',
    relayMinAusd: parseUnits(env.RELAY_MIN_AUSD || '1', 6),
    relayMaxAusd: parseUnits(env.RELAY_MAX_AUSD || '500', 6),
    relayPerAddressPerDay: num(env.RELAY_PER_ADDRESS_PER_DAY, 2),
    relayPerIpPerDay: num(env.RELAY_PER_IP_PER_DAY, 2),
    relayDailyCap: num(env.RELAY_DAILY_CAP, 5),
    relayAllowPermit: env.RELAY_ALLOW_PERMIT === '1',
    dripGasMon: parseEther(env.DRIP_GAS_MON || '0.011'),
    relayCostMon: parseEther(env.RELAY_COST_MON || '0.035'),
    gasMultiplierPct: num(env.GAS_MULTIPLIER_PCT, 108),
    postLimitPerMin: num(env.POST_LIMIT_PER_MIN, 30),
    makerAddresses: makers,
    teamAddresses: team,
    statsStartBlock: env.STATS_START_BLOCK ? BigInt(env.STATS_START_BLOCK) : DEPLOYMENTS.deployBlock,
    statsScanMaxWindows: num(env.STATS_SCAN_MAX_WINDOWS, 30),
    statsScanLagBlocks: BigInt(Math.max(0, Math.min(1000, Math.floor(lag)))),
    realStations: env.REAL_STATIONS ? list(env.REAL_STATIONS) : ['RCSS', 'RJTT', 'ZGSZ', 'RKSI', 'VHHH'],
  };
}
