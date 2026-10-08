// MakerDO: the single writer. One Durable Object instance (idFromName("maker")) owns the maker keys' nonces, the
// state, the budget meters and the live/shadow flag. It ticks on its own alarm (every TICK_SEC, earlier when a ladder's
// kill-switch time comes first); the Worker's every-minute cron only re-arms that alarm if it is missing or overdue.
// A tick never overlaps another one: the alarm handler is serialised by the runtime, and `running` also covers the
// internal /tick route used by the tests. The DO has no public route: only the Worker's own code can reach it.
import { DurableObject } from "cloudflare:workers";
import { bindingApi } from "./api.ts";
import { MakerEngine, type TickReport } from "./engine.ts";
import { settingsFrom, type Env } from "./env.ts";
import { SqlStore, stringify } from "./store.ts";

const OVERDUE_MS = 90_000;

export class MakerDO extends DurableObject<Env> {
  private store: SqlStore;
  private engine: MakerEngine | null = null;
  private running: Promise<TickReport> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
  }

  private getEngine(): MakerEngine {
    if (!this.engine) {
      const env = this.env;
      this.engine = new MakerEngine({
        settings: settingsFrom(env),
        store: this.store,
        kv: env.MAKER_KV ? { get: (k) => env.MAKER_KV!.get(k), put: (k, v) => env.MAKER_KV!.put(k, v) } : null,
        api: bindingApi(env.API),
        keys: { maker: env.MAKER_KEY, operator: env.OPERATOR_KEY, guardian: env.GUARDIAN_KEY, snapshotToken: env.SNAPSHOT_TOKEN, makerAddress: env.MAKER_ADDRESS, operatorAddress: env.OPERATOR_ADDRESS },
        version: env.CF_VERSION_METADATA ? { id: env.CF_VERSION_METADATA.id, tag: env.CF_VERSION_METADATA.tag, timestamp: env.CF_VERSION_METADATA.timestamp } : null,
        log: (level, msg) => (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[maker] ${msg}`),
      });
    }
    return this.engine;
  }

  private async runTick(opts: { forceWatch?: boolean } = {}): Promise<TickReport> {
    if (this.running) await this.running.catch(() => undefined);
    const p = this.getEngine().tick(opts);
    this.running = p;
    try {
      const r = await p;
      console.log(`[maker] tick ${r.mode} block ${r.block} ${r.ms}ms intents ${r.intents.length} txs ${r.txs.length} errors ${r.errors.length}${r.alerts.length ? ` ALERTS ${r.alerts.join(" | ")}` : ""}`);
      return r;
    } finally {
      this.running = null;
    }
  }

  /** Arm the next alarm. `startedAt` = when the tick that just ran started: the period is measured from tick start
   *  to tick start (no drift by the tick's own duration). */
  private async schedule(startedAt?: number) {
    let d: number;
    try {
      d = this.getEngine().nextDelayMs(startedAt === undefined ? 0 : Date.now() - startedAt);
    } catch {
      d = 60_000;
    }
    await this.ctx.storage.setAlarm(Date.now() + d);
  }

  async alarm() {
    const startedAt = Date.now();
    try {
      await this.runTick();
    } catch (e) {
      console.error(`[maker] tick crashed: ${String((e as Error)?.stack ?? e).slice(0, 800)}`);
    } finally {
      await this.schedule(startedAt);
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const json = (v: unknown, status = 200) => new Response(stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/kick") {
      // cron: make sure the self-rescheduling alarm exists and is not stuck
      const a = await this.ctx.storage.getAlarm();
      const now = Date.now();
      let action = "alarm ok";
      if (a === null || a < now - OVERDUE_MS) {
        await this.ctx.storage.setAlarm(now + 1_000);
        action = a === null ? "alarm armed" : `alarm was ${Math.round((now - a) / 1000)}s overdue: re-armed`;
      }
      this.store.put("cron:last", { at: new Date(now).toISOString(), action });
      return json({ ok: true, action });
    }
    if (url.pathname === "/tick" && req.method === "POST") {
      // internal: run one tick now (the anvil-fork test drives the maker through this; the DO is not public)
      const startedAt = Date.now();
      const r = await this.runTick({ forceWatch: url.searchParams.get("watch") === "1" });
      if (url.searchParams.get("schedule") !== "0") await this.schedule(startedAt);
      return json(r);
    }
    if (url.pathname === "/status") {
      const e = this.getEngine();
      return json({ ...e.status(this.store.get("tick:last") ?? null, e.modeDecision().mode), alarm: await this.ctx.storage.getAlarm(), cron: this.store.get("cron:last") ?? null, summary: this.store.get("shadow:summary") ?? null });
    }
    if (url.pathname === "/log") {
      const name = url.searchParams.get("name") ?? "ticks";
      if (!["ticks", "ticks:detail", "alerts", "txs:live", "txs:shadow"].includes(name)) return json({ error: "unknown log" }, 400);
      return json(this.store.tail(name, Math.min(500, Number(url.searchParams.get("limit") ?? 50))));
    }
    return json({ error: "not found" }, 404);
  }
}
