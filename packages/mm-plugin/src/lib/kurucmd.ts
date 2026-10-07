// Shared bits of the generic `mm kuru …` commands (any Kuru v1 market on Monad testnet, not only Isotherm books).
import type { Address } from "viem";
import { fail, type Env } from "./cmd.js";
import { erc20Abi, marginAccountAbi, readMarketParams, type MarketParams } from "./kuru.js";
import { shortErr } from "./util.js";

export const NATIVE = "0x0000000000000000000000000000000000000000";

export async function marketOrFail(env: Env, market: Address): Promise<MarketParams> {
  let p: MarketParams | undefined;
  try {
    p = await readMarketParams(env.reader.client, env.dep.kuruRouter, market);
  } catch (e) {
    return fail("KURU_UNKNOWN_MARKET", `Kuru router lookup failed for ${market}: ${shortErr(e)}`, "Pass a Kuru v1 OrderBook address on Monad testnet.");
  }
  if (!p) fail("KURU_UNKNOWN_MARKET", `${market} is not a market of the Kuru v1 router ${env.dep.kuruRouter}.`, "Pass a Kuru v1 OrderBook address (e.g. from `mm weather markets`).");
  return p as MarketParams;
}

export async function symbolOf(env: Env, token: Address): Promise<string> {
  if (token.toLowerCase() === NATIVE) return "MON";
  try {
    return (await env.reader.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })) as string;
  } catch {
    return token.slice(0, 8);
  }
}

export async function marginBalance(env: Env, user: Address, token: Address): Promise<bigint> {
  return (await env.reader.client.readContract({ address: env.dep.marginAccount, abi: marginAccountAbi, functionName: "getBalance", args: [user, token] })) as bigint;
}

export function parseIds(raw: unknown): bigint[] {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  const parts = s.split(/[\s,]+/).filter(Boolean);
  for (const p of parts) if (!/^\d+$/.test(p)) fail("KURU_BAD_INPUT", `order id '${p}' is not an integer`, "Example: --order 12,13");
  return parts.map((p) => BigInt(p));
}
