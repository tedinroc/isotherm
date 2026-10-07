// Chain context: clients, role keys (never printed), and the one tx sender every write goes through:
//   live guard -> eth_call simulate (decoded revert) -> estimate -> limit = ceil(est x mult) -> MON budget check
//   -> balance check -> send -> report the hash immediately (resumable roll) -> receipt -> meter what was billed.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  formatEther,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { ERROR_ABIS } from "./abis.ts";
import { canSpend, recordSpend, type SpendKind } from "./budget.ts";
import type { MakerConfig, Role } from "./config.ts";
import type { Deployment } from "./deployment.ts";
import type { MakerState } from "./state.ts";

export class LiveRefused extends Error {}
export class BudgetRefused extends Error {}
export class TxReverted extends Error {
  hash?: Hex;
  constructor(msg: string, hash?: Hex) {
    super(msg);
    this.hash = hash;
  }
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export function makeLogger(file: string | null, quiet = false): Logger {
  if (file) mkdirSync(dirname(file), { recursive: true });
  const w = (level: string) => (msg: string, extra?: Record<string, unknown>) => {
    const line = { t: new Date().toISOString(), level, msg, ...(extra ?? {}) };
    if (file) appendFileSync(file, JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
    // logs go to stderr so command output on stdout stays machine-readable JSON
    if (!quiet || level !== "info") console.error(`${line.t.slice(11, 19)} ${level === "info" ? "" : level.toUpperCase() + " "}${msg}`);
  };
  return { info: w("info"), warn: w("warn"), error: w("error") };
}

export function loadKey(keysDir: string, name: string): PrivateKeyAccount | null {
  const f = join(keysDir, `${name}.key`);
  if (!existsSync(f)) return null;
  const raw = readFileSync(f, "utf8").trim();
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}

export interface Ctx {
  cfg: MakerConfig;
  dep: Deployment;
  pub: PublicClient;
  chain: typeof monadTestnet;
  rpc: string;
  isAnvil: boolean;
  clientVersion: string;
  accounts: Record<Role, PrivateKeyAccount>;
  addr: Record<Role, Address>;
  keyNames: Record<Role, string>;
  state: MakerState;
  save(): void;
  log: Logger;
  gasPriceWei?: bigint;
  txLogFile: string;
}

export function explainRevert(e: unknown): string {
  const seen = new Set<unknown>();
  const find = (x: any): Hex | undefined => {
    if (!x || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (typeof x.data === "string" && x.data.startsWith("0x") && x.data.length >= 10) return x.data as Hex;
    if (typeof x.data === "object" && typeof x.data?.data === "string") return x.data.data as Hex;
    return find(x.cause) ?? find(x.error);
  };
  const data = find(e);
  if (data) {
    for (const abi of ERROR_ABIS) {
      try {
        const d = decodeErrorResult({ abi: abi as Abi, data });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {}
    }
    return `revert data ${data.slice(0, 74)}`;
  }
  const m = (e as any)?.shortMessage ?? (e as any)?.message ?? String(e);
  return String(m).split("\n")[0];
}

export function makeClients(rpc: string) {
  const chain = { ...monadTestnet, rpcUrls: { default: { http: [rpc] } } } as typeof monadTestnet;
  const transport = http(rpc, { retryCount: 3, retryDelay: 600, timeout: 45_000 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  return { chain, transport, pub };
}

/** Chain time (latest block) vs wall clock: use the later one. The vault enforces closeTime against block.timestamp. */
export async function nowSec(ctx: Pick<Ctx, "pub">): Promise<number> {
  const b = await ctx.pub.getBlock({ blockTag: "latest" });
  return Math.max(Math.floor(Date.now() / 1000), Number(b.timestamp));
}

export interface SendReq {
  to: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}
export interface SendOpts {
  label: string;
  kind: SpendKind;
  mult?: number;
  onHash?: (hash: Hex, nonce: number) => void;
  fixedGas?: bigint;
}
export type SendResult =
  | { dryRun: false; receipt: TransactionReceipt; hash: Hex; gasLimit: bigint; costMon: number; overBudget: boolean }
  | { dryRun: true; gasLimit: bigint; costMon: number; estimate: bigint };

let sendChain: Promise<unknown> = Promise.resolve();

/** Serialised (one in-flight tx per process): avoids nonce races between the tick and the kill switch. */
export function send(ctx: Ctx, role: Role, req: SendReq, opts: SendOpts): Promise<SendResult> {
  const run = sendChain.then(() => sendInner(ctx, role, req, opts));
  sendChain = run.catch(() => undefined);
  return run;
}

async function gasPrice(ctx: Ctx): Promise<bigint> {
  if (ctx.cfg.gas.fixedGasPriceGwei) return BigInt(Math.round(ctx.cfg.gas.fixedGasPriceGwei * 1e9));
  if (!ctx.gasPriceWei) ctx.gasPriceWei = await ctx.pub.getGasPrice();
  return ctx.gasPriceWei;
}

async function sendInner(ctx: Ctx, role: Role, req: SendReq, opts: SendOpts): Promise<SendResult> {
  const account = ctx.accounts[role];
  if (!ctx.isAnvil && !ctx.cfg.allowLive && !ctx.cfg.dryRun)
    throw new LiveRefused(`refusing to broadcast "${opts.label}" to ${ctx.rpc} (not anvil): set ISOTHERM_ALLOW_LIVE=1 for the go-live step, or use --dry-run`);
  const data = encodeFunctionData({ abi: req.abi as Abi, functionName: req.functionName, args: req.args ?? [] } as any);
  try {
    await ctx.pub.call({ account, to: req.to, data, value: req.value });
  } catch (e) {
    throw new TxReverted(`${opts.label}: would revert -> ${explainRevert(e)}`);
  }
  let est: bigint;
  try {
    est = await ctx.pub.estimateGas({ account, to: req.to, data, value: req.value });
  } catch (e) {
    throw new TxReverted(`${opts.label}: estimateGas failed -> ${explainRevert(e)}`);
  }
  const mult = opts.mult ?? (role === "maker" ? ctx.cfg.gas.makerMult : ctx.cfg.gas.opMult);
  const gasLimit = opts.fixedGas ?? BigInt(Math.ceil(Number(est) * mult));
  const gp = await gasPrice(ctx);
  const costMon = Number(formatEther(gasLimit * gp));
  const nowMs = Date.now();
  const bc = { dayUtcOffsetMin: ctx.cfg.budget.dayUtcOffsetMin, dailyCapMon: ctx.cfg.budget.dailyCapMon, reserveMon: ctx.cfg.budget.reserveMon };
  const dec = canSpend(ctx.state.budget, role, costMon, opts.kind, bc, nowMs);
  if (!dec.ok) throw new BudgetRefused(`${opts.label}: ${dec.reason}`);
  if (ctx.cfg.dryRun) {
    ctx.log.info(`[dry-run] ${role} ${opts.label}: est ${est} limit ${gasLimit} ~${costMon.toFixed(4)} MON`);
    return { dryRun: true, gasLimit, costMon, estimate: est };
  }
  const bal = await ctx.pub.getBalance({ address: account.address });
  const minBal = BigInt(Math.round(ctx.cfg.budget.minBalanceMon * 1e18));
  if (bal < gasLimit * gp + minBal) throw new BudgetRefused(`${opts.label}: ${role} ${account.address} holds ${formatEther(bal)} MON, needs ${costMon.toFixed(4)} + ${ctx.cfg.budget.minBalanceMon} reserve`);
  const wallet = createWalletClient({ chain: ctx.chain, transport: http(ctx.rpc, { retryCount: 1, timeout: 45_000 }), account });
  const nonce = await ctx.pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const t0 = Date.now();
  const hash = await wallet.sendTransaction({ account, chain: ctx.chain, to: req.to, data, value: req.value, gas: gasLimit, nonce } as any);
  opts.onHash?.(hash, nonce);
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: 400, timeout: 180_000 });
  const billed = Number(formatEther(gasLimit * receipt.effectiveGasPrice));
  recordSpend(ctx.state.budget, role, billed, Date.now(), bc);
  const line = { t: new Date().toISOString(), role, from: account.address, label: opts.label, kind: opts.kind, hash, nonce, block: receipt.blockNumber, gasUsed: receipt.gasUsed, gasLimit, mon: +billed.toFixed(6), ms: Date.now() - t0, status: receipt.status, overBudget: dec.overBudget };
  mkdirSync(dirname(ctx.txLogFile), { recursive: true });
  appendFileSync(ctx.txLogFile, JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
  ctx.log.info(`tx ${role.padEnd(13)} ${opts.label.padEnd(48)} used ${String(receipt.gasUsed).padStart(8)} limit ${String(gasLimit).padStart(8)} ${billed.toFixed(4)} MON ${Date.now() - t0}ms ${hash.slice(0, 12)}…`);
  ctx.save();
  if (receipt.status !== "success") throw new TxReverted(`${opts.label} reverted on-chain`, hash);
  return { dryRun: false, receipt, hash, gasLimit, costMon: billed, overBudget: dec.overBudget };
}

export async function read<T = any>(ctx: Pick<Ctx, "pub">, address: Address, abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
  return ctx.pub.readContract({ address, abi: abi as Abi, functionName, args } as any) as Promise<T>;
}
