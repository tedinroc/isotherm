// Minimal HTTP wrapper around relayer/core.ts (node:http, no framework).
//   GET  /info   relayer address, balances, signer kind
//   POST /drip   { address }                 -> faucet AUSD + MON top-up (testnet only)
//   POST /relay  AuthorizationWire (ausd.ts) -> submits EIP-3009 for the user
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http, parseEther, parseUnits, type Address, type Chain } from 'viem';
import { monadTestnet } from 'viem/chains';
import { createRelayerCore, PolicyError, type RelayerCore } from './core';
import { signerFromEnv } from './signer';

async function readJson(req: IncomingMessage, limit = 16_384): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new PolicyError('body too large');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new PolicyError('bad json');
  }
}

export function startServer(core: RelayerCore, port: number, corsOrigin = '*'): Promise<Server> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': corsOrigin,
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'OPTIONS') return send(204, {});
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'GET' && path === '/info') return send(200, await core.info());
      if (req.method === 'POST' && path === '/drip') {
        const { address } = (await readJson(req)) as { address?: string };
        return send(200, await core.drip(address ?? ''));
      }
      if (req.method === 'POST' && path === '/relay') return send(200, await core.relay((await readJson(req)) as never));
      return send(404, { error: 'not found' });
    } catch (e) {
      const status = e instanceof PolicyError ? e.status : 500;
      const msg = (e as Error).message.split('\n')[0];
      if (status === 500) console.error('[relayer]', msg);
      send(status, { ok: false, error: msg });
    }
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server)));
}

export async function coreFromEnv(chain: Chain = monadTestnet) {
  const e = process.env;
  const rpcUrl = e.RELAYER_RPC_URL ?? 'https://testnet-rpc.monad.xyz';
  const chainId = Number(e.RELAYER_CHAIN_ID ?? chain.id);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const { walletClient, kind } = await signerFromEnv(chain, rpcUrl);
  const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => getAddress(x)) as Address[];
  const depositTo = (e.RELAY_DEPOSIT_TO ? getAddress(e.RELAY_DEPOSIT_TO) : walletClient.account.address) as Address;
  return createRelayerCore({
    publicClient,
    walletClient,
    signerKind: kind,
    chainId,
    depositTo,
    allowedTransferTo: [depositTo, ...list(e.RELAY_ALLOWED_TO)],
    allowedReceivers: list(e.RELAY_ALLOWED_RECEIVERS),
    maxRelayValue: parseUnits(e.RELAY_MAX_AUSD ?? '1000', 6),
    maxTtlSeconds: Number(e.RELAY_MAX_TTL ?? 3600),
    dripMon: parseEther(e.DRIP_MON ?? '0.2'),
    dripAusd: parseUnits(e.DRIP_AUSD ?? '1000', 6),
    dripAusdFaucet: (e.DRIP_USE_AUSD_FAUCET ?? '1') === '1',
    dripCooldownMs: Number(e.DRIP_COOLDOWN_MS ?? 24 * 3600 * 1000),
    gasMarginPct: Number(e.GAS_MARGIN_PCT ?? 15),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const core = await coreFromEnv();
  const port = Number(process.env.RELAYER_PORT ?? 8790);
  await startServer(core, port, process.env.CORS_ORIGIN ?? '*');
  const i = await core.info();
  console.log(`[relayer] ${i.signer} ${i.relayer} on :${port} chain ${i.chainId} MON=${i.monBalance} AUSD=${i.ausdBalance}`);
  // Keep an AUSD float so drips do not depend on the faucet's global 60 s cooldown.
  const floatTarget = Number(process.env.DRIP_AUSD ?? '1000') * 5;
  setInterval(async () => {
    const { ausdBalance } = await core.info().catch(() => ({ ausdBalance: '0' }));
    if (Number(ausdBalance) < floatTarget) await core.refill().catch((e) => console.warn('[relayer] refill:', (e as Error).message));
  }, 5 * 60_000);
}
