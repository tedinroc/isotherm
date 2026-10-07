// Read-only go-live check (eth_call / reads only): chain, deployment, role keys and balances, operator authority,
// Kuru market-creation permission (simulated deployProxy), station registration, close time, strike plan, and the
// MON each role needs for the roll + a day of quoting.
import { formatEther, type Address } from "viem";
import { closeFor } from "../../forecast/src/close-config.ts";
import { pickStrikes } from "../../forecast/src/polymarket.ts";
import { isoToYmd, station as stationOf } from "../../forecast/src/stations.ts";
import { erc20Abi, kuruRouterAbi, resolverCommonAbi, vaultCommonAbi } from "./abis.ts";
import { explainRevert, read, type Ctx } from "./chain.ts";
import type { MarketData } from "./data.ts";
import { MON_ESTIMATE, station4 } from "./roll.ts";

/** Any existing 6-dp ERC-20 on testnet to probe deployProxy permission (feasibility YES >=28 ZZZZ 20261006). */
const PROBE_BASE = "0x829930e34b5e5Ce164F61E898a378B0cAe3d8a4e" as Address;

export async function preflight(ctx: Ctx, stationIcao: string, isoDate: string, data: MarketData) {
  const st = stationOf(stationIcao);
  const warnings: string[] = [];
  const bal = async (a: Address) => ({ mon: +Number(formatEther(await ctx.pub.getBalance({ address: a }))).toFixed(4), ausd: Number(await read<bigint>(ctx, ctx.dep.ausd, erc20Abi, "balanceOf", [a])) / 1e6 });
  const [owner, isOp] = await Promise.all([read<Address>(ctx, ctx.dep.vault, vaultCommonAbi, "owner"), read<boolean>(ctx, ctx.dep.vault, vaultCommonAbi, "isOperator", [ctx.addr.operator])]);
  let canCreate: string;
  try {
    await ctx.pub.simulateContract({ account: ctx.addr.marketCreator, address: ctx.dep.kuruRouter, abi: kuruRouterAbi, functionName: "deployProxy", args: [0, PROBE_BASE, ctx.dep.ausd, 1_000_000n, 10_000, 10, 7_000_000n, 1_000_000_000_000n, 10n, 0n, 100n] });
    canCreate = "yes (eth_call deployProxy from the market creator succeeds)";
  } catch (e) {
    canCreate = `NO: ${explainRevert(e)}`;
    warnings.push(`market creator cannot call Router.deployProxy: ${canCreate}`);
  }
  let dayEnd: number | null = null;
  try {
    dayEnd = Number(await read<bigint>(ctx, ctx.dep.resolver, resolverCommonAbi, "dayEnd", [station4(st.icao), isoToYmd(isoDate)]));
  } catch (e) {
    warnings.push(`station ${st.icao} not usable on Resolver ${ctx.dep.resolver}: ${explainRevert(e)} (owner must registerStation(${station4(st.icao)}, ${st.utcOffsetMin * 60}))`);
  }
  if (!isOp && owner.toLowerCase() !== ctx.addr.operator.toLowerCase()) warnings.push(`operator ${ctx.addr.operator} is not authorised on the vault`);
  const close = closeFor(st.icao, isoDate, ctx.cfg.roll.closeMarginMin);
  const d = await data.get(st.icao, isoDate, Date.now());
  const strikes = d.pm?.ok ? pickStrikes(d.pm, ctx.cfg.roll.strikePolicy) : [];
  if (!d.pm) warnings.push(`no Polymarket event for ${st.icao} ${isoDate} yet`);
  else if (!d.pm.ok) warnings.push(`Polymarket ladder not usable: ${d.pm.warnings.join("; ")}`);
  const n = strikes.length || 4;
  const E = MON_ESTIMATE;
  const need = {
    operator: +(E.createLadderBase + E.createLadderPerStrike * n + (ctx.dep.zapRegistry ? E.setCanonical * n : 0) + (ctx.cfg.roles.marketCreator === "operator" ? E.deployProxy * n : 0)).toFixed(3),
    maker: +(E.approve * (2 + n) + (E.mintFirst + E.deposit + E.quote) * n + E.deposit).toFixed(3),
    makerQuotingPerDayCap: ctx.cfg.budget.dailyCapMon.maker,
  };
  const roles = {
    maker: { key: ctx.keyNames.maker, address: ctx.addr.maker, ...(await bal(ctx.addr.maker)) },
    operator: { key: ctx.keyNames.operator, address: ctx.addr.operator, authorised: isOp ? "operator" : owner.toLowerCase() === ctx.addr.operator.toLowerCase() ? "owner" : "NO", ...(await bal(ctx.addr.operator)) },
    marketCreator: { key: ctx.keyNames.marketCreator, address: ctx.addr.marketCreator, canCreateMarket: canCreate },
  };
  if (roles.operator.mon < need.operator) warnings.push(`operator has ${roles.operator.mon} MON, the roll needs ~${need.operator}`);
  if (roles.maker.mon < need.maker + 0.3) warnings.push(`maker has ${roles.maker.mon} MON: the roll needs ~${need.maker} plus quoting (cap ${need.makerQuotingPerDayCap}/day)`);
  if (roles.maker.ausd < ctx.cfg.roll.mintSets * n + ctx.cfg.roll.marginAusd) warnings.push(`maker has ${roles.maker.ausd} AUSD; the roll mints ${ctx.cfg.roll.mintSets} sets x ${n} + ${ctx.cfg.roll.marginAusd} margin (faucet will be used)`);
  return {
    chain: { rpc: ctx.rpc, client: ctx.clientVersion, anvil: ctx.isAnvil, block: Number(await ctx.pub.getBlockNumber()), liveBroadcastAllowed: ctx.cfg.allowLive },
    deployment: { variant: ctx.dep.variant, source: ctx.dep.source, vault: ctx.dep.vault, resolver: ctx.dep.resolver, zap: ctx.dep.zap, zapRegistry: ctx.dep.zapRegistry, vaultOwner: owner },
    roles,
    station: { icao: st.icao, validated: st.validated, date: isoDate, dayEnd, closeLocal: close.closeLocal, stopQuotingLocal: close.stopQuotingLocal, basis: close.basis, closeTimeUtc: new Date(close.closeUtcMs).toISOString() },
    plan: { strikes, polymarket: d.pm ? { url: d.pm.url, ok: d.pm.ok, median: d.pm.median, ladder: Object.fromEntries(strikes.map((k) => [k, d.pm!.ladder[k]])), volume: d.pm.volume } : null, v0: d.v0 ? { mu: d.v0.mu, lead: d.v0.lead } : null, observedMax: d.obs?.tmaxC ?? null },
    estimatedMon: need,
    budget: { day: ctx.state.budget.day, spent: ctx.state.budget.spent, caps: ctx.cfg.budget.dailyCapMon },
    warnings,
    ready: warnings.length === 0,
  };
}
