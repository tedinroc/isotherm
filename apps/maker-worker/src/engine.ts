// The maker inside the Durable Object: one tick = control -> mode -> kill switch -> roll -> reconcile -> quote ->
// settlement watch -> snapshot -> report. Runtime-agnostic orchestration (the unit tests run it in Node against a
// fake chain); the trading logic itself is packages/maker (tick.ts, roll.ts, chain.ts send, policy, pricing, budget)
// and packages/forecast (fair values), unchanged.
//
// MODES. LIVE needs BOTH the env var MAKER_MODE=live AND the Durable Object flag (set by an `arm` control document
// that names the maker address), plus the maker/operator key secrets. Everything else is SHADOW: the same code runs
// with the shared core's dry-run path (simulate + estimate + budget check, then NOT sent), every would-be tx is
// recorded as an intent, and the shadow keeps its own state and meters, mirroring the live maker's orders on the books.
// While live, a snapshot published by ANOTHER writer in the last INTERLOCK_FRESH_SEC (the Mac maker still running)
// turns the tick back into shadow (only the kill switch still runs live), so two writers never race one key.
import { createWalletClient, getAddress, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { closeFromStats, type CloseTimeStats } from "../../../packages/forecast/src/closetime.ts";
import closeTimeJson from "../../../packages/forecast/results/close_time.json";
import { addDays, isoToYmd, localDateOf, STATIONS } from "../../../packages/forecast/src/stations.ts";
import { vaultCommonAbi } from "../../../packages/maker/src/abis.ts";
import { budgetCfgOf, budgetDay, isReserveKind, quotingTier, recordSpend } from "../../../packages/maker/src/budget.ts";
import { explainRevert, LiveRefused, nowSec, read, type Ctx, type Logger, type TxIntent, type TxRecord } from "../../../packages/maker/src/chain.ts";
import type { MakerConfig } from "../../../packages/maker/src/config-core.ts";
import type { MarketData } from "../../../packages/maker/src/data-core.ts";
import { parseDeployment, probeZapRegistry, type Deployment } from "../../../packages/maker/src/deployment-core.ts";
import { roll, station4, type RollReport } from "../../../packages/maker/src/roll.ts";
import { buildSnapshot } from "../../../packages/maker/src/snapshot-core.ts";
import { assertStateDeployment, emptyState, ladderKey, note, type LadderState, type MakerState } from "../../../packages/maker/src/state-core.ts";
import { killLadder, runWatchdog, tickLadder, type LadderTick } from "../../../packages/maker/src/tick.ts";
import deploymentsJson from "../../../deployments/testnet.json";
import { parseWebhook, pushAlerts, pushLog, type PushOutcome, type Webhook } from "./alert-push.ts";
import type { ApiClient } from "./api.ts";
import { BUNDLED_TREASURY, workerConfig } from "./config.ts";
import { SNAPSHOT_SOURCE, type Settings } from "./env.ts";
import { makeGetter, makeSourceGet, type SourceGet } from "./fetcher.ts";
import { workerMarketData } from "./market-data.ts";
import { NonceTracker } from "./nonces.ts";
import { reconcileLadder, type ReconcileResult } from "./reconcile.ts";
import { makeRpc, type Rpc } from "./rpc.ts";
import { stringify, type Store } from "./store.ts";
import { parseTreasuryCfg, treasuryPass, type TreasuryReport } from "./treasury.ts";
import { watchPass, type WatchReport } from "./watcher.ts";

export type Mode = "shadow" | "live";

/** The control document (KV key `control`), written by scripts/control.mjs. Applied once per new `seq`. */
export interface ControlDoc {
  seq: number;
  live?: boolean; // arm (true, with confirm = maker address) / disarm (false)
  confirm?: string;
  importState?: string; // KV key holding a Node maker state.json (live state; only while disarmed)
  pull?: string; // "all" | ladder key "RCSS:20261009": cancel quotes now and pause re-quoting (current mode)
  resume?: string; // ladder key
  roll?: { station: string; date: string; strikes?: number[] }[];
  resetShadow?: boolean;
  /** raise one "TEST ALERT" on the next tick (checks the optional push channel end to end) */
  testAlert?: boolean;
  note?: string;
}

export interface ControlState {
  live: boolean;
  seq: number;
  armedAt?: string;
  disarmedAt?: string;
  history: { seq: number; at: string; applied: string }[];
}

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Keys {
  maker?: string;
  operator?: string;
  guardian?: string;
  snapshotToken?: string;
  /** Optional ALERT_WEBHOOK_URL secret: alerts are also pushed there (src/alert-push.ts). */
  alertWebhook?: string;
  /** Optional ALERT_WEBHOOK_TOKEN secret: `Authorization: Bearer` on every push (ntfy account token). */
  alertWebhookToken?: string;
  /** Optional TREASURY_KEY secret: the dedicated treasury key that tops up the role keys (src/treasury.ts). */
  treasury?: string;
  /** Public addresses for a key-less, watch-only shadow (MAKER_ADDRESS / OPERATOR_ADDRESS vars). */
  makerAddress?: string;
  operatorAddress?: string;
}

export interface EngineDeps {
  settings: Settings;
  store: Store;
  kv: KvLike | null;
  api: ApiClient;
  keys: Keys;
  now?: () => number;
  pub?: PublicClient;
  wallet?: Ctx["wallet"];
  data?: MarketData;
  sources?: SourceGet;
  version?: { id: string; tag: string; timestamp: string } | null;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** for the alert push (tests inject a stub); default globalThis.fetch */
  fetch?: typeof fetch;
  pushTimeoutMs?: number;
  /** RPC transport options (tests inject a fake fetch); default from the settings */
  rpcFetch?: typeof fetch;
}

export interface TickReport {
  at: string;
  ms: number;
  mode: Mode;
  envMode: Mode;
  liveFlag: boolean;
  reasons: string[];
  block: number | null;
  chainTime: number | null;
  control: string | null;
  interlock: { checked: boolean; blocked: boolean; detail: string } | null;
  kill: { key: string; cancelled: number; leftOpen: number; mode: Mode }[];
  rolls: { key: string; ok: boolean; steps: { step: string; status: string; detail: string }[]; mon: Record<string, number>; estimated: Record<string, number> }[];
  reconcile: (ReconcileResult & { key: string })[];
  ladders: LadderView[];
  /** would-be txs (shadow / dry run). `repeat`: the identical tx (same target and calldata, i.e. the same book state)
   *  was already recorded: live would have sent it once and moved on, so a repeat is not metered again. */
  intents: (Omit<TxIntent, "data" | "estimate" | "gasLimit" | "value"> & { gasLimit: string; data: string; repeat?: boolean })[];
  txs: { label: string; role: string; hash: Hex; mon: number; status: string }[];
  watcher: (Omit<WatchReport, "verdicts"> & { verdicts: { key: string; verdict: string; detail: string }[] }) | { skipped: string } | null;
  /** the treasury top-up pass (every treasury.everySec) */
  treasury?: TreasuryReport | { skipped: string } | null;
  snapshot: { posted: boolean; status?: number; detail: string } | null;
  budget: Record<string, number>;
  alerts: string[];
  /** what happened to this tick's alerts on the optional push channel (no URL) */
  push: PushOutcome[];
  errors: string[];
  log: string[];
}

export interface LadderView {
  key: string;
  status: string;
  paused: boolean;
  stopAt: number;
  /** the inputs' timestamps (compare with the live maker's snapshot: Polymarket fetch, v0 guard refresh, METAR max) */
  data?: { pmFetchedAt: string | null; v0Mu: number | null; v0FetchedAt: string | null; obsMaxC: number | null; macV0Mu?: number | null };
  strikes: {
    k: number;
    fair: number | null;
    source: string | null;
    /** the v0 / intraday guardrail probability and its source (the guard-wide / guard-pull flags come from it) */
    guard: number | null;
    flags: string[];
    desired: { bid: number | null; ask: number | null; bidSize: number; askSize: number } | { pull: string[] } | null;
    resting: { bid: number | null; ask: number | null };
    action: string | null;
    reasons: string[];
    error?: string;
    mac?: { fair: number | null; guard: number | null; bid: number | null; ask: number | null; mode: string | null; action: string | null; lastQuoteAt: number | null } | null;
  }[];
}

/** One line per tick for the operator's history (KV `ticks:recent`, `scripts/control.mjs ticks`). */
export interface TickLine {
  at: string;
  ms: number;
  mode: Mode;
  block: number | null;
  intents: string[];
  txs: string[];
  errors: string[];
  alerts: string[];
  kill: string[];
  rolls: string[];
  /** treasury top-ups this tick (sent or, in shadow / without a key, intended), "" when no pass ran */
  treasury?: string[];
  strikes: {
    key: string;
    k: number;
    fair: number | null;
    guard: number | null;
    flags: string[];
    action: string | null;
    desired: string; // "b/a", "pull" or "-"
    resting: string;
    reasons: string;
    /** the live maker's published snapshot at this tick (shadow only; "missing" if it has no such strike) */
    mac: { fair: number | null; guard: number | null; quote: string; mode: string | null } | "missing" | null;
  }[];
}

/** Shadow only: re-check every this often whether the live maker has rolled a ladder the shadow only dry-planned. */
const SHADOW_ADOPT_EVERY_SEC = 120;
const TICK_LINES_KV = 90;

export interface ShadowSummary {
  since: string;
  ticks: number;
  liveTicks: number;
  lastTickAt: string | null;
  actions: Record<string, number>;
  intents: Record<string, number>; // distinct would-be txs by kind (repeats of the same tx excluded)
  intentMon: Record<string, number>;
  intentRepeats?: number;
  rolls: number;
  kills: number;
  errors: number;
  alerts: number;
  compare: { n: number; fairAbsDiffSum: number; fairAbsDiffMax: number; restingMatchesDesired: number; wouldChange: number; macMissing: number };
  recentDiffs: { at: string; key: string; k: number; shadowFair: number | null; macFair: number | null; shadowAction: string | null; desired: string; macResting: string }[];
}

const TRANSFER_GAS_STR = "21000";
const CLOSE_TIMES = (closeTimeJson as unknown as { stations: Record<string, CloseTimeStats> }).stations;
const STATE_KEEP_CLOSED_SEC = 14 * 86_400;

/** An address-only "account" for the watch-only shadow: viem simulates and estimates from it, it can never sign. */
export function watchOnlyAccount(address: string | undefined, what: string): PrivateKeyAccount | null {
  if (!address || !address.trim()) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) throw new Error(`${what} is not an address`);
  return { address: getAddress(address.trim()), type: "json-rpc" } as unknown as PrivateKeyAccount;
}

export function parseKey(raw: string | undefined, what: string): PrivateKeyAccount | null {
  if (!raw || !raw.trim()) return null;
  const k = raw.trim();
  const hex = (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${what} secret is not a 32-byte hex private key`); // never echo it
  return privateKeyToAccount(hex);
}

export class MakerEngine {
  readonly s: Settings;
  readonly store: Store;
  private deps: EngineDeps;
  private now: () => number;
  private dep: Deployment;
  private pub: PublicClient;
  private chain: Ctx["chain"];
  private probed = false;
  private isAnvil = false;
  private clientVersion = "unknown";
  private data: MarketData;
  private sources: SourceGet;
  private nonces: NonceTracker;
  private written = new Map<string, string>();
  private liveNow = false;
  private sleep: (ms: number) => Promise<void>;
  private hook: Webhook | null = null;
  private hookError: string | null = null;
  private pushQueue: { title: string; body: string }[] = [];
  private rpc: Rpc | null;
  private rpcProbe: string[] = [];
  treasuryKey: PrivateKeyAccount | null = null;
  private treasuryKeyError: string | null = null;
  maker: PrivateKeyAccount | null;
  operator: PrivateKeyAccount | null;
  watchOnly = false;
  guardian: PrivateKeyAccount | null;

  constructor(d: EngineDeps) {
    this.deps = d;
    this.s = d.settings;
    this.store = d.store;
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.dep = parseDeployment(deploymentsJson, "deployments/testnet.json (bundled)");
    const rpc = makeRpc(this.s.rpcs, { rps: this.s.rpcRps, retries: this.s.rpcRetries, cooldownMs: this.s.rpcCooldownSec * 1000, timeoutMs: this.s.rpcTimeoutSec * 1000, fetchFn: d.rpcFetch, sleep: d.sleep });
    this.rpc = d.pub ? null : rpc; // tests inject a fake public client
    this.pub = d.pub ?? rpc.pub;
    this.chain = rpc.chain;
    const cfg = workerConfig(this.s, "shadow");
    this.data = d.data ?? workerMarketData({ get: makeGetter({ store: d.store }), store: d.store, closeTimes: CLOSE_TIMES, loop: cfg.loop, testUrl: this.s.testMarketDataUrl });
    this.sources = d.sources ?? makeSourceGet({ proxy: this.s.testSourceProxy });
    this.nonces = new NonceTracker(d.store, this.now);
    this.maker = parseKey(d.keys.maker, "MAKER_KEY");
    this.operator = parseKey(d.keys.operator, "OPERATOR_KEY");
    if (!this.maker && !this.operator && d.keys.makerAddress) {
      // no key secrets at all: a watch-only shadow of the public maker/operator addresses
      this.watchOnly = true;
      this.maker = watchOnlyAccount(d.keys.makerAddress, "MAKER_ADDRESS");
      this.operator = watchOnlyAccount(d.keys.operatorAddress, "OPERATOR_ADDRESS");
    }
    this.guardian = parseKey(d.keys.guardian, "GUARDIAN_KEY");
    // optional: a malformed TREASURY_KEY disables the top-ups (reported), it never stops the maker
    try {
      this.treasuryKey = parseKey(d.keys.treasury, "TREASURY_KEY");
    } catch (e) {
      this.treasuryKeyError = `${String((e as Error).message)}: ignored, no top-ups`;
    }
    const h = parseWebhook(d.keys.alertWebhook, this.s.rpcIsLoopback, d.keys.alertWebhookToken);
    if (h && "error" in h) this.hookError = h.error; // the message never contains the URL
    else this.hook = h;
  }

  // ------------------------------------------------------------------ control + mode
  control(): ControlState {
    return this.store.get<ControlState>("control:state") ?? { live: false, seq: 0, history: [] };
  }

  /** Apply the KV control document if its seq is new. Returns a one-line description of what was applied. */
  async applyControl(log: (m: string) => void): Promise<string | null> {
    if (!this.deps.kv) return null;
    const raw = await this.deps.kv.get("control");
    if (!raw) return null;
    let doc: ControlDoc;
    try {
      doc = JSON.parse(raw);
    } catch {
      return "control document is not JSON: ignored";
    }
    const cs = this.control();
    if (!Number.isInteger(doc.seq) || doc.seq <= cs.seq) return null;
    const done: string[] = [];
    const at = new Date(this.now()).toISOString();
    if (doc.live === true) {
      if (!this.maker || this.watchOnly) done.push("arm REFUSED: no MAKER_KEY secret");
      else if ((doc.confirm ?? "").toLowerCase() !== this.maker.address.toLowerCase()) done.push(`arm REFUSED: confirm must be the maker address ${this.maker.address}`);
      else {
        cs.live = true;
        cs.armedAt = at;
        done.push(`ARMED (DO live flag on; live also needs MAKER_MODE=live, now ${this.s.envMode})`);
      }
    } else if (doc.live === false) {
      cs.live = false;
      cs.disarmedAt = at;
      done.push("disarmed (DO live flag off)");
    }
    if (doc.importState) {
      if (cs.live) done.push("importState REFUSED: disarm first");
      else {
        const body = await this.deps.kv.get(doc.importState);
        if (!body) done.push(`importState: KV key ${doc.importState} is empty`);
        else
          try {
            const st = JSON.parse(body) as MakerState;
            assertStateDeployment(st, this.dep, `from KV ${doc.importState}`);
            this.dropState("live");
            st.events ??= [];
            note(st, "import", `state imported from KV ${doc.importState} (${Object.keys(st.ladders).length} ladders)`, Math.floor(this.now() / 1000));
            this.saveState("live", st);
            done.push(`imported live state from ${doc.importState}: ${Object.keys(st.ladders).length} ladder(s)`);
          } catch (e) {
            done.push(`importState FAILED: ${String((e as Error).message).slice(0, 200)}`);
          }
      }
    }
    if (doc.resetShadow) {
      this.dropState("shadow");
      this.store.delete("shadow:summary");
      for (const [k] of this.store.list(`rc:shadow:`)) this.store.delete(k);
      done.push("shadow state and summary reset");
    }
    if (doc.roll?.length) {
      const q = this.store.get<ControlDoc["roll"]>("roll:queue") ?? [];
      for (const r of doc.roll) q!.push(r);
      this.store.put("roll:queue", q);
      done.push(`queued roll ${doc.roll.map((r) => `${r.station} ${r.date}`).join(", ")}`);
    }
    if (doc.pull) this.store.put("pending:pull", doc.pull), done.push(`pull ${doc.pull} queued`);
    if (doc.resume) this.store.put("pending:resume", doc.resume), done.push(`resume ${doc.resume} queued`);
    if (doc.testAlert) this.store.put("pending:testAlert", doc.seq), done.push("test alert raised");
    cs.seq = doc.seq;
    const applied = done.join("; ") || "no-op";
    cs.history = [...cs.history, { seq: doc.seq, at, applied }].slice(-50);
    this.store.put("control:state", cs);
    log(`control seq ${doc.seq}: ${applied}`);
    await this.deps.kv.put("control:result", stringify({ seq: doc.seq, at, applied })).catch(() => undefined);
    return applied;
  }

  /** LIVE iff env MAKER_MODE=live AND the DO flag AND the keys; otherwise SHADOW with the reasons. */
  modeDecision(): { mode: Mode; reasons: string[] } {
    const reasons: string[] = [];
    const cs = this.control();
    if (this.s.envMode !== "live") reasons.push("env MAKER_MODE is shadow");
    if (!cs.live) reasons.push("Durable Object live flag is off");
    if (this.watchOnly) reasons.push("watch-only addresses (no key secrets): shadow only");
    else if (!this.maker || !this.operator) reasons.push("MAKER_KEY / OPERATOR_KEY secret missing");
    return reasons.length ? { mode: "shadow", reasons } : { mode: "live", reasons: ["env MAKER_MODE=live and the DO flag is armed"] };
  }

  /** Another writer = a snapshot on the API younger than INTERLOCK_FRESH_SEC whose source is not this Worker. */
  async interlock(snap: { ok: boolean; status: number; body?: any; error?: string }): Promise<{ checked: boolean; blocked: boolean; detail: string }> {
    if (!snap.ok || !snap.body || typeof snap.body !== "object") return { checked: false, blocked: false, detail: `API snapshot unreadable (${snap.status} ${snap.error ?? ""}): interlock not enforced this tick` };
    if (snap.body.empty) return { checked: true, blocked: false, detail: "no snapshot published yet" };
    const age = Math.round((this.now() - Date.parse(snap.body.receivedAt)) / 1000);
    const source = String(snap.body.source ?? "");
    if (source !== SNAPSHOT_SOURCE && Number.isFinite(age) && age < this.s.interlockFreshSec)
      return { checked: true, blocked: true, detail: `another writer (source "${source}") published a snapshot ${age}s ago (< ${this.s.interlockFreshSec}s): stop it before going live` };
    return { checked: true, blocked: false, detail: `latest snapshot from "${source}" ${age}s ago` };
  }

  // ------------------------------------------------------------------ state per mode
  loadState(mode: Mode): MakerState {
    const meta = this.store.get<Omit<MakerState, "ladders">>(`state:${mode}:meta`);
    const ref = { vault: this.dep.vault, resolver: this.dep.resolver, zap: this.dep.zap, source: this.dep.source, variant: this.dep.variant };
    const s: MakerState = meta ? { ...meta, ladders: {} } : emptyState(ref);
    assertStateDeployment(s, ref, `${mode} (Durable Object)`);
    s.events ??= [];
    for (const [, lad] of this.store.list<LadderState>(`state:${mode}:ladder:`)) s.ladders[lad.key] = lad;
    return s;
  }

  saveState(mode: Mode, s: MakerState) {
    s.events = s.events.slice(-200);
    const put = (k: string, v: unknown) => {
      const j = stringify(v);
      if (this.written.get(k) === j) return;
      this.store.put(k, v);
      this.written.set(k, j);
    };
    const { ladders, ...meta } = s;
    put(`state:${mode}:meta`, meta);
    const t = Math.floor(this.now() / 1000);
    for (const lad of Object.values(ladders)) {
      const k = `state:${mode}:ladder:${lad.key}`;
      if (lad.status === "closed" && t - (lad.closedAt ?? t) > STATE_KEEP_CLOSED_SEC) {
        this.store.delete(k);
        this.written.delete(k);
        delete ladders[lad.key];
        continue;
      }
      put(k, lad);
    }
  }

  dropState(mode: Mode) {
    for (const [k] of this.store.list(`state:${mode}:`)) {
      this.store.delete(k);
      this.written.delete(k);
    }
  }

  /** True if this would-be tx was already recorded (the last 300 distinct ones are remembered). */
  private dryRepeat(sig: string): boolean {
    const seen = this.store.get<string[]>("dry:seen") ?? [];
    if (seen.includes(sig)) return true;
    seen.push(sig);
    this.store.put("dry:seen", seen.slice(-300));
    return false;
  }

  /** Remove one ladder from a mode's state (in memory and in storage). */
  forgetLadder(mode: Mode, s: MakerState, key: string) {
    delete s.ladders[key];
    const k = `state:${mode}:ladder:${key}`;
    this.store.delete(k);
    this.written.delete(k);
  }

  // ------------------------------------------------------------------ context
  private async probe(): Promise<void> {
    if (this.probed) return;
    // every RPC endpoint must answer chain 10143 before it is used (src/rpc.ts); one that answers another chain is excluded
    if (this.rpc) this.rpcProbe = await this.rpc.verifyAll();
    const cid = await this.pub.getChainId();
    if (cid !== 10143) throw new Error(`refusing: RPC is chain ${cid}, not Monad testnet 10143 (mainnet is never touched)`);
    try {
      this.clientVersion = String(await this.pub.request({ method: "web3_clientVersion" as any }));
    } catch {}
    this.isAnvil = /anvil/i.test(this.clientVersion);
    if (this.isAnvil && !this.s.rpcIsLoopback) throw new Error("an anvil client on a non-loopback RPC: refusing");
    await probeZapRegistry(this.pub, this.dep);
    this.probed = true;
  }

  private ctxFor(mode: Mode, cfg: MakerConfig, state: MakerState, report: TickReport, logger: Logger): Ctx {
    if (!this.maker) throw new Error("MAKER_KEY secret missing");
    const operator = this.operator ?? this.maker;
    const accounts = { maker: this.maker, operator, marketCreator: operator } as Ctx["accounts"];
    const bc = budgetCfgOf(cfg);
    return {
      cfg,
      dep: this.dep,
      pub: this.pub,
      chain: this.chain,
      rpc: this.s.rpcs.join(","),
      isAnvil: this.isAnvil,
      clientVersion: this.clientVersion,
      accounts,
      addr: { maker: accounts.maker.address, operator: accounts.operator.address, marketCreator: accounts.marketCreator.address },
      keyNames: { maker: "maker", operator: this.operator ? "operator" : "maker", marketCreator: this.operator ? "operator" : "maker" },
      state,
      save: () => this.saveState(mode, state),
      log: logger,
      closeTimes: CLOSE_TIMES,
      recordTx: (line: TxRecord) => {
        this.store.append(`txs:${mode}`, line, 3000);
        report.txs.push({ label: line.label, role: line.role, hash: line.hash, mon: line.mon, status: line.status });
        // pulls / the kill switch / withdraws are never refused; past the reserve line they are flagged: say so once a day
        if (line.overBudget && isReserveKind(line.kind)) this.reserveOver.push(`${line.role}`);
      },
      onDryRun: (i: TxIntent) => {
        // The shadow meters what it WOULD have spent, so its budget refusals match what live would do. A would-be tx
        // that repeats tick after tick (same target + calldata: the live maker did not do it, so the book did not
        // change) is metered once: live would have sent it once. Otherwise a lasting disagreement (e.g. the v0 guard
        // refreshed at a different minute) would run the shadow's meter into its cap and make it refuse everything.
        const repeat = this.dryRepeat(`${mode}:${i.role}:${i.to.toLowerCase()}:${i.data}`);
        // metered at the instant the shared send() checked the cap (its clock), so check and meter agree on the day
        if (!repeat) recordSpend(state.budget, i.role, i.costMon, Date.parse(i.t), bc, i.kind);
        report.intents.push({ t: i.t, role: i.role, from: i.from, to: i.to, label: i.label, kind: i.kind, functionName: i.functionName, costMon: +i.costMon.toFixed(6), budget: i.budget, gasLimit: i.gasLimit.toString(), data: i.data.length > 74 ? i.data.slice(0, 74) + "…" : i.data, ...(repeat ? { repeat: true } : {}) });
      },
      nonces: mode === "live" ? this.nonces : undefined,
      // writes start at the first healthy endpoint, throttled; they move on only past a rate-limit refusal (src/rpc.ts)
      wallet: this.deps.wallet ?? ((account: PrivateKeyAccount) => createWalletClient({ chain: this.chain, transport: this.rpc ? this.rpc.writeTransport() : http(this.s.rpc, { retryCount: 1, timeout: 45_000 }), account })),
      guard: (role, label) => {
        if (mode !== "live" || !this.liveNow) throw new LiveRefused(`shadow: refusing to broadcast ${role} "${label}"`);
      },
    };
  }

  // ------------------------------------------------------------------ the tick
  private reserveOver: string[] = [];

  async tick(opts: { forceWatch?: boolean; forceTreasury?: boolean } = {}): Promise<TickReport> {
    const t0 = this.now();
    const cs0 = this.control();
    const report: TickReport = { at: new Date(t0).toISOString(), ms: 0, mode: "shadow", envMode: this.s.envMode, liveFlag: cs0.live, reasons: [], block: null, chainTime: null, control: null, interlock: null, kill: [], rolls: [], reconcile: [], ladders: [], intents: [], txs: [], watcher: null, snapshot: null, budget: {}, alerts: [], push: [], errors: [], log: [] };
    this.pushQueue = [];
    this.reserveOver = [];
    const push = (level: "info" | "warn" | "error", msg: string) => {
      report.log.push(`${level === "info" ? "" : level.toUpperCase() + " "}${msg}`.slice(0, 400));
      if (report.log.length > 400) report.log.splice(0, report.log.length - 400);
      this.deps.log?.(level, msg);
    };
    const logger: Logger = { info: (m) => push("info", m), warn: (m) => push("warn", m), error: (m) => push("error", m) };
    const alert = (title: string, body: string) => {
      report.alerts.push(title);
      push("error", `ALERT ${title}: ${body.split("\n")[0]}`);
      this.store.append("alerts", { at: new Date(this.now()).toISOString(), title, body }, 200);
      this.pushQueue.push({ title, body });
    };
    try {
      report.control = await this.applyControl((m) => push("warn", m));
      const testSeq = this.store.get<number>("pending:testAlert");
      if (testSeq !== undefined) {
        this.store.delete("pending:testAlert");
        alert(`TEST ALERT ${testSeq} (isotherm-maker)`, `Raised on request (scripts/control.mjs test-alert) at ${new Date(this.now()).toISOString()}. If this reached you, SETTLEMENT OVERDUE and STALE VOID alerts will too.`);
      }
      const md = this.modeDecision();
      let mode = md.mode;
      report.reasons = md.reasons;
      report.liveFlag = this.control().live;
      await this.probe();
      for (const l of this.rpcProbe.filter((x) => x.startsWith("EXCLUDED"))) alert("RPC ENDPOINT EXCLUDED", `${l}. It answered another chain than Monad testnet 10143 and is never used; check RPC_URLS.`);
      this.rpcProbe = this.rpcProbe.filter((x) => !x.startsWith("EXCLUDED"));
      const apiSnap = await this.deps.api.getSnapshot();
      let killOnlyLive = false;
      if (mode === "live") {
        report.interlock = await this.interlock(apiSnap);
        if (report.interlock.blocked) {
          alert("live mode blocked: another writer is active", report.interlock.detail);
          mode = "shadow";
          killOnlyLive = true;
          report.reasons.push(`interlock: ${report.interlock.detail}`);
        } else if (!report.interlock.checked) push("warn", report.interlock.detail);
      }
      report.mode = mode;
      this.liveNow = mode === "live";
      const block = await this.pub.getBlock({ blockTag: "latest" });
      report.block = Number(block.number);
      report.chainTime = Number(block.timestamp);
      if (!this.maker) {
        report.reasons.push("no MAKER_KEY secret: idle (set the secrets, see scripts/put-secrets.mjs)");
        return this.finish(report, t0, null, mode);
      }

      // the live kill switch keeps running even while the interlock holds everything else in shadow
      if (killOnlyLive) {
        const liveCfg = workerConfig(this.s, "live");
        const liveState = this.loadState("live");
        this.liveNow = true;
        const lctx = this.ctxFor("live", liveCfg, liveState, report, logger);
        for (const k of await runWatchdog(lctx)) report.kill.push({ ...k, mode: "live" });
        this.liveNow = false;
      }

      const cfg = workerConfig(this.s, mode);
      const state = this.loadState(mode);
      const ctx = this.ctxFor(mode, cfg, state, report, logger);
      if (mode === "live") await this.recoverInflight(ctx, logger);

      // 1. kill switch (time + state + chain only). Every WATCHDOG_VERIFY_SEC it also re-scans the books of ladders
      //    closed in the last 2 days and cancels any maker order still open, like the Mac's `watchdog --verify` job.
      const verifyAt = this.store.get<number>("watchdog:verifyAt") ?? 0;
      const verify = this.s.watchdogVerifySec > 0 && this.now() - verifyAt >= this.s.watchdogVerifySec * 1000;
      const killed = await runWatchdog(ctx, { verifyClosed: verify });
      if (verify) this.store.put("watchdog:verifyAt", this.now());
      for (const k of killed) report.kill.push({ ...k, mode });
      const now = await nowSec(ctx);
      if (mode === "shadow")
        for (const lad of Object.values(state.ladders))
          if (lad.status !== "closed" && now >= lad.stopAt - cfg.policy.preStopSec) {
            // the dry-run kill above recorded the cancels it WOULD send; close the shadow ladder so it is not repeated
            lad.status = "closed";
            lad.closedAt = now;
            for (const k of lad.strikes) if (lad.series[k]) (lad.series[k].mode = "closed"), (lad.series[k].orders = {});
            note(state, "kill", `${lad.key} closed (shadow kill switch)`, now);
          }

      // 2. manual pull / resume (control)
      await this.pullResume(ctx, state, logger);

      // 3. roll: queued requests, then the schedule (tomorrow from ROLL_NOT_BEFORE_LOCAL; adopt today's ladder)
      const rolled = await this.rolls(ctx, mode, now, report, logger);

      // 4. reconcile + quote every active ladder
      const ticks = new Map<string, LadderTick>();
      for (const lad of Object.values(state.ladders).sort((a, b) => (a.key < b.key ? -1 : 1))) {
        if (lad.status !== "active") continue;
        for (const r of await reconcileLadder(ctx, lad, this.store, mode, now)) {
          report.reconcile.push({ key: lad.key, ...r });
          // SHADOW: the live maker just placed these orders; its lastQuote for them is re-mirrored after this tick's
          // fair is known (mirrorLastQuotes), so this tick must not judge them against the previous quote's age/fair
          if (mode === "shadow" && (r.adopted.bid !== undefined || r.adopted.ask !== undefined) && lad.series[r.strike]) delete lad.series[r.strike].lastQuote;
        }
        try {
          ticks.set(lad.key, await tickLadder(ctx, lad, this.data, rolled.has(lad.key) && cfg.budget.rollCapMon ? { quoteKind: "roll" } : {}));
        } catch (e) {
          report.errors.push(`tick ${lad.key}: ${explainRevert(e)}`);
          logger.error(`tick ${lad.key}: ${explainRevert(e)}`);
        }
      }
      if (mode === "shadow") this.mirrorLastQuotes(state, ticks, report.reconcile, apiSnap, now);
      report.ladders = this.views(state, ticks, mode === "shadow" ? apiSnap : null);

      // 5. settlement watcher (every WATCH_EVERY_SEC; not in a tick that already broadcast a roll)
      report.watcher = await this.watch(ctx, mode, report, alert, logger, !!opts.forceWatch);

      // 5b. treasury top-ups of the role keys (every treasury.everySec; live mode sends, shadow records intents)
      report.treasury = await this.treasury(ctx, mode, report, alert, logger, !!opts.forceTreasury);

      // a reserve-meter tx past its alert line (pulls, kill switch, withdraws, voids are never refused): once a day per role
      for (const role of new Set(this.reserveOver)) {
        const k = `alert:reserveOver:${role}:${budgetDay(this.now(), cfg.budget.dayUtcOffsetMin)}`;
        if (this.store.get(k)) continue;
        this.store.put(k, true);
        alert(`RESERVE METER OVER ${role}`, `The ${role} reserve meter (pulls, kill switch, margin withdraws, stale voids; never refused) passed its line of ${cfg.budget.reserveMon[role as keyof typeof cfg.budget.reserveMon] ?? 0} MON today: ${(state.budget.spent[`${role}:reserve`] ?? 0).toFixed(4)} MON. Quotes may be crossing often (see ticks).`);
      }

      // 6. snapshot: published only in live mode (a shadow snapshot would replace the live maker's)
      if (mode === "live") {
        const snap = await buildSnapshot(ctx, ticks, { source: SNAPSHOT_SOURCE });
        if (!this.deps.keys.snapshotToken) report.snapshot = { posted: false, detail: "no SNAPSHOT_TOKEN secret" };
        else {
          const r = await this.deps.api.postSnapshot(snap, this.deps.keys.snapshotToken);
          report.snapshot = { posted: r.ok, status: r.status, detail: r.ok ? `posted: ${JSON.stringify(r.body).slice(0, 120)}` : `POST failed: ${r.error}` };
          if (!r.ok) logger.warn(`snapshot POST ${r.status}: ${r.error}`);
        }
      } else report.snapshot = { posted: false, detail: `shadow: not published (GET /api/snapshot through the binding: ${apiSnap.status})` };
      ctx.save();
      report.budget = { ...state.budget.spent };
      return this.finish(report, t0, state, mode);
    } catch (e) {
      report.errors.push(explainRevert(e));
      push("error", `tick failed: ${String((e as Error)?.stack ?? e).slice(0, 600)}`);
      return this.finish(report, t0, null, report.mode);
    } finally {
      this.liveNow = false;
    }
  }

  private async pullResume(ctx: Ctx, state: MakerState, logger: Logger) {
    const pull = this.store.get<string>("pending:pull");
    if (pull) {
      this.store.delete("pending:pull");
      for (const lad of Object.values(state.ladders).filter((l) => l.status !== "closed" && (pull === "all" || l.key === pull))) {
        lad.paused = true;
        ctx.save();
        const r = await killLadder(ctx, lad, "manual pull (control)", { close: false, withdraw: false });
        logger.warn(`${lad.key} pulled: cancelled ${r.cancelled}, left open ${r.leftOpen}; paused until resume`);
      }
    }
    const resume = this.store.get<string>("pending:resume");
    if (resume) {
      this.store.delete("pending:resume");
      if (state.ladders[resume]) (state.ladders[resume].paused = false), ctx.save(), logger.info(`${resume} resumed`);
    }
  }

  private async rolls(ctx: Ctx, mode: Mode, now: number, report: TickReport, logger: Logger): Promise<Set<string>> {
    const rolled = new Set<string>();
    const want: { station: string; isoDate: string; strikes?: number[]; why: string; adoptOnly?: boolean }[] = [];
    const q = this.store.get<NonNullable<ControlDoc["roll"]>>("roll:queue") ?? [];
    if (q.length) this.store.delete("roll:queue");
    for (const r of q) want.push({ station: r.station.toUpperCase(), isoDate: r.date, strikes: r.strikes, why: "control request" });
    for (const icao of this.s.rollAuto ? this.s.stations : []) {
      const st = STATIONS[icao];
      if (!st) continue;
      const today = localDateOf(now * 1000, st.utcOffsetMin);
      const localHHMM = new Date(now * 1000 + st.utcOffsetMin * 60_000).toISOString().slice(11, 16);
      if (localHHMM >= this.s.rollNotBeforeLocal) want.push({ station: icao, isoDate: addDays(today, 1), why: `schedule (>= ${this.s.rollNotBeforeLocal} local)` });
      want.push({ station: icao, isoDate: today, why: "adopt today's on-chain ladder", adoptOnly: true });
    }
    const seen = new Set<string>();
    for (const w of want) {
      const key = ladderKey(w.station, isoToYmd(w.isoDate));
      if (seen.has(key)) continue;
      seen.add(key);
      const lad = ctx.state.ladders[key];
      if (lad && (lad.status === "active" || lad.status === "closed")) continue;
      const last = this.store.get<{ at: number; ok: boolean }>(`roll:last:${mode}:${key}`);
      const every = mode === "live" ? 300 : this.s.shadowRollEverySec;
      if (w.why !== "control request" && last && now - last.at < every) {
        // SHADOW: a ladder it only dry-planned may since have been rolled by the live maker. Adopt the real one (with
        // ITS strikes) as soon as it is on chain, instead of an hour later: one read every SHADOW_ADOPT_EVERY_SEC.
        if (mode !== "shadow" || now - last.at < SHADOW_ADOPT_EVERY_SEC) continue;
        const ids = await read<Hex[]>(ctx, ctx.dep.vault, vaultCommonAbi, "ladderSeries", [station4(w.station), isoToYmd(w.isoDate)]);
        if (!ids.length) continue;
        logger.info(`shadow: ${key} is on chain now (rolled by the live maker): adopting it`);
      }
      if (w.adoptOnly) {
        if (lad) continue;
        // too close to (or past) today's stop time: nothing left to quote, and minting stops at closeTime
        const c = closeFromStats(ctx.closeTimes?.[w.station], w.station, w.isoDate, ctx.cfg.roll.closeMarginMin);
        if (now >= c.stopUtcMs / 1000 - ctx.cfg.policy.preStopSec - 600) continue;
        const ids = await read<Hex[]>(ctx, ctx.dep.vault, vaultCommonAbi, "ladderSeries", [station4(w.station), isoToYmd(w.isoDate)]);
        if (!ids.length) continue; // adopt only: today's ladders are never created from scratch
      }
      logger.info(`roll ${key} (${w.why})`);
      let rep: RollReport;
      try {
        rep = await roll(ctx, { station: w.station, isoDate: w.isoDate, strikes: w.strikes, data: this.data, skipQuotes: true });
      } catch (e) {
        report.errors.push(`roll ${key}: ${explainRevert(e)}`);
        this.store.put(`roll:last:${mode}:${key}`, { at: now, ok: false });
        continue;
      }
      this.store.put(`roll:last:${mode}:${key}`, { at: now, ok: rep.ok });
      if (mode === "shadow" && ctx.state.ladders[key]?.status === "planned") {
        // A dry-run plan of a ladder that is not on chain. It is NOT kept in the shadow state (the Node CLI's
        // `roll --dry-run` never saves it either): a kept plan would freeze the strikes picked from this tick's
        // Polymarket data, and once the live maker rolled the real ladder with other strikes, the shadow would keep
        // planning createSeries for its own strikes and never mirror the real books. The plan is kept for comparison.
        this.forgetLadder("shadow", ctx.state, key);
        this.store.put(`shadow:plan:${key}`, { at: now, strikes: rep.strikes, strikeSource: rep.strikeSource, estimated: rep.estimatedMonByRole });
      }
      report.rolls.push({ key, ok: rep.ok, steps: rep.steps.map((s) => ({ step: s.step, status: s.status, detail: s.detail.slice(0, 300) })), mon: rep.monByRole, estimated: rep.estimatedMonByRole });
      if (rep.ok) rolled.add(key);
      if (!rep.ok) logger.warn(`roll ${key} not complete: ${rep.steps.at(-1)?.detail ?? "?"}`);
    }
    return rolled;
  }

  private async recoverInflight(ctx: Ctx, logger: Logger) {
    for (const a of [ctx.addr.maker, ctx.addr.operator, this.guardian?.address, this.treasuryKey?.address].filter((x): x is Address => !!x)) {
      for (const p of this.nonces.stale(a, 5_000)) {
        try {
          const r = await ctx.pub.getTransactionReceipt({ hash: p.hash });
          this.nonces.mined(a, p.nonce, p.hash);
          logger.warn(`in-flight tx ${p.label} (${p.hash}) from an interrupted tick landed (${r.status}); the reconcile step adopts any orders it placed`);
        } catch {
          if (this.now() - p.at > 300_000) {
            this.nonces.forget(a, p.nonce);
            logger.warn(`in-flight tx ${p.label} (${p.hash}) has no receipt after 5 min: forgotten (nonce falls back to the chain)`);
          }
        }
      }
    }
  }

  private async watch(ctx: Ctx, mode: Mode, report: TickReport, alert: (t: string, b: string) => void, logger: Logger, force: boolean): Promise<TickReport["watcher"]> {
    const lastAt = this.store.get<number>("watch:lastAt") ?? 0;
    if (!force && this.now() - lastAt < this.s.watchEverySec * 1000) return { skipped: `next pass in ${Math.round((this.s.watchEverySec * 1000 - (this.now() - lastAt)) / 1000)}s` };
    if (!force && report.txs.some((t) => /createLadder|createSeries|deployProxy|mintSet|margin/.test(t.label))) return { skipped: "this tick broadcast a roll; the watcher runs next tick" };
    try {
      const w = await watchPass({
        pub: ctx.pub,
        store: this.store,
        resolver: this.dep.resolver,
        vault: this.dep.vault,
        stations: Object.keys((deploymentsJson as any).stations ?? {}),
        liveRpc: this.s.rpcIsLive,
        liveGuardian: (this.dep.roles.guardian ?? "0x0000000000000000000000000000000000000000") as Address,
        live: mode === "live",
        guardian: this.guardian,
        autoChallenge: this.s.watchAutoChallenge,
        lookbackBlocks: this.s.watchLookbackBlocks,
        recheckSec: this.s.watchRecheckSec,
        backstopSec: this.s.watchBackstopSec,
        gasMult: ctx.cfg.gas.opMult,
        sources: this.sources,
        wallet: ctx.wallet!,
        nonces: this.nonces,
        operator: this.watchOnly ? null : this.operator,
        liveOperator: this.dep.roles.operator,
        overdueSec: this.s.settleOverdueSec,
        overdueRepeatSec: this.s.settleOverdueRepeatSec,
        autoStaleVoid: this.s.autoStaleVoid,
        onVoidTx: (t) => {
          // same log and operator meter as the shared send() path (Monad bills the gas limit)
          this.store.append(`txs:${mode}`, { t: new Date(this.now()).toISOString(), role: t.role, from: t.from, label: t.label, kind: "void", hash: t.hash, nonce: t.nonce, block: t.block, gasUsed: t.gasUsed, gasLimit: t.gasLimit, mon: +t.mon.toFixed(6), status: t.status }, 3000);
          report.txs.push({ label: t.label, role: t.role, hash: t.hash, mon: +t.mon.toFixed(6), status: t.status });
          recordSpend(ctx.state.budget, "operator", t.mon, Date.now(), budgetCfgOf(ctx.cfg), "void");
        },
        alert,
        log: (m) => logger.info(`watch: ${m}`),
        sleep: this.sleep,
        now: this.now,
      });
      this.store.put("watch:lastAt", this.now());
      return { ...w, verdicts: w.verdicts.map((v) => ({ key: v.key, verdict: v.verdict, detail: (v.action ? `${v.action}; ` : "") + v.detail.slice(0, 200) })) };
    } catch (e) {
      report.errors.push(`watcher: ${explainRevert(e)}`);
      return { skipped: `error: ${explainRevert(e)}` };
    }
  }

  /** The treasury top-up pass (src/treasury.ts), every treasury.everySec. Runs with or without TREASURY_KEY: the
   *  balance checks and the LOW alerts work without it; only live mode with a valid key sends. */
  private async treasury(ctx: Ctx, mode: Mode, report: TickReport, alert: (t: string, b: string) => void, logger: Logger, force: boolean): Promise<TickReport["treasury"]> {
    let cfg;
    try {
      cfg = parseTreasuryCfg((ctx.cfg as unknown as { treasury?: unknown }).treasury);
    } catch (e) {
      report.errors.push(`treasury config: ${String((e as Error).message).slice(0, 200)}`);
      return { skipped: `config invalid: ${String((e as Error).message).slice(0, 200)}` };
    }
    if (!cfg) return { skipped: "no treasury config" };
    const lastAt = this.store.get<number>("treasury:lastAt") ?? 0;
    if (!force && this.now() - lastAt < cfg.everySec * 1000) return { skipped: `next pass in ${Math.round((cfg.everySec * 1000 - (this.now() - lastAt)) / 1000)}s` };
    this.store.put("treasury:lastAt", this.now());
    const forbidden = [this.dep.roles.owner, this.maker?.address, this.operator?.address, this.guardian?.address].filter((x): x is Address => !!x && /^0x[0-9a-fA-F]{40}$/.test(x));
    const r = await treasuryPass({
      pub: ctx.pub,
      store: this.store,
      cfg,
      live: mode === "live" && this.liveNow,
      key: this.treasuryKey,
      liveRpc: this.s.rpcIsLive,
      liveTreasury: BUNDLED_TREASURY,
      forbidden,
      wallet: ctx.wallet!,
      chain: this.chain,
      nonces: this.nonces,
      dayUtcOffsetMin: ctx.cfg.budget.dayUtcOffsetMin,
      onTx: (t) => {
        this.store.append(`txs:${mode}`, { t: new Date(this.now()).toISOString(), role: "treasury", from: t.from, to: t.to, label: t.label, kind: "topup", hash: t.hash, nonce: t.nonce, block: t.block, gasUsed: TRANSFER_GAS_STR, gasLimit: t.gasLimit, mon: +t.gasMon.toFixed(6), valueMon: t.valueMon, status: t.status }, 3000);
        report.txs.push({ label: t.label, role: "treasury", hash: t.hash, mon: +t.gasMon.toFixed(6), status: t.status });
      },
      alert,
      log: (m) => logger.info(m),
      sleep: this.sleep,
      now: this.now,
    });
    if (this.treasuryKeyError) (r.treasury.key = this.treasuryKeyError), this.store.put("treasury:last", r);
    return r;
  }

  /**
   * SHADOW: the live maker's quotes are on the books, but its `lastQuote` (the fair it quoted at, and when) is not, and
   * the shared policy uses it for two re-quote reasons: "fair moved >= requoteTicks since the quote" and "quote older
   * than staleHours". Without it the shadow could never predict those re-quotes. Mirror it per strike whenever the
   * tracked orders change: `at` = the live maker's published `lastQuoteAt` when its published quote is the one on the
   * books (else the time the shadow first saw the orders); `fair` = the shadow's own fair at that tick (the live maker's
   * fair at quote time is not published, so for orders placed before the shadow started this is an approximation).
   */
  private mirrorLastQuotes(state: MakerState, ticks: Map<string, LadderTick>, rec: (ReconcileResult & { key: string })[], apiSnap: { ok: boolean; body?: any }, now: number) {
    const mac = new Map<string, any>();
    if (apiSnap?.ok && Array.isArray(apiSnap.body?.ladders))
      for (const l of apiSnap.body.ladders) for (const s of l.strikes ?? []) mac.set(`${l.station}:${l.date}:${s.k}`, s);
    for (const lad of Object.values(state.ladders)) {
      if (lad.status !== "active") continue;
      const t = ticks.get(lad.key);
      for (const k of lad.strikes) {
        const s = lad.series[k];
        if (!s || (!s.orders.bid && !s.orders.ask)) continue;
        const bid = s.orders.bid?.price ?? null, ask = s.orders.ask?.price ?? null;
        const m = mac.get(`${lad.station}:${lad.date}:${k}`);
        const macAt = m && typeof m.lastQuoteAt === "number" && (m.bid ?? null) === bid && (m.ask ?? null) === ask ? (m.lastQuoteAt as number) : null;
        const adopted = rec.some((r) => r.key === lad.key && r.strike === k && (r.adopted.bid !== undefined || r.adopted.ask !== undefined));
        const fair = t?.fairs.find((f) => f.k === k)?.fair ?? null;
        if (!s.lastQuote || adopted || s.lastQuote.bid !== bid || s.lastQuote.ask !== ask) {
          if (fair === null && !s.lastQuote) continue;
          s.lastQuote = { fair: fair ?? s.lastQuote!.fair, bid, ask, bidSize: s.orders.bid?.size ?? 0, askSize: s.orders.ask?.size ?? 0, at: macAt ?? now, tx: "0x" as Hex };
        } else if (macAt !== null && s.lastQuote.at !== macAt) s.lastQuote.at = macAt;
      }
    }
  }

  // ------------------------------------------------------------------ report, comparison, outbox
  private views(state: MakerState, ticks: Map<string, LadderTick>, apiSnap: { ok: boolean; body?: any } | null): LadderView[] {
    const mac = new Map<string, any>();
    if (apiSnap?.ok && Array.isArray(apiSnap.body?.ladders))
      for (const l of apiSnap.body.ladders) for (const s of l.strikes ?? []) mac.set(`${l.station}:${l.date}:${s.k}`, s);
    const out: LadderView[] = [];
    for (const lad of Object.values(state.ladders)) {
      if (lad.status === "closed" && !ticks.has(lad.key)) continue;
      const t = ticks.get(lad.key);
      const ml = apiSnap?.ok && Array.isArray(apiSnap.body?.ladders) ? apiSnap.body.ladders.find((x: any) => `${x.station}:${x.date}` === `${lad.station}:${lad.date}`) : undefined;
      out.push({
        key: lad.key,
        status: lad.status,
        paused: !!lad.paused,
        stopAt: lad.stopAt,
        ...(t?.data
          ? { data: { pmFetchedAt: t.data.pm?.fetchedAt ?? null, v0Mu: t.data.v0?.mu ?? null, v0FetchedAt: t.data.v0?.fetchedAt ?? null, obsMaxC: t.data.obs?.tmaxC ?? null, ...(ml ? { macV0Mu: ml.forecastMu ?? null } : {}) } }
          : {}),
        strikes: lad.strikes.map((k) => {
          const v = t?.strikes.find((x) => x.strike === k);
          const a = t?.actions.find((x) => x.strike === k);
          const d = v?.desired;
          const m = mac.get(`${lad.station}:${lad.date}:${k}`);
          return {
            k,
            fair: v?.fair?.fair ?? null,
            source: v?.fair?.source ?? null,
            guard: v?.fair?.guard ?? null,
            flags: v?.fair?.flags ?? [],
            desired: d ? (d.pull ? { pull: d.reasons } : { bid: d.bid, ask: d.ask, bidSize: d.bidSize, askSize: d.askSize }) : null,
            resting: { bid: v?.resting.bid?.price ?? null, ask: v?.resting.ask?.price ?? null },
            action: v?.action?.kind ?? null,
            reasons: v?.action?.reasons ?? [],
            ...(a?.error ? { error: a.error } : {}),
            mac: apiSnap ? (m ? { fair: m.fair ?? null, guard: m.model ?? null, bid: m.bid ?? null, ask: m.ask ?? null, mode: m.mode ?? null, action: m.action ?? null, lastQuoteAt: m.lastQuoteAt ?? null } : null) : undefined,
          };
        }),
      });
    }
    return out;
  }

  private summarize(report: TickReport) {
    const s =
      this.store.get<ShadowSummary>("shadow:summary") ??
      ({ since: report.at, ticks: 0, liveTicks: 0, lastTickAt: null, actions: {}, intents: {}, intentMon: {}, rolls: 0, kills: 0, errors: 0, alerts: 0, compare: { n: 0, fairAbsDiffSum: 0, fairAbsDiffMax: 0, restingMatchesDesired: 0, wouldChange: 0, macMissing: 0 }, recentDiffs: [] } as ShadowSummary);
    s.ticks++;
    if (report.mode === "live") s.liveTicks++;
    s.lastTickAt = report.at;
    s.errors += report.errors.length;
    s.alerts += report.alerts.length;
    s.rolls += report.rolls.length;
    s.kills += report.kill.length;
    for (const i of report.intents) {
      const kind = i.label.split(" ")[0];
      if (i.repeat) {
        s.intentRepeats = (s.intentRepeats ?? 0) + 1;
        continue;
      }
      s.intents[kind] = (s.intents[kind] ?? 0) + 1;
      s.intentMon[i.role] = +((s.intentMon[i.role] ?? 0) + i.costMon).toFixed(6);
    }
    for (const l of report.ladders)
      for (const k of l.strikes) {
        if (k.action) s.actions[k.action] = (s.actions[k.action] ?? 0) + 1;
        if (report.mode !== "shadow" || k.mac === undefined) continue;
        if (k.mac === null) {
          s.compare.macMissing++;
          continue;
        }
        s.compare.n++;
        if (k.fair !== null && k.mac.fair !== null) {
          const d = Math.abs(k.fair - k.mac.fair);
          s.compare.fairAbsDiffSum = +(s.compare.fairAbsDiffSum + d).toFixed(6);
          s.compare.fairAbsDiffMax = Math.max(s.compare.fairAbsDiffMax, +d.toFixed(4));
        }
        if (k.action === "none") s.compare.restingMatchesDesired++;
        else if (k.action) {
          s.compare.wouldChange++;
          const desired = k.desired && "pull" in k.desired ? `pull (${k.desired.pull[0] ?? ""})` : k.desired ? `${k.desired.bid ?? "-"}/${k.desired.ask ?? "-"}` : "-";
          s.recentDiffs = [...s.recentDiffs, { at: report.at, key: l.key, k: k.k, shadowFair: k.fair, macFair: k.mac.fair, shadowAction: k.action, desired, macResting: `${k.mac.bid ?? "-"}/${k.mac.ask ?? "-"}` }].slice(-30);
        }
      }
    this.store.put("shadow:summary", s);
    return s;
  }

  status(report: TickReport | null, mode: Mode) {
    const cs = this.control();
    const st = this.loadState(mode);
    return {
      worker: "isotherm-maker",
      version: this.deps.version ?? null,
      mode: report?.mode ?? mode,
      envMode: this.s.envMode,
      liveFlag: cs.live,
      reasons: report?.reasons ?? [],
      control: { seq: cs.seq, armedAt: cs.armedAt ?? null, disarmedAt: cs.disarmedAt ?? null, last: cs.history.at(-1) ?? null },
      keys: { maker: this.maker?.address ?? null, operator: this.operator?.address ?? null, guardian: this.guardian?.address ?? null, snapshotToken: !!this.deps.keys.snapshotToken, watchOnly: this.watchOnly },
      rpc: { kind: this.s.rpcIsLive ? "monad-testnet public RPCs" : "loopback fork", endpoints: this.rpc ? this.rpc.status().map((e) => ({ host: e.host, verified: e.verified, coolingDown: e.coolingDownUntil !== null && e.coolingDownUntil > this.now(), requests: e.requests, retries: e.retries, rateLimited: e.rateLimited, errors: e.errors, lastError: e.lastError })) : this.s.rpcs.map((u) => ({ host: hostOf(u) })), rps: this.s.rpcRps },
      stations: this.s.stations,
      lastTick: report ? { at: report.at, ms: report.ms, mode: report.mode, block: report.block, errors: report.errors.length, alerts: report.alerts, intents: report.intents.length, txs: report.txs.length } : null,
      budget: { ...st.budget, tier: (() => {
        try {
          const c = workerConfig(this.s, mode);
          const ti = quotingTier(structuredClone(st.budget), "maker", "quote", budgetCfgOf(c), this.now());
          return { tier: ti.tier, spent: +ti.spent.toFixed(4), cap: ti.cap, soft: ti.soft, reserve: +(st.budget.spent["maker:reserve"] ?? 0).toFixed(4), reserveLine: c.budget.reserveMon.maker };
        } catch {
          return null;
        }
      })() },
      treasury: (() => {
        const t = this.store.get<TreasuryReport>("treasury:last");
        return t ? { at: t.at, mode: t.mode, address: t.treasury.address, mon: t.treasury.mon, key: t.treasury.key, balances: t.balances, today: t.meter, actions: t.actions, alerts: t.alerts } : { key: this.treasuryKey ? "set (no pass yet)" : "no TREASURY_KEY secret (balance checks and LOW alerts only)" };
      })(),
      ladders: Object.values(st.ladders).map((l) => ({ key: l.key, status: l.status, paused: !!l.paused, stopAt: new Date(l.stopAt * 1000).toISOString(), strikes: l.strikes.map((k) => `${k}:${l.series[k]?.mode ?? "-"}${l.series[k]?.orders.bid ? ` b${l.series[k].orders.bid!.price}` : ""}${l.series[k]?.orders.ask ? ` a${l.series[k].orders.ask!.price}` : ""}`) })),
      alerts: this.store.tail<{ at: string; title: string }>("alerts", 5).map((a) => `${a.at} ${a.title}`),
      push: this.hook ? { channel: this.hook.kind, auth: this.hook.token ? "ALERT_WEBHOOK_TOKEN (bearer header)" : this.hook.kind === "ntfy" && /[?&]auth=/.test(this.hook.url) ? "auth query parameter" : "none", last: pushLog(this.store, 5) } : { channel: this.hookError ? `invalid ALERT_WEBHOOK_URL, ignored (${this.hookError})` : "off (no ALERT_WEBHOOK_URL secret)" },
      watcher: (() => {
        const w = this.store.get<{ lastBlock: number; results: Record<string, { verdict: string }>; overdue?: Record<string, { dayEnd: number; firstAt: number; alerts: number }>; voids?: Record<string, { at: number; outcome: string; hash?: string }> }>("watch:state");
        return w
          ? {
              lastBlock: w.lastBlock,
              verdicts: Object.fromEntries(Object.entries(w.results).slice(-10).map(([k, v]) => [k, v.verdict])),
              overdue: Object.fromEntries(Object.entries(w.overdue ?? {}).map(([k, v]) => [k, { dayEnd: new Date(v.dayEnd * 1000).toISOString(), since: new Date(v.firstAt * 1000).toISOString(), alerts: v.alerts }])),
              staleVoids: Object.fromEntries(Object.entries(w.voids ?? {}).map(([k, v]) => [k, { at: new Date(v.at * 1000).toISOString(), outcome: v.outcome, ...(v.hash ? { hash: v.hash } : {}) }])),
            }
          : null;
      })(),
    };
  }

  private async finish(report: TickReport, t0: number, _state: MakerState | null, mode: Mode): Promise<TickReport> {
    // the optional push channel: rate-limited per title, 5 s timeout, never breaks the tick
    if (this.hook && this.pushQueue.length) {
      const f = this.deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
      report.push = await pushAlerts({ store: this.store, hook: this.hook, minSec: this.s.alertPushMinSec, now: this.now, fetch: f as typeof fetch, timeoutMs: this.deps.pushTimeoutMs }, this.pushQueue);
      for (const p of report.push) if (!/^sent|^rate-limited/.test(p.result)) this.deps.log?.("warn", `alert push "${p.title.slice(0, 80)}": ${p.result}`);
    }
    this.pushQueue = [];
    report.ms = this.now() - t0;
    this.store.put("tick:last", report);
    this.store.append("ticks", { at: report.at, ms: report.ms, mode: report.mode, block: report.block, intents: report.intents.length, txs: report.txs.length, errors: report.errors.length, alerts: report.alerts.length, kill: report.kill.length, rolls: report.rolls.map((r) => `${r.key}:${r.ok}`), actions: report.ladders.flatMap((l) => l.strikes.map((k) => `${l.key}>=${k.k}:${k.action ?? "-"}`)) }, 5000);
    this.store.append("ticks:detail", tickLine(report), 1440);
    const summary = this.summarize(report);
    if (this.deps.kv) {
      const kv = this.deps.kv;
      await Promise.all([
        kv.put("status", stringify(this.status(report, mode))),
        kv.put("tick:last", stringify(report)),
        kv.put("ticks:recent", stringify(this.store.tail("ticks:detail", TICK_LINES_KV))),
        kv.put("shadow:summary", stringify(summary)),
        ...(report.alerts.length ? [kv.put("alerts", stringify(this.store.tail("alerts", 50)))] : []),
      ]).catch((e) => this.deps.log?.("warn", `KV outbox write failed: ${String(e).slice(0, 160)}`));
    }
    return report;
  }

  /** Milliseconds until the next tick: TICK_SEC after the START of the tick that just ran (`elapsedMs` ago), so ticks
   *  keep a fixed period like the Mac's loop instead of drifting by the tick duration; sooner if a ladder's
   *  kill-switch time falls in between. */
  nextDelayMs(elapsedMs = 0): number {
    const base = this.s.tickSec * 1000;
    const cfg = workerConfig(this.s, "shadow");
    let next = Math.max(0, base - Math.max(0, elapsedMs));
    const t = this.now();
    for (const mode of ["live", "shadow"] as Mode[])
      for (const [, lad] of this.store.list<LadderState>(`state:${mode}:ladder:`)) {
        if (lad.status === "closed") continue;
        const killAt = (lad.stopAt - cfg.policy.preStopSec) * 1000;
        if (killAt > t && killAt - t < next) next = killAt - t + 500;
      }
    return Math.max(2_000, next);
  }
}

const fmt = (b: number | null | undefined, a: number | null | undefined) => `${b ?? "-"}/${a ?? "-"}`;
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** The compact per-tick line (decisions per strike, what was or would have been sent) for the operator's history. */
export function tickLine(r: TickReport): TickLine {
  return {
    at: r.at,
    ms: r.ms,
    mode: r.mode,
    block: r.block,
    intents: r.intents.map((i) => `${i.role} ${i.label} ~${i.costMon} MON${i.repeat ? " (repeat, not metered)" : ""}`),
    txs: r.txs.map((t) => `${t.role} ${t.label} ${t.mon} MON ${t.status}`),
    errors: r.errors.map((e) => e.slice(0, 200)),
    alerts: r.alerts,
    kill: r.kill.map((k) => `${k.key} ${k.mode} cancelled ${k.cancelled} left ${k.leftOpen}`),
    rolls: r.rolls.map((x) => `${x.key} ok=${x.ok} ${x.steps.find((s) => s.step === "plan")?.detail.slice(0, 80) ?? ""}`),
    ...(r.treasury && "actions" in r.treasury ? { treasury: r.treasury.actions.map((a) => `${a.role} ${a.balanceMon} MON -> ${a.amountMon} ${a.outcome}${a.hash ? ` ${a.hash}` : ""}`) } : {}),
    strikes: r.ladders.flatMap((l) =>
      l.strikes.map((s) => ({
        key: l.key,
        k: s.k,
        fair: s.fair,
        guard: s.guard,
        flags: s.flags,
        action: s.action,
        desired: s.desired === null ? "-" : "pull" in s.desired ? "pull" : fmt(s.desired.bid, s.desired.ask),
        resting: fmt(s.resting.bid, s.resting.ask),
        reasons: s.reasons.join("; ").slice(0, 160),
        mac: s.mac === undefined ? null : s.mac === null ? "missing" : { fair: s.mac.fair, guard: s.mac.guard, quote: fmt(s.mac.bid, s.mac.ask), mode: s.mac.mode },
      })),
    ),
  };
}
