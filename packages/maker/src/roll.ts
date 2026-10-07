// Daily ladder roll for one station-date. Idempotent and resumable: every step re-checks the chain before acting
// and the state file records what was created (plus the hash of an in-flight market creation, so a crash between
// broadcast and receipt can never produce a duplicate Kuru market).
//   preflight -> plan strikes (Polymarket median window; persisted) -> createLadder/createSeries (operator)
//   -> maker inventory (faucet if short, mint complete sets) -> Kuru markets (Router.deployProxy, market creator)
//   -> canonical market in the v1 Zap (operator) -> margin deposits (maker) -> initial quotes (one tick)
import { decodeEventLog, encodeFunctionData, maxUint256, stringToHex, type Address, type Hex } from "viem";
import { closeFor } from "../../forecast/src/close-config.ts";
import { pickStrikes } from "../../forecast/src/polymarket.ts";
import { isoToYmd, localDateOf, station as stationOf } from "../../forecast/src/stations.ts";
import { erc20Abi, faucetAbi, kuruRouterAbi, marginAbi, resolverCommonAbi, vaultCommonAbi, zapRegistryAbi } from "./abis.ts";
import { explainRevert, nowSec, read, send, TxReverted, type Ctx, type SendResult } from "./chain.ts";
import type { Role } from "./config.ts";
import type { MarketData } from "./data.ts";
import { marginBalance } from "./kuru.ts";
import { ladderKey, note, type LadderState, type SeriesState } from "./state.ts";
import { tickLadder } from "./tick.ts";

export const station4 = (code: string) => stringToHex(code, { size: 4 });

/** Rough MON per step at 102 gwei, from measured fork/live gas (used only to estimate dry-run plans). */
export const MON_ESTIMATE = { createLadderBase: 0.017, createLadderPerStrike: 0.026, deployProxy: 0.15, setCanonical: 0.012, approve: 0.007, mintFirst: 0.032, deposit: 0.017, quote: 0.06, faucet: 0.0126 };

export interface RollStep {
  step: string;
  status: "done" | "sent" | "dry-run" | "skipped" | "blocked";
  detail: string;
  mon?: number;
}
export interface RollReport {
  key: string;
  station: string;
  date: string;
  strikes: number[];
  strikeSource: string;
  closeLocal: string;
  stopQuotingLocal: string;
  closeTime: number;
  ok: boolean;
  steps: RollStep[];
  monByRole: Record<string, number>;
  estimatedMonByRole: Record<string, number>;
}

export interface RollOpts {
  station: string;
  isoDate: string;
  strikes?: number[];
  data: MarketData;
  noFaucet?: boolean;
  force?: boolean; // allow an unvalidated station
  skipQuotes?: boolean;
}

class Blocked extends Error {}

function estimateStep(label: string): number {
  const E = MON_ESTIMATE;
  if (/deployProxy/.test(label)) return E.deployProxy;
  if (/setCanonical/.test(label)) return E.setCanonical;
  if (/^approve/.test(label)) return E.approve;
  if (/mintSet/.test(label)) return E.mintFirst;
  if (/deposit/.test(label)) return E.deposit;
  if (/faucet/.test(label)) return E.faucet;
  if (/createSeries/.test(label)) return E.createLadderBase + E.createLadderPerStrike;
  return E.quote;
}

export async function roll(ctx: Ctx, o: RollOpts): Promise<RollReport> {
  const st = stationOf(o.station);
  const date = isoToYmd(o.isoDate);
  const key = ladderKey(st.icao, date);
  const close = closeFor(st.icao, o.isoDate, ctx.cfg.roll.closeMarginMin);
  const rep: RollReport = { key, station: st.icao, date: o.isoDate, strikes: [], strikeSource: "", closeLocal: close.closeLocal, stopQuotingLocal: close.stopQuotingLocal, closeTime: Math.floor(close.closeUtcMs / 1000), ok: false, steps: [], monByRole: {}, estimatedMonByRole: {} };
  const dry = ctx.cfg.dryRun;
  let dependsOnDry = false; // a dry-run step "created" something later steps would need
  const add = (step: string, status: RollStep["status"], detail: string, mon?: number) => {
    rep.steps.push({ step, status, detail, ...(mon !== undefined ? { mon: +mon.toFixed(4) } : {}) });
    ctx.log.info(`roll ${key} [${step}] ${status}: ${detail}`);
  };
  const est = (role: Role, mon: number) => (rep.estimatedMonByRole[ctx.keyNames[role]] = +((rep.estimatedMonByRole[ctx.keyNames[role]] ?? 0) + mon).toFixed(4));
  const tx = async (role: Role, step: string, req: Parameters<typeof send>[2], kind: "roll" = "roll", onHash?: (h: Hex, n: number) => void): Promise<SendResult> => {
    if (dry && dependsOnDry) {
      // cannot simulate a step whose inputs a previous dry-run step would have created: use the measured table
      const mon = estimateStep(step);
      est(role, mon);
      return { dryRun: true, gasLimit: 0n, costMon: mon, estimate: 0n };
    }
    const r = await send(ctx, role, req, { label: step, kind, onHash });
    est(role, r.costMon);
    if (r.dryRun) dependsOnDry = true;
    else rep.monByRole[ctx.keyNames[role]] = +((rep.monByRole[ctx.keyNames[role]] ?? 0) + r.costMon).toFixed(4);
    return r;
  };
  const S = st.icao, hex = station4(S);
  try {
    // ------------------------------------------------------------ preflight
    if (!st.validated && !o.force) throw new Blocked(`${S} settlement rule was not validated against Polymarket; pass --force to roll it anyway`);
    const now = await nowSec(ctx);
    const today = localDateOf(now * 1000, st.utcOffsetMin);
    const lead = Math.round((Date.parse(o.isoDate) - Date.parse(today)) / 86_400_000);
    if (lead < 0 || lead > ctx.cfg.roll.maxDaysAhead) throw new Blocked(`${o.isoDate} is ${lead} day(s) from ${S}'s today ${today}; allowed 0..${ctx.cfg.roll.maxDaysAhead}`);
    let dayEnd: number;
    try {
      dayEnd = Number(await read<bigint>(ctx, ctx.dep.resolver, resolverCommonAbi, "dayEnd", [hex, date]));
    } catch (e) {
      throw new Blocked(`Resolver ${ctx.dep.resolver} rejects ${S}: ${explainRevert(e)}. The Resolver owner must registerStation(${hex}, ${st.utcOffsetMin * 60}) first.`);
    }
    if (dayEnd * 1000 !== close.dayEndUtcMs) throw new Blocked(`Resolver dayEnd ${dayEnd} != local midnight ${close.dayEndUtcMs / 1000} (UTC offset mismatch)`);
    const [owner, isOp] = await Promise.all([read<Address>(ctx, ctx.dep.vault, vaultCommonAbi, "owner"), read<boolean>(ctx, ctx.dep.vault, vaultCommonAbi, "isOperator", [ctx.addr.operator])]);
    if (!isOp && owner.toLowerCase() !== ctx.addr.operator.toLowerCase()) throw new Blocked(`${ctx.keyNames.operator} ${ctx.addr.operator} is neither operator nor owner of vault ${ctx.dep.vault}`);
    add("preflight", "done", `${ctx.dep.variant} deployment (${ctx.dep.source}); operator=${ctx.keyNames.operator} ${ctx.addr.operator}${isOp ? "" : " (vault owner)"}, market creator=${ctx.keyNames.marketCreator}, maker=${ctx.addr.maker}; close ${close.closeLocal} local (${close.basis}); Zap registry ${ctx.dep.zapRegistry ? "yes" : "no"}`);

    // ------------------------------------------------------------ plan strikes (persisted before any tx)
    let L: LadderState | undefined = ctx.state.ladders[key];
    const onchainIds = await read<Hex[]>(ctx, ctx.dep.vault, vaultCommonAbi, "ladderSeries", [hex, date]);
    const onchain = new Map<number, { id: Hex; yes: Address; no: Address; closeTime: number }>();
    for (const id of onchainIds) {
      const s = await read<any>(ctx, ctx.dep.vault, ctx.dep.seriesAbi, "getSeries", [id]);
      onchain.set(Number(s.strikeC), { id, yes: s.yes, no: s.no, closeTime: Number(s.closeTime) });
    }
    if (!L) {
      let strikes: number[], source: string;
      let pmRef: LadderState["polymarket"];
      if (onchain.size) (strikes = [...onchain.keys()].sort((a, b) => a - b)), (source = "adopted from the existing on-chain ladder");
      else if (o.strikes?.length) (strikes = [...o.strikes].sort((a, b) => a - b)), (source = "manual --strikes");
      else {
        const d = await o.data.get(S, o.isoDate, now * 1000);
        if (d.pm?.ok) {
          strikes = pickStrikes(d.pm, ctx.cfg.roll.strikePolicy);
          source = `Polymarket median ${d.pm.median} (${d.pm.url}, fetched ${d.pm.fetchedAt}): P(>=k) ${strikes.map((k) => `${k}:${d.pm!.ladder[k].toFixed(3)}`).join(" ")}`;
          pmRef = { slug: d.pm.slug, url: d.pm.url };
        } else if (d.v0) {
          const ks = Object.keys(d.v0.ladder).map(Number).sort((a, b) => a - b);
          const above = ks.filter((k) => d.v0!.ladder[k] >= 0.5);
          strikes = pickStrikes({ ladder: d.v0.ladder, strikes: ks, median: above.length ? Math.max(...above) : null }, ctx.cfg.roll.strikePolicy);
          source = `v0 fallback (no usable Polymarket ladder${d.pm ? ": " + d.pm.warnings.join("; ") : ""}), mu ${d.v0.mu}`;
        } else throw new Blocked(`no Polymarket ladder and no v0 forecast for ${S} ${o.isoDate}; pass --strikes`);
      }
      if (!strikes.length) throw new Blocked("strike plan is empty");
      L = { key, station: S, date, isoDate: o.isoDate, strikes, strikeSource: source, closeTime: rep.closeTime, stopAt: Math.floor(close.stopUtcMs / 1000), dayEnd, status: "planned", steps: {}, pending: {}, series: {}, createdAt: now, polymarket: pmRef };
      ctx.state.ladders[key] = L;
      note(ctx.state, "roll", `planned ${key} strikes [${strikes}] (${source})`, now);
      if (!dry) ctx.save();
    }
    const lad = L;
    rep.strikes = lad.strikes;
    rep.strikeSource = lad.strikeSource;
    add("plan", "done", `strikes [${lad.strikes}] (${lad.strikeSource})`);
    if (lad.status === "closed") throw new Blocked(`${key} is already closed`);

    // ------------------------------------------------------------ series (operator)
    const missing = lad.strikes.filter((k) => !onchain.has(k));
    if (missing.length) {
      if (lad.closeTime <= now + ctx.cfg.roll.minLeadMin * 60) throw new Blocked(`close ${new Date(lad.closeTime * 1000).toISOString()} is less than ${ctx.cfg.roll.minLeadMin} min away: too late to open strikes for ${o.isoDate}`);
      if (!onchain.size) await tx("operator", `createLadder ${S} ${date} [${missing}]`, { to: ctx.dep.vault, abi: vaultCommonAbi, functionName: "createLadder", args: [hex, date, missing, BigInt(lad.closeTime)] });
      else for (const k of missing) await tx("operator", `createSeries ${S} ${date} >=${k}`, { to: ctx.dep.vault, abi: vaultCommonAbi, functionName: "createSeries", args: [hex, date, k, BigInt(lad.closeTime)] });
      add("series", dry ? "dry-run" : "sent", `${onchain.size ? "createSeries" : "createLadder"} for [${missing}]`);
    } else add("series", "skipped", `all ${lad.strikes.length} strikes exist on-chain`);
    if (dependsOnDry) {
      est("operator", 0);
      est("marketCreator", MON_ESTIMATE.deployProxy * lad.strikes.length);
      if (ctx.dep.zapRegistry) est("operator", MON_ESTIMATE.setCanonical * lad.strikes.length);
      est("maker", MON_ESTIMATE.approve * (2 + lad.strikes.length) + (MON_ESTIMATE.mintFirst + MON_ESTIMATE.deposit + MON_ESTIMATE.quote) * lad.strikes.length + MON_ESTIMATE.deposit);
      add("rest", "skipped", `dry-run: later steps need the series to exist; estimated MON by role ${JSON.stringify(rep.estimatedMonByRole)}`);
      rep.ok = true;
      return rep;
    }
    for (const k of lad.strikes) {
      const id = await read<Hex>(ctx, ctx.dep.vault, vaultCommonAbi, "seriesIdOf", [hex, date, k]);
      const s = await read<any>(ctx, ctx.dep.vault, ctx.dep.seriesAbi, "getSeries", [id]);
      const prev = lad.series[k];
      const fresh: SeriesState = { strike: k, seriesId: id, yes: s.yes, no: s.no, market: null, canonical: null, mode: "pending", orders: {} };
      lad.series[k] = prev ? { ...prev, strike: k, seriesId: id, yes: s.yes, no: s.no } : fresh;
      lad.closeTime = Math.min(lad.closeTime, Number(s.closeTime));
    }
    lad.stopAt = lad.closeTime - ctx.cfg.roll.closeMarginMin * 60;
    lad.status = "rolling";
    lad.steps.series = { done: true, at: now };
    ctx.save();

    // ------------------------------------------------------------ maker inventory: AUSD, mint complete sets
    const target = BigInt(ctx.cfg.roll.mintSets) * 1_000_000n;
    const shortfalls = new Map<number, bigint>();
    for (const k of lad.strikes) {
      const noBal = await read<bigint>(ctx, lad.series[k].no, erc20Abi, "balanceOf", [ctx.addr.maker]);
      if (noBal < target) shortfalls.set(k, target - noBal);
    }
    const needMint = [...shortfalls.values()].reduce((a, b) => a + b, 0n);
    const marginAusdFree = await marginBalance(ctx, ctx.addr.maker, ctx.dep.ausd);
    const needMargin = BigInt(ctx.cfg.roll.marginAusd) * 1_000_000n > marginAusdFree ? BigInt(ctx.cfg.roll.marginAusd) * 1_000_000n - marginAusdFree : 0n;
    let ausdBal = await read<bigint>(ctx, ctx.dep.ausd, erc20Abi, "balanceOf", [ctx.addr.maker]);
    if (ausdBal < needMint + needMargin) {
      if (o.noFaucet) throw new Blocked(`maker holds ${Number(ausdBal) / 1e6} AUSD, needs ${Number(needMint + needMargin) / 1e6}; faucet disabled`);
      await faucet(ctx, (r, s, q) => tx(r, s, q));
      ausdBal = await read<bigint>(ctx, ctx.dep.ausd, erc20Abi, "balanceOf", [ctx.addr.maker]);
      if (ausdBal < needMint + needMargin) throw new Blocked(`after the faucet the maker holds ${Number(ausdBal) / 1e6} AUSD, needs ${Number(needMint + needMargin) / 1e6}`);
      add("faucet", "sent", `maker now holds ${Number(ausdBal) / 1e6} AUSD`);
    }
    if (needMint > 0n) {
      await ensureAllowance(ctx, "maker", ctx.dep.ausd, ctx.dep.vault, needMint, (r, s, q) => tx(r, s, q));
      for (const [k, amt] of shortfalls) await tx("maker", `mintSet >=${k} x${Number(amt) / 1e6}`, { to: ctx.dep.vault, abi: vaultCommonAbi, functionName: "mintSet", args: [lad.series[k].seriesId, amt] });
      add("mint", "sent", `minted ${[...shortfalls].map(([k, a]) => `>=${k}:${Number(a) / 1e6}`).join(" ")} complete sets`);
    } else add("mint", "skipped", `maker already holds ${ctx.cfg.roll.mintSets} NO per strike`);

    // ------------------------------------------------------------ Kuru markets (one YES/AUSD book per strike)
    const p = ctx.cfg.roll.kuru;
    for (const k of lad.strikes) {
      const s = lad.series[k];
      if (s.market) {
        await verifyMarket(ctx, s);
        add("market", "skipped", `>=${k}: ${s.market} (from state, verified on the Router)`);
        continue;
      }
      const pend = lad.pending[`market:${k}`];
      if (pend) {
        const rec = await recoverMarket(ctx, pend.hash);
        s.market = rec.market;
        s.marketBlock = rec.block;
        delete lad.pending[`market:${k}`];
        ctx.save();
        add("market", "done", `>=${k}: recovered ${s.market} from in-flight tx ${pend.hash}`);
        continue;
      }
      if (ctx.dep.zapRegistry && ctx.dep.zap) {
        const can = await read<Address>(ctx, ctx.dep.zap, zapRegistryAbi, "canonicalMarket", [s.seriesId]);
        if (can !== "0x0000000000000000000000000000000000000000") {
          s.market = can;
          s.canonical = true;
          ctx.save();
          add("market", "done", `>=${k}: adopted the Zap's canonical market ${can}`);
          continue;
        }
      }
      const r = await tx(
        "marketCreator",
        `Kuru deployProxy YES>=${k}/AUSD`,
        { to: ctx.dep.kuruRouter, abi: kuruRouterAbi, functionName: "deployProxy", args: [p.type, s.yes, ctx.dep.ausd, BigInt(p.sizePrecision), p.pricePrecision, p.tickSize, BigInt(p.minSize), BigInt(p.maxSize), BigInt(p.takerFeeBps), BigInt(p.makerFeeBps), BigInt(p.kuruAmmSpread)] },
        "roll",
        (hash, nonce) => {
          lad.pending[`market:${k}`] = { hash, from: ctx.addr.marketCreator, nonce, at: Math.floor(Date.now() / 1000), what: `deployProxy >=${k}` };
          ctx.save();
          // test hook: simulate the process dying between broadcast and receipt (fork tests only)
          if (ctx.isAnvil && process.env.MAKER_TEST_CRASH_AFTER === `deployProxy:${k}`) throw new Error(`simulated crash after broadcasting deployProxy >=${k}`);
        },
      );
      if (r.dryRun) continue;
      s.market = marketFromReceipt(r.receipt);
      s.marketBlock = Number(r.receipt.blockNumber);
      delete lad.pending[`market:${k}`];
      ctx.save();
      add("market", "sent", `>=${k}: Kuru market ${s.market}`);
    }

    // ------------------------------------------------------------ canonical market in the v1 Zap (operator, write-once)
    if (ctx.dep.zapRegistry && ctx.dep.zap) {
      for (const k of lad.strikes) {
        const s = lad.series[k];
        if (!s.market) continue; // dry-run: market not created
        const can = await read<Address>(ctx, ctx.dep.zap, zapRegistryAbi, "canonicalMarket", [s.seriesId]);
        if (can.toLowerCase() === s.market.toLowerCase()) {
          s.canonical = true;
          continue;
        }
        if (can !== "0x0000000000000000000000000000000000000000") throw new Blocked(`>=${k}: the Zap's canonical market is ${can}, not our ${s.market}; refusing to quote a non-canonical book`);
        const r = await tx("operator", `Zap.setCanonicalMarket >=${k}`, { to: ctx.dep.zap, abi: zapRegistryAbi, functionName: "setCanonicalMarket", args: [s.seriesId, s.market] });
        if (r.dryRun) continue;
        s.canonical = true;
        ctx.save();
      }
      add("canonical", "done", `Zap ${ctx.dep.zap} canonical market set for [${lad.strikes}]`);
    } else add("canonical", "skipped", `Zap ${ctx.dep.zap ?? "-"} has no canonical-market registry (feasibility Zap)`);

    // ------------------------------------------------------------ margin (maker): AUSD shared, YES per strike
    // AUSD margin is shared by every ladder: each ladder brings up to marginAusd once (step flag), counted against the
    // free balance at that moment (this ladder's bids are not placed yet). The tick's top-up keeps it from running dry.
    if (!lad.steps.marginAusd?.done) {
      const tenAusd = 10_000_000n;
      const freeAusd = await marginBalance(ctx, ctx.addr.maker, ctx.dep.ausd);
      const wantAusd = BigInt(ctx.cfg.roll.marginAusd) * 1_000_000n;
      let h: Hex | undefined;
      if (freeAusd + tenAusd < wantAusd) {
        await ensureAllowance(ctx, "maker", ctx.dep.ausd, ctx.dep.marginAccount, wantAusd - freeAusd, (r, s, q) => tx(r, s, q));
        const r = await tx("maker", `margin.deposit AUSD ${Number(wantAusd - freeAusd) / 1e6}`, { to: ctx.dep.marginAccount, abi: marginAbi, functionName: "deposit", args: [ctx.addr.maker, ctx.dep.ausd, wantAusd - freeAusd] });
        if (!r.dryRun) h = r.hash;
      }
      if (!dry) (lad.steps.marginAusd = { done: true, at: await nowSec(ctx), tx: h }), ctx.save();
    }
    for (const k of lad.strikes) {
      const s = lad.series[k];
      if (s.marginDone) continue;
      const free = await marginBalance(ctx, ctx.addr.maker, s.yes);
      const want = BigInt(ctx.cfg.roll.marginYes) * 1_000_000n;
      const wallet = await read<bigint>(ctx, s.yes, erc20Abi, "balanceOf", [ctx.addr.maker]);
      const amt = want > free ? (want - free < wallet ? want - free : wallet) : 0n;
      if (amt > 0n) {
        await ensureAllowance(ctx, "maker", s.yes, ctx.dep.marginAccount, amt, (r, st2, q) => tx(r, st2, q));
        await tx("maker", `margin.deposit YES>=${k} ${Number(amt) / 1e6}`, { to: ctx.dep.marginAccount, abi: marginAbi, functionName: "deposit", args: [ctx.addr.maker, s.yes, amt] });
      }
      s.marginDone = true;
      ctx.save();
    }
    add("margin", "done", `margin AUSD >= ${ctx.cfg.roll.marginAusd}, YES ${ctx.cfg.roll.marginYes} per strike`);
    lad.status = "active";
    lad.steps.roll = { done: true, at: await nowSec(ctx) };
    note(ctx.state, "roll", `${key} active: markets ${lad.strikes.map((k) => `>=${k}:${lad.series[k].market}`).join(" ")}`);
    ctx.save();

    // ------------------------------------------------------------ initial quotes
    if (!o.skipQuotes) {
      const t = await tickLadder(ctx, lad, o.data);
      add("quotes", dry ? "dry-run" : "done", t.actions.map((a) => `>=${a.strike}:${a.kind}`).join(" "));
    }
    rep.ok = true;
  } catch (e) {
    if (e instanceof Blocked) add("blocked", "blocked", e.message);
    else {
      add("error", "blocked", e instanceof TxReverted ? e.message : String((e as Error)?.stack ?? e).slice(0, 600));
      ctx.save();
    }
  }
  return rep;
}

type TxFn = (role: Role, step: string, req: Parameters<typeof send>[2]) => Promise<SendResult>;

export async function ensureAllowance(ctx: Ctx, role: Role, token: Address, spender: Address, amount: bigint, txf: TxFn) {
  const cur = await read<bigint>(ctx, token, erc20Abi, "allowance", [ctx.addr[role], spender]);
  if (cur >= amount) return;
  await txf(role, `approve ${token.slice(0, 8)} -> ${spender.slice(0, 8)}`, { to: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
}

/** AUSD faucet: 10k per claim, ONE global 60 s cooldown shared by every caller -> retry politely. */
export async function faucet(ctx: Ctx, txf: TxFn, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      await ctx.pub.estimateGas({ account: ctx.accounts.maker, to: ctx.dep.ausdFaucet, data: encodeFunctionData({ abi: faucetAbi, functionName: "requestFunds", args: [ctx.addr.maker] }) });
    } catch (e) {
      const why = explainRevert(e);
      if (!why.includes("MaxFrequencyExceeded")) throw new Error(`faucet: ${why}`);
      ctx.log.info(`faucet busy (global 60 s cooldown), retry in 15 s (${i + 1}/${tries})`);
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    return txf("maker", "AUSD faucet.requestFunds -> maker", { to: ctx.dep.ausdFaucet, abi: faucetAbi, functionName: "requestFunds", args: [ctx.addr.maker] });
  }
  throw new Error("faucet kept failing (cooldown)");
}

export function marketFromReceipt(receipt: { logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] }): Address {
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: kuruRouterAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "MarketRegistered") return ev.args.market;
    } catch {}
  }
  throw new Error("MarketRegistered event not found");
}

async function recoverMarket(ctx: Ctx, hash: Hex): Promise<{ market: Address; block: number }> {
  try {
    const r = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 1000 });
    if (r.status !== "success") throw new Error(`in-flight deployProxy ${hash} reverted; clear state.pending and re-run`);
    return { market: marketFromReceipt(r), block: Number(r.blockNumber) };
  } catch (e) {
    throw new Blocked(`in-flight market creation ${hash} has no receipt (${String((e as Error).message).slice(0, 120)}). Not re-sending (could duplicate the market). Check the explorer; if it was dropped, delete it from state.pending and re-run.`);
  }
}

async function verifyMarket(ctx: Ctx, s: SeriesState) {
  const v = await read<readonly unknown[]>(ctx, ctx.dep.kuruRouter, kuruRouterAbi, "verifiedMarket", [s.market!]);
  const base = v[2] as Address, quote = v[4] as Address;
  if (base.toLowerCase() !== s.yes.toLowerCase() || quote.toLowerCase() !== ctx.dep.ausd.toLowerCase()) throw new Blocked(`state market ${s.market} for >=${s.strike} is not a YES/AUSD book of this series`);
}
