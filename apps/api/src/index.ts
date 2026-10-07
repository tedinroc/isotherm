// Isotherm API (Cloudflare Worker, Monad testnet 10143).
//
//   GET  /api/health                 relayer address/balances, drip + relay config, deployment source
//   POST /api/drip {address}         small MON + test AUSD for a new wallet (rate-limited; never to contracts)
//   POST /api/relay/mint {...}       relays a signed EIP-3009 authorization (or EIP-2612 permit) to the vault
//   GET  /api/snapshot               the maker's latest ladder snapshot (fair value, Polymarket-implied, obs max)
//   POST /api/snapshot               (Bearer SNAPSHOT_TOKEN) maker publishes a snapshot
//   GET  /api/stats                  non-maker wallets, fills, settled city-days (from our own log scan)
//   POST /api/stats                  (Bearer SNAPSHOT_TOKEN) maker-reported stats, shown separately
//   GET  /api/settlements            resolved ladders with tx hashes (for the settlement history screen)
//   POST /api/admin/rescan|tick      (Bearer ADMIN_TOKEN) backfill a block range / run the cron now
//
// A cron (every minute) refills the relayer's AUSD float from the faucet and advances the log scan.
import { DEPLOYMENTS } from './deployments';
import { configFrom, type Env } from './env';
import { marketsOf, normalizeSnapshot } from './snapshot';
import { HttpError, corsHeaders, errorMessage, ipBucket, ipTag, json, readJson, requireBearer } from './util';

export { RelayerDO } from './relayer-do';

const VERSION = '1.0.0';

function stub(env: Env) {
  return env.RELAYER.get(env.RELAYER.idFromName('main'));
}

async function callDO(env: Env, path: string, body?: unknown): Promise<Response> {
  return stub(env).fetch(`https://relayer.internal${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function passthrough(r: Response): Promise<Response> {
  return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (m === 'GET' && (path === '/' || path === '/api')) {
    return json({
      name: 'isotherm-api',
      version: VERSION,
      chainId: 10143,
      network: 'Monad testnet (faucet AUSD only, no real money)',
      endpoints: ['/api/health', '/api/drip', '/api/relay/mint', '/api/snapshot', '/api/stats', '/api/settlements'],
    });
  }

  if (m === 'GET' && path === '/api/health') {
    const r = await callDO(env, '/info');
    const info = (await r.json()) as Record<string, unknown>;
    const snap = await env.ISO_KV.get('snapshot:latest', 'json').catch(() => null) as { receivedAt?: string } | null;
    const stats = await env.ISO_KV.get('stats:public', 'json').catch(() => null) as { updatedAt?: string; lagBlocks?: number } | null;
    return json({
      ok: true,
      version: VERSION,
      ...info,
      snapshotReceivedAt: snap?.receivedAt ?? null,
      statsUpdatedAt: stats?.updatedAt ?? null,
      statsLagBlocks: stats?.lagBlocks ?? null,
    }, 200, { 'cache-control': 'no-store' });
  }

  if (m === 'POST' && path === '/api/drip') {
    const body = await readJson<{ address?: string }>(req, 2048);
    const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'local';
    const tag = await ipTag(ipBucket(ip), env.SNAPSHOT_TOKEN ?? 'isotherm'); // IPv6 limited per /64, not per address
    return passthrough(await callDO(env, '/drip', { address: body.address ?? '', ip: tag }));
  }

  if (m === 'POST' && path === '/api/relay/mint') {
    const body = await readJson<Record<string, unknown>>(req, 4096);
    return passthrough(await callDO(env, '/relay-mint', body));
  }

  if (m === 'GET' && path === '/api/snapshot') {
    const v = await env.ISO_KV.get('snapshot:latest');
    if (!v) return json({ version: 1, empty: true, ladders: [] }, 200, { 'cache-control': 'public, max-age=5' });
    return new Response(v, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=5' } });
  }

  if (m === 'POST' && path === '/api/snapshot') {
    await requireBearer(req, env.SNAPSHOT_TOKEN);
    const snap = normalizeSnapshot(await readJson<unknown>(req, 512 * 1024));
    await env.ISO_KV.put('snapshot:latest', JSON.stringify(snap));
    const markets = marketsOf(snap).map((x) => ({ market: x.market, fromBlock: x.fromBlock?.toString() }));
    if (markets.length) ctx.waitUntil(callDO(env, '/markets', { markets }).then(() => undefined).catch(() => undefined));
    return json({ ok: true, ladders: snap.ladders.length, strikes: snap.ladders.reduce((n, l) => n + l.strikes.length, 0), receivedAt: snap.receivedAt });
  }

  if (m === 'GET' && path === '/api/stats') {
    const [pub, maker] = await Promise.all([env.ISO_KV.get('stats:public', 'json'), env.ISO_KV.get('stats:maker', 'json')]);
    return json(
      { ...((pub as object) ?? { empty: true, note: 'the log scanner has not published yet' }), maker: maker ?? null },
      200,
      { 'cache-control': 'public, max-age=10' },
    );
  }

  if (m === 'POST' && path === '/api/stats') {
    await requireBearer(req, env.SNAPSHOT_TOKEN);
    const body = await readJson<Record<string, unknown>>(req, 64 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'stats must be an object');
    await env.ISO_KV.put('stats:maker', JSON.stringify({ ...body, receivedAt: new Date().toISOString(), source: 'maker-reported' }));
    return json({ ok: true });
  }

  if (m === 'GET' && path === '/api/settlements') {
    const v = await env.ISO_KV.get('settlements:public');
    return new Response(v ?? JSON.stringify({ settlements: [], resolver: DEPLOYMENTS.resolver }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=15' },
    });
  }

  if (m === 'POST' && path === '/api/admin/rescan') {
    await requireBearer(req, env.ADMIN_TOKEN);
    return passthrough(await callDO(env, '/rescan', await readJson<Record<string, unknown>>(req, 8192)));
  }

  if (m === 'POST' && path === '/api/admin/tick') {
    await requireBearer(req, env.ADMIN_TOKEN);
    return passthrough(await callDO(env, '/tick', {}));
  }

  throw new HttpError(404, 'not found');
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cfg = configFrom(env);
    const cors = corsHeaders(req.headers.get('origin'), cfg.allowedOrigins);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res: Response;
    try {
      res = await route(req, env, ctx);
    } catch (e) {
      res = e instanceof HttpError ? json({ ok: false, error: e.message, ...e.extra }, e.status) : json({ ok: false, error: errorMessage(e) }, 500);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('x-content-type-options', 'nosniff');
    return out;
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(callDO(env, '/tick', {}).then((r) => r.text()).then(() => undefined));
  },
};
