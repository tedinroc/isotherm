// Shared plumbing for the command classes (kept out of a base class: PluginCommand seals its lifecycle).
import { CommandError, InputFieldType, type CommandIO } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, maxUint256, type Abi, type Address, type Hex } from "viem";
import { abiFunction, asAddress, CITIES, loadDeployment, resolveCity, type City, type Deployment } from "./config.js";
import { makeReader, selectedAddress, type HostCtx, type Reader } from "./chain.js";
import { contracts, listLadderRefs, readLadder, type Contracts, type Ladder, type Series } from "./isotherm.js";
import { erc20Abi, orderBookAbi, marginAccountAbi, kuruRouterAbi } from "./kuru.js";
import { TxRunner, type Executor } from "./exec.js";
import { parseDateArg } from "./weather.js";
import { shortErr } from "./util.js";

export const PLUGIN_VERSION = "0.1.0";

// ------------------------------------------------------------------------------------------- input fields
export const F = {
  city: (index = 0, required = true) =>
    ({ type: InputFieldType.Text, flag: "city", message: `City: ${Object.keys(CITIES).join(" | ")} (or the ICAO station)`, required, index, prompt: required }) as const,
  date: () =>
    ({ type: InputFieldType.Text, flag: "date", message: "Station-local date: today | tomorrow | YYYY-MM-DD (default: the nearest open ladder)", required: false, prompt: false }) as const,
  rpc: () => ({ type: InputFieldType.Text, flag: "rpc", message: "Monad testnet RPC URL for reads (default: mm's customEvmChains[10143] RPC, else the public RPC)", required: false, prompt: false }) as const,
  address: () => ({ type: InputFieldType.Text, flag: "address", message: "Wallet to read (default: the selected mm wallet)", required: false, prompt: false }) as const,
  strike: () => ({ type: InputFieldType.Text, flag: "strike", message: "Strike k in integer °C (the series 'Tmax >= k')", required: true, prompt: true }) as const,
  side: () =>
    ({
      type: InputFieldType.Select,
      flag: "side",
      message: "Outcome side",
      required: true,
      options: [
        { value: "yes", label: "YES (pays 1 AUSD iff Tmax >= k)" },
        { value: "no", label: "NO (pays 1 AUSD iff Tmax < k)" },
      ],
    }) as const,
  market: () => ({ type: InputFieldType.Text, flag: "market", message: "Kuru market address (only needed when the deployment lists none; must still pass the canonical-book check)", required: false, prompt: false }) as const,
  slippage: () => ({ type: InputFieldType.Text, flag: "slippage-bps", message: "Extra tolerance below the book-walk output, in bps (default 50)", required: false, prompt: false }) as const,
  gasMult: () => ({ type: InputFieldType.Text, flag: "gas-mult", message: "Gas limit = estimate x this (Monad bills the limit; default 1.10, book takes 1.25)", required: false, prompt: false }) as const,
  dryRun: () => ({ type: InputFieldType.Boolean, flag: "dry-run", message: "Plan only: print the book walk, min-out guards and steps; sign nothing", required: false, prompt: false }) as const,
  approve: () =>
    ({ type: InputFieldType.Text, flag: "approve", message: "Token approval size: exact (default) | max", required: false, prompt: false }) as const,
};

// ------------------------------------------------------------------------------------------- errors
export function fail(code: string, message: string, hint: string): never {
  throw new CommandError(code, message, hint || "See `mm weather doctor`.");
}

export function needCity(raw: unknown): City {
  const c = resolveCity(String(raw ?? ""));
  if (!c) fail("ISOTHERM_UNKNOWN_CITY", `Unknown city '${String(raw)}'.`, `Use one of: ${Object.keys(CITIES).join(", ")}.`);
  return c as City;
}

export function optAddress(raw: unknown, what = "address"): Address | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  try {
    return asAddress(String(raw), what);
  } catch (e) {
    return fail("ISOTHERM_BAD_ADDRESS", shortErr(e), "Pass a 0x-prefixed 20-byte address.");
  }
}

export function intArg(raw: unknown, what: string): number {
  const s = String(raw ?? "").trim();
  if (!/^-?\d+$/.test(s)) fail("ISOTHERM_BAD_INPUT", `${what} '${s}' must be an integer.`, `Example: --${what} 28`);
  return Number(s);
}

export function numArg(raw: unknown, what: string, def: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(String(raw));
  if (!Number.isFinite(n) || n < min || n > max) fail("ISOTHERM_BAD_INPUT", `${what} '${String(raw)}' must be a number in [${min}, ${max}].`, `Omit ${what} for the default ${def}.`);
  return n;
}

// ------------------------------------------------------------------------------------------- setup
export type Env = {
  dep: Deployment;
  c: Contracts;
  reader: Reader;
  self?: Address;
  selfSource: string;
  /** latest block timestamp: on-chain state (open/closed/redeemable) is judged by chain time, not the wall clock */
  nowS: number;
};

export async function setupEnv(ctx: HostCtx, rpc: unknown, address?: unknown): Promise<Env> {
  let dep: Deployment;
  try {
    dep = loadDeployment();
  } catch (e) {
    return fail("ISOTHERM_DEPLOYMENT", `Cannot load the Isotherm deployment: ${shortErr(e)}`, "Unset ISOTHERM_DEPLOYMENTS or point it at a valid deployments JSON.");
  }
  let reader: Reader;
  try {
    reader = await makeReader(ctx, rpc ? String(rpc) : undefined);
  } catch (e) {
    return fail("ISOTHERM_NO_RPC", shortErr(e), "Pass --rpc https://testnet-rpc.monad.xyz (or your own Monad testnet RPC).");
  }
  const flagAddr = optAddress(address);
  const sel = flagAddr ? { address: flagAddr, source: "flag" } : selectedAddress(ctx);
  let nowS = Math.floor(Date.now() / 1000);
  try {
    nowS = Number((await reader.client.getBlock({ blockTag: "latest" })).timestamp);
  } catch {}
  return { dep, c: contracts(dep), reader, self: sel.address, selfSource: sel.source, nowS };
}

export function envSummary(env: Env) {
  return {
    deployment: env.dep.label,
    abiSet: env.dep.abiSet,
    vault: env.dep.vault,
    zap: env.dep.zap ?? null,
    rpcSource: env.reader.source,
    ...(env.reader.rpcUrl ? { rpcUrl: env.reader.rpcUrl } : {}),
    ...(env.reader.notes.length ? { rpcNotes: env.reader.notes } : {}),
  };
}

/**
 * Find the ladder for (city, date). With no date: the open ladder with the earliest close; if none is open,
 * the most recent ladder for that station.
 */
export async function findLadder(env: Env, city: City, rawDate: unknown, nowS = env.nowS): Promise<Ladder | null> {
  let date: number | undefined;
  try {
    date = parseDateArg(rawDate ? String(rawDate) : undefined, city);
  } catch (e) {
    return fail("ISOTHERM_BAD_INPUT", shortErr(e), "Example: --date tomorrow, or --date 2026-10-09");
  }
  if (date !== undefined) return readLadder(env.reader.client, env.dep, env.c, city.station, date, nowS);
  const refs = (await listLadderRefs(env.reader.client, env.dep, env.c, 60)).filter((r) => r.station === city.station);
  const dates = [...new Set(refs.map((r) => r.date))].sort((a, b) => a - b);
  const ladders: Ladder[] = [];
  for (const d of dates.slice(-6)) {
    const l = await readLadder(env.reader.client, env.dep, env.c, city.station, d, nowS);
    if (l) ladders.push(l);
  }
  const open = ladders.filter((l) => l.state === "open").sort((a, b) => a.closeTime - b.closeTime);
  return open[0] ?? ladders[ladders.length - 1] ?? null;
}

export function pickSeries(l: Ladder, strike: number): Series {
  const s = l.series.find((x) => x.strikeC === strike);
  if (!s) fail("ISOTHERM_UNKNOWN_STRIKE", `No 'Tmax >= ${strike}C' series in the ${l.station} ${l.date} ladder.`, `Strikes listed: ${l.series.map((x) => x.strikeC).join(", ")}.`);
  return s as Series;
}

export function runner(cmd: { ctx: any }, io: CommandIO, env: Env, source: string, gasMult: number): TxRunner {
  if (!env.self) fail("ISOTHERM_NO_WALLET", "No wallet selected in mm.", "Run `mm init` (BYOK or server wallet) first.");
  const errorAbis: Abi[] = [env.c.vaultAbi, env.c.resolverAbi, ...(env.c.zapAbi ? [env.c.zapAbi] : []), env.c.tokenAbi, erc20Abi, orderBookAbi, marginAccountAbi, kuruRouterAbi];
  return new TxRunner(
    async () => (await cmd.ctx.walletExecutor(io, source, { emitStepNotices: true })) as unknown as Executor,
    env.reader,
    env.self as Address,
    io,
    { gasMult, errorAbis, source },
  );
}

// ------------------------------------------------------------------------------------------- approvals
export async function ensureAllowance(
  run: TxRunner,
  env: Env,
  token: Address,
  spender: Address,
  amount: bigint,
  mode: unknown,
  label: string,
): Promise<{ needed: boolean; current: bigint }> {
  const current = (await env.reader.client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [run.from, spender] })) as bigint;
  if (current >= amount) return { needed: false, current };
  const max = String(mode ?? "exact").toLowerCase() === "max";
  await run.send({
    label: `${label}: approve ${max ? "unlimited" : "exact amount"}`,
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, max ? maxUint256 : amount] }),
    gasMult: 1.1,
  });
  return { needed: true, current };
}

// ------------------------------------------------------------------------------------------- zap calls
export type ZapValues = { seriesId: Hex; market: Address; amountIn: bigint; minOut: bigint; to: Address; minNoOut?: bigint; deadline?: bigint };

/**
 * Encode a Zap call by matching the ABI's parameter NAMES, so the plugin follows the v1 Zap's signature when
 * packages/abi ships it (e.g. a dropped `market` arg, an added `minNoOut` or `deadline`) without code changes.
 */
export function encodeZap(abi: Abi, fn: string, v: ZapValues): { data: Hex; signature: string; usedMinNoOut: boolean } {
  const f = abiFunction(abi, fn);
  if (!f) return fail("ISOTHERM_ZAP_UNSUPPORTED", `This deployment's Zap has no '${fn}' function.`, "Update the plugin, or use a deployment whose Zap supports this flow.");
  let usedMinNoOut = false;
  const args = f.inputs.map((inp) => {
    const n = (inp.name ?? "").toLowerCase();
    if (inp.type === "bytes32" && n.includes("series")) return v.seriesId;
    if (inp.type === "address" && (n.includes("market") || n.includes("book"))) return v.market;
    if (inp.type === "address" && ["to", "recipient", "receiver"].includes(n)) return v.to;
    if (inp.type.startsWith("uint") && n.startsWith("min") && n.includes("noout")) {
      usedMinNoOut = true;
      return v.minNoOut ?? 0n;
    }
    if (inp.type.startsWith("uint") && n.startsWith("min")) return v.minOut;
    if (inp.type.startsWith("uint") && n.includes("deadline")) return v.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 600);
    if (inp.type.startsWith("uint") && (n.endsWith("in") || n.includes("amount"))) return v.amountIn;
    return fail("ISOTHERM_ZAP_UNSUPPORTED", `Zap.${fn} has a parameter the plugin does not understand: ${inp.type} ${inp.name}.`, "Update mm-plugin-isotherm to a version built against this Zap ABI.");
  });
  return { data: encodeFunctionData({ abi, functionName: fn, args }), signature: `${fn}(${f.inputs.map((i) => `${i.type} ${i.name}`).join(", ")})`, usedMinNoOut };
}
