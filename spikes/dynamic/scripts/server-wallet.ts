// ONE-TIME, needs a Dynamic API token (human action). Creates (or loads) the Dynamic
// server wallet used as Isotherm's relayer, signs an AUSD EIP-3009 authorization for
// Monad testnet with it, and checks the signature recovers to the wallet address.
//
//   DYNAMIC_ENVIRONMENT_ID=... DYNAMIC_API_TOKEN=... DYNAMIC_SERVER_WALLET_PASSWORD=... \
//     npx tsx scripts/server-wallet.ts
//
// Writes .secrets/server-wallet.json ({ walletMetadata }) — gitignored. Fund the printed
// address with testnet MON from the faucet, then run the relayer with these env vars.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseUnits, recoverTypedDataAddress } from 'viem';
import { monadTestnet } from 'viem/chains';
import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';
import { authorizationTypedData, newAuthorization } from '../src/lib/ausd';

const env = process.env;
for (const k of ['DYNAMIC_ENVIRONMENT_ID', 'DYNAMIC_API_TOKEN', 'DYNAMIC_SERVER_WALLET_PASSWORD']) {
  if (!env[k]) throw new Error(`${k} not set`);
}
const file = env.DYNAMIC_SERVER_WALLET_FILE ?? '.secrets/server-wallet.json';
const password = env.DYNAMIC_SERVER_WALLET_PASSWORD!;

const client = new DynamicEvmWalletClient({ environmentId: env.DYNAMIC_ENVIRONMENT_ID!, enableMPCAccelerator: false });
await client.authenticateApiToken(env.DYNAMIC_API_TOKEN!);

let walletMetadata;
if (existsSync(file)) {
  walletMetadata = JSON.parse(readFileSync(file, 'utf8')).walletMetadata;
  console.log('loaded existing server wallet', walletMetadata.accountAddress);
} else {
  const t0 = Date.now();
  const res = await client.createWalletAccount({
    thresholdSignatureScheme: 'TWO_OF_TWO' as never,
    password,
    backUpToDynamic: true, // Dynamic keeps the encrypted external share; we only persist metadata
    onError: (e: Error) => console.error('keygen error', e.message),
  });
  walletMetadata = res.walletMetadata;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ walletMetadata }, null, 2), { mode: 0o600 });
  console.log(`created server wallet ${walletMetadata.accountAddress} in ${Date.now() - t0} ms -> ${file}`);
}

const wc = await client.getWalletClient({ walletMetadata, password, chain: monadTestnet, rpcUrl: 'https://testnet-rpc.monad.xyz' });
const auth = newAuthorization({ from: wc.account.address, to: wc.account.address, value: parseUnits('1', 6) });
const typed = authorizationTypedData('transfer', 10143, auth);
const t1 = Date.now();
const signature = await wc.signTypedData({ account: wc.account, ...typed });
const recovered = await recoverTypedDataAddress({ ...typed, signature });
console.log(JSON.stringify({ address: wc.account.address, signMs: Date.now() - t1, recoversToSelf: recovered === wc.account.address }, null, 2));
