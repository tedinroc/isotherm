// viem clients for the Worker. Monad bills the gas LIMIT, so every write estimates and adds a small margin.
// Reads and writes go through the RPC pool in rpc.ts (several endpoints behind a viem fallback transport, a
// client-side throttle, cooldowns and retries); relayer writes are signed and broadcast by sender.ts.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from './env';
import { DEPLOYMENTS } from './deployments';
import { createRpc, type Rpc, type RpcOptions } from './rpc';

export type Pub = PublicClient<Transport, Chain>;
export type Wallet = WalletClient<Transport, Chain, Account>;

export function chainFor(cfg: Config): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 10143 ? 'Monad Testnet' : `chain ${cfg.chainId}`,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrls } },
    contracts: { multicall3: { address: DEPLOYMENTS.multicall3 } },
    testnet: true,
  });
}

export function makeClients(
  cfg: Config,
  relayerKey?: string,
  rpcOverrides: Partial<Omit<RpcOptions, 'urls' | 'chainId'>> = {},
): { pub: Pub; wallet: Wallet | null; rpc: Rpc } {
  const chain = chainFor(cfg);
  // One pool per Durable Object instance: the throttle, cooldowns and verified chain ids are shared by every request.
  const rpc = createRpc({ urls: cfg.rpcUrls, chainId: cfg.chainId, maxRps: cfg.rpcMaxRps, ...rpcOverrides });
  const pub = createPublicClient({ chain, transport: rpc.transport, pollingInterval: 400 }) as Pub;
  let wallet: Wallet | null = null;
  const key = relayerKey?.trim();
  if (key && /^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
    wallet = createWalletClient({ chain, transport: rpc.transport, account }) as Wallet;
  }
  return { pub, wallet, rpc };
}

export const withMargin = (gas: bigint, pct: number) => (gas * BigInt(Math.round(pct)) + 99n) / 100n;
