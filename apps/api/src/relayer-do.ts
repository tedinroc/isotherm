// One Durable Object instance ("main") owns the relayer key's nonce, the drip/relay ledger and the log-scan
// cursor. That gives strongly consistent rate limits and a single sender, which a plain Worker + KV cannot.
import { DEPLOYMENTS } from './deployments';
import { configFrom, type Config, type Env } from './env';
import { makeClients, type Pub } from './chain';
import { createRelayer, type Relayer, type RelayMintWire } from './relayer';
import { addMarkets, loadBatch, publicStats, refreshSettlements, scanOnce, scanRange, type ScanOptions } from './scan';
import { WindowLimiter, type Store } from './limits';
import { HttpError, errorMessage, json } from './util';
import { getAddress, isAddress, type Address } from 'viem';

export class RelayerDO {
  private cfg: Config;
  private pub: Pub;
  private relayer: Relayer;
  private store: Store;
  private scanning: Promise<unknown> | null = null;
  private posts: WindowLimiter;

  constructor(
    state: DurableObjectState,
    private env: Env,
  ) {
    this.cfg = configFrom(env);
    const { pub, wallet } = makeClients(this.cfg, env.RELAYER_KEY);
    this.pub = pub;
    this.store = state.storage as unknown as Store;
    this.relayer = createRelayer({ cfg: this.cfg, dep: DEPLOYMENTS, pub, wallet, store: this.store });
    this.posts = new WindowLimiter(this.cfg.postLimitPerMin, 60_000);
  }

  /** Per-network request window for the public POST endpoints, before any storage or RPC work. */
  private throttle(ip: unknown) {
    const r = this.posts.hit(String(ip ?? 'unknown'));
    if (!r.ok) throw new HttpError(429, 'too many requests from this network; slow down', { retryAfterSec: r.retryAfterSec });
  }

  private scanOpts(maxWindows = this.cfg.statsScanMaxWindows): ScanOptions {
    return {
      pub: this.pub,
      store: this.store,
      resolver: DEPLOYMENTS.resolver,
      zap: DEPLOYMENTS.zap,
      multicall: DEPLOYMENTS.multicall3,
      classifier: {
        makers: new Set(this.cfg.makerAddresses.map((a) => a.toLowerCase())),
        team: new Set(this.cfg.teamAddresses.map((a) => a.toLowerCase())),
      },
      startBlock: this.cfg.statsStartBlock,
      maxWindows,
      realStations: this.cfg.realStations,
    };
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    try {
      const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
      switch (path) {
        case '/info':
          return json(await this.relayer.info());
        case '/drip':
          this.throttle(body.ip);
          return json(await this.relayer.drip(String(body.address ?? ''), String(body.ip ?? 'unknown')));
        case '/relay-mint':
          this.throttle(body.ip);
          return json(await this.relayer.relayMint(body.wire as RelayMintWire, String(body.ip ?? 'unknown')));
        case '/markets': {
          const list = Array.isArray(body.markets) ? body.markets : [];
          const ms = list
            .filter((m): m is { market: string; fromBlock?: string } => !!m && typeof m === 'object' && isAddress((m as { market: string }).market))
            .map((m) => ({ market: getAddress(m.market) as Address, fromBlock: m.fromBlock ? BigInt(m.fromBlock) : undefined }));
          const fresh = await addMarkets(this.store, ms);
          return json({ ok: true, added: fresh.length });
        }
        case '/tick':
          return json(await this.tick());
        case '/rescan': {
          const from = BigInt(String(body.fromBlock ?? '0'));
          const to = BigInt(String(body.toBlock ?? '0'));
          if (from <= 0n || to < from) throw new HttpError(400, 'fromBlock/toBlock');
          const extra = (Array.isArray(body.markets) ? body.markets : []).filter((a): a is string => typeof a === 'string' && isAddress(a)).map((a) => getAddress(a));
          if (extra.length) await addMarkets(this.store, extra.map((market) => ({ market, fromBlock: from })));
          const r = await scanRange(this.scanOpts(Math.min(60, Number(body.maxWindows ?? 60))), from, to, extra);
          await this.publish();
          return json({ ok: true, ...r });
        }
        default:
          return json({ ok: false, error: 'not found' }, 404);
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message, ...e.extra }, e.status);
      return json({ ok: false, error: errorMessage(e) }, 500);
    }
  }

  /** Cron body: keep the AUSD float topped up, advance the log scan, publish stats to KV. */
  async tick() {
    const out: Record<string, unknown> = {};
    try {
      out.refill = await this.relayer.refill();
    } catch (e) {
      out.refill = { ok: false, error: errorMessage(e) };
    }
    if (!this.scanning) {
      this.scanning = (async () => {
        try {
          const r = await scanOnce(this.scanOpts());
          out.scan = { head: r.head, cursor: r.cursor, windows: r.windows, logs: r.logsSeen, backfillPending: r.backfillPending };
          await this.publish(r.head, r.cursor);
        } catch (e) {
          out.scan = { ok: false, error: errorMessage(e) };
        } finally {
          this.scanning = null;
        }
      })();
      await this.scanning;
    } else {
      out.scan = 'already running';
    }
    return out;
  }

  private async publish(head?: bigint, cursor?: bigint) {
    const b = await loadBatch(this.store);
    const rows = Object.values(b.settlements).sort((a, c) => (a.date === c.date ? a.station.localeCompare(c.station) : c.date - a.date));
    await refreshSettlements(this.pub, DEPLOYMENTS.multicall3, DEPLOYMENTS.resolver, rows.slice(0, 120));
    for (const r of rows) b.settlements[`${r.station}-${r.date}`] = r;
    await this.store.put('scan:settlements', b.settlements);
    const h = head ?? (await this.pub.getBlockNumber());
    const c = cursor ?? BigInt((await this.store.get<string>('scan:cursor')) ?? (h + 1n).toString());
    const stats = publicStats(b, this.cfg.realStations, {
      head: h,
      cursor: c,
      drips: (await this.store.get<number>('drip:total')) ?? 0,
      relayed: (await this.store.get<number>('relay:total')) ?? 0,
    });
    await this.env.ISO_KV.put('stats:public', JSON.stringify(stats));
    await this.env.ISO_KV.put(
      'settlements:public',
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        resolver: DEPLOYMENTS.resolver,
        realStations: this.cfg.realStations,
        settlements: rows.slice(0, 200),
      }),
    );
  }
}
