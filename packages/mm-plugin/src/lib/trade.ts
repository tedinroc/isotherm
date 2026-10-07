// Shared pre-trade checks and post-trade reporting for weather buy/sell.
import { decodeFunctionResult, parseEventLogs, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import type { City } from "./config.js";
import { fail, type Env } from "./cmd.js";
import type { Ladder, MarketCheck, Series } from "./isotherm.js";
import { resolveMarket } from "./isotherm.js";
import { erc20Abi, readL2, type L2, type MarketParams } from "./kuru.js";
import { explainRevert } from "./chain.js";
import { localDate, observedMax } from "./weather.js";
import { jsonSafe, shortErr } from "./util.js";

export async function canonicalBook(env: Env, s: Series, flagMarket?: Address): Promise<{ check: MarketCheck; params: MarketParams; market: Address }> {
  const check = await resolveMarket(env.reader.client, env.dep, env.c, s, flagMarket);
  if (!check.market || !check.params || !check.canonical) {
    fail(
      "ISOTHERM_NONCANONICAL_MARKET",
      `No canonical Kuru book for Tmax>=${s.strikeC}C: ${check.problems.join("; ") || "unknown"}.`,
      "The plugin only routes funds into the series' own YES/AUSD book with Isotherm's standard parameters. Check `mm weather markets`.",
    );
  }
  return { check, params: check.params as MarketParams, market: check.market as Address };
}

export function requireOpen(l: Ladder, nowS: number) {
  if (l.state !== "open") {
    fail(
      "ISOTHERM_LADDER_CLOSED",
      `The ${l.station} ${l.date} ladder is ${l.state} (close ${new Date(l.closeTime * 1000).toISOString()}).`,
      l.state === "settled" || l.state === "void" ? "Use `mm weather redeem`." : "Trading stops at close because the day's max becomes public from METAR; wait for settlement, then redeem.",
    );
  }
  if (l.closeTime - nowS < 60) fail("ISOTHERM_LADDER_CLOSING", "The ladder closes in under a minute.", "Too close to the close to trade safely; wait for settlement.");
}

/** Today's observed max so far; refuses a trade that bets against an outcome the observations already decided. */
export async function observedGuard(city: City, s: Series, side: "yes" | "no", direction: "buy" | "sell", ignore: boolean) {
  const today = localDate(Date.now(), city.utcOffsetMin);
  if (s.date !== today) return { checked: false as const, reason: "ladder is not for today (station-local)" };
  const { obs, error } = await observedMax(city, s.date);
  if (!obs || obs.maxC === null) return { checked: false as const, reason: error ?? "no reports yet" };
  const locked = obs.maxC >= s.strikeC;
  // Holding/buying NO (or selling YES) once Tmax >= k has been observed is a near-certain loss.
  const losing = locked && ((side === "no" && direction === "buy") || (side === "yes" && direction === "sell"));
  if (losing && !ignore) {
    fail(
      "ISOTHERM_OUTCOME_LOCKED",
      `Observed max so far at ${city.station} is ${obs.maxC}°C >= ${s.strikeC}°C (${obs.nReports} reports, last ${obs.lastReportUtc}); YES has effectively won, so this ${direction} ${side.toUpperCase()} would almost surely lose.`,
      "Pass --ignore-observed to override (not recommended).",
    );
  }
  return { checked: true as const, observedMaxC: obs.maxC, lastReportUtc: obs.lastReportUtc, lockedYes: locked };
}

/** v1 gated series only mint to allowlisted recipients; buy NO mints a set to the Zap and forwards NO to `to`. */
export async function gatedGuard(env: Env, s: Series, who: Address) {
  if (!s.gated) return;
  let ok = false;
  try {
    ok = (await env.reader.client.readContract({ address: env.dep.vault, abi: env.c.vaultAbi, functionName: "isAllowlisted", args: [env.dep.zap ?? who] })) as boolean;
  } catch {}
  if (!ok)
    fail(
      "ISOTHERM_SERIES_GATED",
      `Tmax>=${s.strikeC}C is a gated (allowlist-only) series and the Zap is not allowlisted to mint it.`,
      "Buy YES on the book instead, or ask the operator; gating is a compliance switch (CollateralVault.setSeriesGated).",
    );
}

export async function balanceOf(env: Env, token: Address, who: Address): Promise<bigint> {
  return (await env.reader.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] })) as bigint;
}

export async function book(env: Env, market: Address): Promise<L2> {
  return readL2(env.reader.client, market);
}

/** eth_call the zap step from the wallet and decode its return values (after approvals exist). */
export async function simulate(env: Env, from: Address, to: Address, data: Hex, abi: Abi, fn: string, errAbis: Abi[]): Promise<readonly unknown[]> {
  try {
    const r = await env.reader.client.call({ account: from, to, data });
    const out = decodeFunctionResult({ abi, functionName: fn, data: (r.data ?? "0x") as Hex });
    return Array.isArray(out) ? out : [out];
  } catch (e) {
    return fail(
      "ISOTHERM_WOULD_REVERT",
      `Simulation of ${fn} reverts: ${explainRevert(e, errAbis)}. Any approval above is confirmed; the trade was NOT sent.`,
      "The book probably moved. Re-run the command (it re-reads the book), or loosen --max-price / --min-price.",
    );
  }
}

export function zapEvents(abi: Abi | undefined, receipt: TransactionReceipt | null, zap: Address | undefined) {
  if (!abi || !receipt || !zap) return [];
  try {
    return parseEventLogs({ abi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === zap.toLowerCase()) }).map((e) => ({
      event: e.eventName,
      args: jsonSafe(e.args),
    }));
  } catch (e) {
    return [{ event: "decode-failed", args: shortErr(e) }];
  }
}

export const slippageBps = (raw: unknown) => {
  if (raw === undefined || raw === null || raw === "") return 50n;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s) || Number(s) > 2000) fail("ISOTHERM_BAD_INPUT", `--slippage-bps '${s}' must be an integer 0..2000.`, "Default is 50 (0.5%).");
  return BigInt(s);
};
