// Relayer signer: either a local hex key file (works today, no account needed) or a
// Dynamic server wallet (MPC, needs a Dynamic API token + the dashboard steps in RESULT.md).
// Both return a viem WalletClient, so relayer/core.ts does not care which one is used.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export type SignerKind = 'local-key' | 'dynamic-server-wallet';

const expand = (p: string) => (p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p);

/** Reads a 0x-hex (or bare hex) private key from a file without ever logging it. */
export function readKeyFile(path: string): Hex {
  const raw = readFileSync(expand(path), 'utf8').trim();
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`key file ${path} is not a 32-byte hex key`);
  return hex;
}

export function localKeySigner(keyFile: string, chain: Chain, rpcUrl: string): WalletClient<Transport, Chain, Account> {
  const account = privateKeyToAccount(readKeyFile(keyFile));
  return createWalletClient({ account, chain, transport: http(rpcUrl) });
}

export async function dynamicServerWalletSigner(opts: {
  environmentId: string;
  apiToken: string;
  walletFile: string;
  password?: string;
  chain: Chain;
  rpcUrl: string;
}): Promise<WalletClient<Transport, Chain, Account>> {
  // Optional dependency: native MPC addon, Node 18+ on Linux x64/arm64 or macOS arm64 only
  // (NOT Cloudflare Workers / Pages Functions).
  const { DynamicEvmWalletClient } = await import('@dynamic-labs-wallet/node-evm');
  const client = new DynamicEvmWalletClient({ environmentId: opts.environmentId, enableMPCAccelerator: false });
  await client.authenticateApiToken(opts.apiToken);
  const { walletMetadata } = JSON.parse(readFileSync(expand(opts.walletFile), 'utf8'));
  return client.getWalletClient({
    walletMetadata,
    password: opts.password,
    chain: opts.chain,
    rpcUrl: opts.rpcUrl,
  });
}

export async function signerFromEnv(chain: Chain, rpcUrl: string): Promise<{
  walletClient: WalletClient<Transport, Chain, Account>;
  kind: SignerKind;
}> {
  const e = process.env;
  if (e.DYNAMIC_API_TOKEN && e.DYNAMIC_ENVIRONMENT_ID) {
    const walletClient = await dynamicServerWalletSigner({
      environmentId: e.DYNAMIC_ENVIRONMENT_ID,
      apiToken: e.DYNAMIC_API_TOKEN,
      walletFile: e.DYNAMIC_SERVER_WALLET_FILE ?? '.secrets/server-wallet.json',
      password: e.DYNAMIC_SERVER_WALLET_PASSWORD,
      chain,
      rpcUrl,
    });
    return { walletClient, kind: 'dynamic-server-wallet' };
  }
  if (e.RELAYER_KEY_FILE) return { walletClient: localKeySigner(e.RELAYER_KEY_FILE, chain, rpcUrl), kind: 'local-key' };
  throw new Error('set RELAYER_KEY_FILE or DYNAMIC_API_TOKEN + DYNAMIC_ENVIRONMENT_ID');
}
