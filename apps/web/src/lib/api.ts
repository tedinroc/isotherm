// Client for apps/api (Cloudflare Worker). All money-moving decisions are re-checked on-chain by the app; the API
// only supplies test funds, relays signed authorizations and serves the maker snapshot and public stats.
import type { Address, Hex } from 'viem';
import { API_URL } from '../config';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = 60_000): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ApiError(0, `API unreachable (${(e as Error).message})`);
  }
  const body = (await r.json().catch(() => ({}))) as { error?: string; retryAfterSec?: number };
  if (!r.ok) throw new ApiError(r.status, body.error ?? `HTTP ${r.status}`, body.retryAfterSec);
  return body as T;
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export interface Health {
  relayer: Address | null;
  dripEnabled: boolean;
  dripReady: boolean;
  dripMon: string;
  dripAusd: string;
  relayEnabled: boolean;
  relayModes: string[];
  monBalance: string | null;
  ausdFloat: string | null;
  deployments: string;
}

export interface DripResult {
  ok: boolean;
  alreadyFunded?: boolean;
  monSent?: string;
  ausdSent?: string;
  ausdPending?: boolean;
  retryAfterSec?: number;
  txHashes: Hex[];
  latencyMs: number;
}

export interface SnapshotStrike {
  k: number;
  seriesId: string | null;
  market: Address | null;
  fair: number | null;
  pmImplied: number | null;
  model: number | null;
  bid: number | null;
  ask: number | null;
  flags: string[];
  mode?: string | null;
  reason?: string | null;
  divergence?: number | null;
}
export interface SnapshotLadder {
  station: string;
  city: string | null;
  date: number;
  closeTime: number | null;
  observedMaxC: number | null;
  observedAt: string | null;
  polymarketUrl: string | null;
  polymarketVolume: number | null;
  forecastMu: number | null;
  status?: string | null;
  strikes: SnapshotStrike[];
}
export interface Snapshot {
  generatedAt?: string;
  receivedAt?: string;
  empty?: boolean;
  rpcKind?: string | null;
  ladders: SnapshotLadder[];
}

export interface Stats {
  empty?: boolean;
  nonMakerWallets?: number;
  nonMakerFills?: number;
  fills?: number;
  settledCityDays?: number;
  voidCityDays?: number;
  drips?: number;
  relayedMints?: number;
  updatedAt?: string;
  lagBlocks?: number;
  maker?: Record<string, unknown> | null;
}

export interface SettlementRow {
  station: string;
  date: number;
  status: number;
  tmaxC: number;
  sourcesHash: Hex;
  caller: Address;
  tx: Hex;
  block: string;
  finalAt?: number;
}

export const api = {
  health: () => call<Health>('/api/health', undefined, 15_000),
  drip: (address: Address) => post<DripResult>('/api/drip', { address }),
  relayMint: (body: Record<string, unknown>) => post<{ ok: boolean; txHash: Hex; latencyMs: number }>('/api/relay/mint', body),
  snapshot: () => call<Snapshot>('/api/snapshot', undefined, 15_000),
  stats: () => call<Stats>('/api/stats', undefined, 15_000),
  settlements: () => call<{ settlements: SettlementRow[] }>('/api/settlements', undefined, 15_000),
};
