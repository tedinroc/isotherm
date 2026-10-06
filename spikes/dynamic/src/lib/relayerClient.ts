// Thin fetch client for relayer/server.ts — used by the PWA and the e2e script.
import type { Address, Hex } from 'viem';
import type { AuthorizationWire } from './ausd';

export interface RelayerInfo {
  relayer: Address;
  chainId: number;
  monBalance: string;
  ausdBalance: string;
  signer: 'local-key' | 'dynamic-server-wallet';
  depositTo: Address;
  maxRelayAusd: string;
}
export interface TxResult {
  ok: boolean;
  ausdSource?: string;
  txHash?: Hex;
  txHashes?: Hex[];
  gasUsed?: string;
  gasLimit?: string;
  latencyMs?: number;
  error?: string;
}

async function call<T>(base: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json;
}

export const relayer = (base: string) => ({
  info: () => call<RelayerInfo>(base, '/info'),
  drip: (address: Address) => call<TxResult>(base, '/drip', { address }),
  relay: (auth: AuthorizationWire) => call<TxResult>(base, '/relay', auth),
});
