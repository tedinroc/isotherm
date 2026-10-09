// One Durable Object instance ("main") owns the relayer key's nonce, the drip/relay ledger and the log-scan
// cursor. That gives strongly consistent rate limits and a single sender, which a plain Worker + KV cannot.
// It also owns the only RPC pool (src/rpc.ts): every chain read and write of the API goes through this instance, so
// one client-side throttle and one set of endpoint cooldowns cover all of them.
import { DEPLOYMENTS } from './deployments';
import { configFrom, type Config, type Env } from './env';
import { makeClients, type Pub } from './chain';
import { createRelayer, type Relayer, type RelayMintWire } from './relayer';
import { addMarkets, loadBatch, makeClassifier, publicStats, refreshSettlements, scanOnce, scanRange, type MigrationInfo, type ScanOptions } from './scan';
import { WindowLimiter, type Store } from './limits';
import { HttpError, errorMessage, json } from './util';
import { classifyRpcError, type Rpc } from './rpc';
import { getAddress, isAddress, type Address } from 'viem';

/** After a scan run stopped on an RPC rate limit / outage, skip whole cron ticks: about 2, 4, then 8 minutes. */
const SCAN_BACKOFF_KEY = 'scan:backoff';
const SCAN_BACKOFF_MAX_LEVEL = 3;
export const scanBackoffMs = (level: number) => 60_000 * 2 ** Math.min(level, SCAN_BACKOFF_MAX_LEVEL) - 5_000;

export class RelayerDO {
  private cfg: Config;
  private pub: Pub;
  private relayer: Relayer;
  private rpc: Rpc;
  private store: Store;
  private scanning: Promise<unknown> | null = null;
  private posts: WindowLimiter;

  constructor(
    state: DurableObjectState,
    private env: Env,
  ) {
    this.cfg = configFrom(env);
    const { pub, wallet, rpc } = makeClients(this.cfg, env.RELAYER_KEY);
    this.pub = pub;
    this.rpc = rpc;
    this.store = state.storage as unknown as Store;
    const ignored = this.cfg.rpcIgnored;
    this.relayer = createRelayer({
      cfg: this.cfg,
      dep: DEPLOYMENTS,
      pub,
      wallet,
      store: this.store,
      rpcStatus: () => ({ source: this.cfg.rpcSource, endpoints: this.rpc.status(), ...(ignored.length ? { ignored } : {}) }),
    });
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
      startBlock: this.cfg.statsStartBlock,
      maxWindows,
      realStations: this.cfg.realStations,
      lagBlocks: this.cfg.statsScanLagBlocks,
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
          return json(await this.tick(body.force === true));
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

  /** Cron body: keep the AUSD float topped up, advance the log scan, publish stats to KV. `force` (the admin tick)
   *  scans even during an RPC backoff. */
  async tick(force = false) {
    const out: Record<string, unknown> = {};
    try {
      out.refill = await this.relayer.refill();
    } catch (e) {
      out.refill = { ok: false, error: errorMessage(e) };
    }
    if (!this.scanning) {
      this.scanning = (async () => {
        let backoff: { until: number; level: number } | undefined;
        try {
          backoff = await this.store.get<{ until: number; level: number }>(SCAN_BACKOFF_KEY);
          if (backoff && Date.now() < backoff.until && !force) {
            out.scan = { skipped: 'rpc backoff', until: new Date(backoff.until).toISOString(), level: backoff.level };
            return;
          }
          const r = await scanOnce(this.scanOpts());
          out.scan = {
            head: r.head,
            cursor: r.cursor,
            windows: r.windows,
            logs: r.logsSeen,
            backfillPending: r.backfillPending,
            ...(r.stopped ? { stopped: r.stopped } : {}),
          };
          await this.publish(r.head, r.cursor);
          await this.noteScan(r.stopped?.kind ?? null, backoff);
        } catch (e) {
          out.scan = { ok: false, error: errorMessage(e) };
          await this.noteScan(classifyRpcError(e), backoff).catch(() => undefined);
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

  /** A run that stopped on a rate limit / outage / every endpoint skipped backs the scan off; a clean run resets it. */
  private async noteScan(stop: string | null, backoff: { until: number; level: number } | undefined) {
    if (stop === 'rate-limited' || stop === 'transient' || stop === 'skip') {
      const level = Math.min((backoff?.level ?? 0) + 1, SCAN_BACKOFF_MAX_LEVEL);
      await this.store.put(SCAN_BACKOFF_KEY, { until: Date.now() + scanBackoffMs(level), level });
    } else if (stop === null && backoff) {
      await this.store.delete(SCAN_BACKOFF_KEY);
    }
  }

  private async publish(head?: bigint, cursor?: bigint) {
    const b = await loadBatch(this.store);
    const rows = Object.values(b.settlements).sort((a, c) => (a.date === c.date ? a.station.localeCompare(c.station) : c.date - a.date));
    await refreshSettlements(this.pub, DEPLOYMENTS.multicall3, DEPLOYMENTS.resolver, rows.slice(0, 120));
    for (const r of rows) b.settlements[`${r.station}-${r.date}`] = r;
    await this.store.put('scan:settlements', b.settlements);
    const h = head ?? (await this.pub.getBlockNumber());
    const c = cursor ?? BigInt((await this.store.get<string>('scan:cursor')) ?? (h + 1n).toString());
    // maker / team / external is decided here, from the lists in this deploy's config, not when the fill was scanned
    const stats = publicStats(
      b,
      this.cfg.realStations,
      {
        head: h,
        cursor: c,
        drips: (await this.store.get<number>('drip:total')) ?? 0,
        relayed: (await this.store.get<number>('relay:total')) ?? 0,
        migration: (await this.store.get<MigrationInfo>('scan:migration')) ?? null,
      },
      makeClassifier(this.cfg.makerAddresses, this.cfg.teamAddresses),
    );
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
