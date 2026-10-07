// viem clients for the Worker. Monad bills the gas LIMIT, so every write estimates and adds a small margin.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
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

export type Pub = PublicClient<Transport, Chain>;
export type Wallet = WalletClient<Transport, Chain, Account>;

export function chainFor(cfg: Config): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 10143 ? 'Monad Testnet' : `chain ${cfg.chainId}`,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    contracts: { multicall3: { address: DEPLOYMENTS.multicall3 } },
    testnet: true,
  });
}

export function makeClients(cfg: Config, relayerKey?: string): { pub: Pub; wallet: Wallet | null } {
  const chain = chainFor(cfg);
  const transport = http(cfg.rpcUrl, { retryCount: 2, retryDelay: 300, timeout: 20_000 });
  const pub = createPublicClient({ chain, transport, pollingInterval: 300 }) as Pub;
  let wallet: Wallet | null = null;
  const key = relayerKey?.trim();
  if (key && /^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
    wallet = createWalletClient({ chain, transport, account }) as Wallet;
  }
  return { pub, wallet };
}

export const withMargin = (gas: bigint, pct: number) => (gas * BigInt(Math.round(pct)) + 99n) / 100n;
