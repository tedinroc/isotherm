// One maker pass. Order of operations every tick:
//   1. kill switch (independent of market data): any ladder at/after stopAt - preStop gets every maker order on
//      every strike cancelled (tracked ids + a scan of the book), then optionally its YES margin withdrawn.
//   2. per active ladder: market data -> fair values (guard-wide hysteresis keyed on lastQuote.wide) -> per strike:
//      resting orders, inventory, book -> makeQuote -> decide -> one tx (batchUpdate: cancel + place, post-only) or a
//      pull, MON-budgeted.
//   3. snapshot (file + POST /api/snapshot).
import type { Address, Hex } from "viem";
import { computeFairs, type StrikeFair } from "../../forecast/src/fair.ts";
import { erc20Abi, kuruBookAbi, marginAbi, vaultCommonAbi } from "./abis.ts";
import { BudgetRefused, explainRevert, LiveRefused, nowSec, read, send, type Ctx } from "./chain.ts";
import type { SpendKind } from "./budget.ts";
import type { LadderData, MarketData } from "./data-core.ts";
import { createdOrders, fromSizeUnits, getBook, marginBalance, orderStatus, othersBest, scanOpenOrders, toPriceUnits, toSizeUnits, type Book } from "./kuru.ts";
import { decide, type Action } from "./policy.ts";
import { makeQuote, type QuoteDecision } from "./pricing.ts";
import { note, type LadderState, type SeriesState } from "./state-core.ts";

export interface StrikeView {
  strike: number;
  seriesId: Hex;
  market: Address | null;
  mode: string;
  fair: StrikeFair | null;
  desired: QuoteDecision | null;
  action: Action | null;
  resting: { bid?: { id: number; price: number; remaining: number }; ask?: { id: number; price: number; remaining: number } };
  inventory: { walletYes: number; walletNo: number; marginYes: number; lockedYes: number; netYes: number } | null;
  book: Book | null;
}
export interface TickAction {
  strike: number;
  kind: string;
  reasons: string[];
  tx?: Hex;
  error?: string;
}
export interface LadderTick {
  key: string;
  now: number;
  data: LadderData | null;
  fairs: StrikeFair[];
  strikes: StrikeView[];
  actions: TickAction[];
  marginAusd: number | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";

// ------------------------------------------------------------------ kill switch
export async function killLadder(ctx: Ctx, lad: LadderState, reason: string, opts: { close?: boolean; withdraw?: boolean } = {}): Promise<{ cancelled: number; txs: Hex[]; leftOpen: number }> {
  const close = opts.close ?? true;
  const withdraw = opts.withdraw ?? (close && ctx.cfg.afterClose.withdrawYes);
  const txs: Hex[] = [];
  let cancelled = 0, leftOpen = 0;
  for (const k of lad.strikes) {
    const s = lad.series[k];
    if (!s?.market) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      const tracked = [s.orders.bid?.id, s.orders.ask?.id].filter((x): x is number => typeof x === "number");
      const open = new Set<number>();
      for (const o of await orderStatus(ctx, s.market, ctx.addr.maker, tracked)) if (o.open) open.add(o.id);
      for (const o of await scanOpenOrders(ctx, s.market, ctx.addr.maker)) open.add(o.id);
      if (!open.size) break;
      try {
        const r = await send(ctx, "maker", { to: s.market, abi: kuruBookAbi, functionName: "batchCancelOrdersNoRevert", args: [[...open]] }, { label: `KILL >=${k} cancel x${open.size}`, kind: "kill" });
        if (!r.dryRun) txs.push(r.hash);
        cancelled += open.size;
        if (r.dryRun) break;
      } catch (e) {
        ctx.log.warn(`kill >=${k} attempt ${attempt + 1}: ${explainRevert(e)}`);
        if (attempt === 2) leftOpen += open.size;
      }
    }
    if (!ctx.cfg.dryRun) {
      s.orders = {};
      s.mode = close ? "closed" : "pulled";
    }
  }
  // a dry run (CLI --dry-run, the Worker's shadow) simulates and records the withdraw too, so the would-be kill is complete
  if (withdraw) {
    const yes: Address[] = [];
    for (const k of lad.strikes) {
      const s = lad.series[k];
      if (s?.market && (await marginBalance(ctx, ctx.addr.maker, s.yes)) > 0n) yes.push(s.yes);
    }
    if (yes.length)
      try {
        const r = await send(ctx, "maker", { to: ctx.dep.marginAccount, abi: marginAbi, functionName: "batchWithdrawMaxTokens", args: [yes] }, { label: `withdraw YES margin x${yes.length} after close`, kind: "pull" });
        if (!r.dryRun) txs.push(r.hash);
      } catch (e) {
        ctx.log.warn(`post-close YES withdraw: ${explainRevert(e)}`);
      }
  }
  if (!ctx.cfg.dryRun) {
    const t = await nowSec(ctx);
    if (close) (lad.status = "closed"), (lad.closedAt = t);
    note(ctx.state, close ? "kill" : "pull", `${lad.key} ${close ? "closed" : "pulled"} (${reason}): cancelled ${cancelled} order(s)${leftOpen ? `, ${leftOpen} STILL OPEN` : ""}`, t);
    ctx.save();
  }
  if (leftOpen) ctx.log.error(`KILL SWITCH: ${leftOpen} order(s) on ${lad.key} could not be cancelled`);
  return { cancelled, txs, leftOpen };
}

/** The independent watchdog: no market data, no pricing, only time + state + chain. */
export async function runWatchdog(ctx: Ctx, opts: { verifyClosed?: boolean } = {}) {
  const now = await nowSec(ctx);
  const out: { key: string; cancelled: number; leftOpen: number }[] = [];
  for (const lad of Object.values(ctx.state.ladders)) {
    const due = now >= lad.stopAt - ctx.cfg.policy.preStopSec;
    if (lad.status !== "closed" && due) {
      ctx.log.warn(`kill switch: ${lad.key} stop-quoting time ${new Date(lad.stopAt * 1000).toISOString()} reached`);
      const r = await killLadder(ctx, lad, "stop-quoting time");
      out.push({ key: lad.key, cancelled: r.cancelled, leftOpen: r.leftOpen });
    } else if (lad.status === "closed" && opts.verifyClosed && now - (lad.closedAt ?? 0) < 86_400 * 2) {
      let open = 0;
      for (const k of lad.strikes) if (lad.series[k]?.market) open += (await scanOpenOrders(ctx, lad.series[k].market!, ctx.addr.maker)).length;
      if (open) {
        ctx.log.warn(`watchdog: closed ladder ${lad.key} still has ${open} open maker order(s); cancelling`);
        const r = await killLadder(ctx, lad, "watchdog verify");
        out.push({ key: lad.key, cancelled: r.cancelled, leftOpen: r.leftOpen });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ quoting
async function inventory(ctx: Ctx, s: SeriesState, lockedYes: number) {
  const [wy, wn, my] = await Promise.all([
    read<bigint>(ctx, s.yes, erc20Abi, "balanceOf", [ctx.addr.maker]),
    read<bigint>(ctx, s.no, erc20Abi, "balanceOf", [ctx.addr.maker]),
    marginBalance(ctx, ctx.addr.maker, s.yes),
  ]);
  const walletYes = fromSizeUnits(wy), walletNo = fromSizeUnits(wn), marginYes = fromSizeUnits(my);
  return { walletYes, walletNo, marginYes, lockedYes, netYes: +(walletYes + marginYes + lockedYes - walletNo).toFixed(6) };
}

/** Top up margin when fills drained it (budgeted as "replenish"; minting is impossible after closeTime). */
async function replenish(ctx: Ctx, lad: LadderState, s: SeriesState, inv: { marginYes: number; lockedYes: number }, now: number) {
  const R = ctx.cfg.replenish;
  if (!R.enabled || now >= lad.closeTime - 300) return;
  if (inv.marginYes + inv.lockedYes >= R.minFreeYes) return;
  const amt = BigInt(R.mintSets) * 1_000_000n;
  const ausd = await read<bigint>(ctx, ctx.dep.ausd, erc20Abi, "balanceOf", [ctx.addr.maker]);
  if (ausd < amt) return ctx.log.warn(`replenish >=${s.strike}: maker wallet has only ${Number(ausd) / 1e6} AUSD`);
  await send(ctx, "maker", { to: ctx.dep.vault, abi: vaultCommonAbi, functionName: "mintSet", args: [s.seriesId, amt] }, { label: `replenish mintSet >=${s.strike} x${R.mintSets}`, kind: "replenish" });
  const allowance = await read<bigint>(ctx, s.yes, erc20Abi, "allowance", [ctx.addr.maker, ctx.dep.marginAccount]);
  if (allowance < amt) await send(ctx, "maker", { to: s.yes, abi: erc20Abi, functionName: "approve", args: [ctx.dep.marginAccount, 2n ** 256n - 1n] }, { label: `approve YES>=${s.strike} -> margin`, kind: "replenish" });
  await send(ctx, "maker", { to: ctx.dep.marginAccount, abi: marginAbi, functionName: "deposit", args: [ctx.addr.maker, s.yes, amt] }, { label: `replenish margin YES>=${s.strike}`, kind: "replenish" });
  note(ctx.state, "replenish", `${lad.key} >=${s.strike}: minted and deposited ${R.mintSets} YES`, now);
}

async function topUpAusd(ctx: Ctx, now: number, lad: LadderState) {
  const R = ctx.cfg.replenish;
  if (!R.enabled) return;
  const free = await marginBalance(ctx, ctx.addr.maker, ctx.dep.ausd);
  if (free >= BigInt(R.minFreeAusd) * 1_000_000n) return;
  const want = BigInt(R.topUpAusd) * 1_000_000n;
  const wallet = await read<bigint>(ctx, ctx.dep.ausd, erc20Abi, "balanceOf", [ctx.addr.maker]);
  const amt = wallet < want ? wallet : want;
  if (amt < 1_000_000n) return;
  const allowance = await read<bigint>(ctx, ctx.dep.ausd, erc20Abi, "allowance", [ctx.addr.maker, ctx.dep.marginAccount]);
  if (allowance < amt) await send(ctx, "maker", { to: ctx.dep.ausd, abi: erc20Abi, functionName: "approve", args: [ctx.dep.marginAccount, 2n ** 256n - 1n] }, { label: "approve AUSD -> margin", kind: "replenish" });
  await send(ctx, "maker", { to: ctx.dep.marginAccount, abi: marginAbi, functionName: "deposit", args: [ctx.addr.maker, ctx.dep.ausd, amt] }, { label: `top up margin AUSD ${Number(amt) / 1e6}`, kind: "replenish" });
  note(ctx.state, "replenish", `${lad.key}: margin AUSD topped up by ${Number(amt) / 1e6}`, now);
}

/** One pass over one ladder. `opts.quoteKind` is the budget kind of new quotes ("quote"; the roll passes "roll" for the
 *  opening quotes when the config has a separate roll budget). */
export async function tickLadder(ctx: Ctx, lad: LadderState, data: MarketData, opts: { quoteKind?: SpendKind } = {}): Promise<LadderTick> {
  ctx.gasPriceWei = undefined;
  const now = await nowSec(ctx);
  const res: LadderTick = { key: lad.key, now, data: null, fairs: [], strikes: [], actions: [], marginAusd: null };
  if (lad.status === "closed") return res;
  if (now >= lad.stopAt - ctx.cfg.policy.preStopSec) {
    const k = await killLadder(ctx, lad, "stop-quoting time (tick)");
    res.actions.push({ strike: 0, kind: "close", reasons: [`kill switch: cancelled ${k.cancelled}`] });
    return res;
  }
  const d = await data.get(lad.station, lad.isoDate, now * 1000);
  res.data = d;
  // guard-wide hysteresis (fair.guardWarnExit) keys on the spread the resting quote was placed with; a lastQuote
  // without `wide` (older state, the shadow's mirror of the live maker) keeps the plain guardWarn threshold
  const restingWide: Record<number, boolean> = {};
  for (const k of lad.strikes) {
    const s = lad.series[k];
    if (s?.lastQuote?.wide === true && (s.orders.bid || s.orders.ask)) restingWide[k] = true;
  }
  const fairs = computeFairs({ strikes: lad.strikes, nowMs: now * 1000, localMinute: d.localMinute, pm: d.pm, pmFetchedMs: d.pmFetchedMs, obs: d.obs, v0: d.v0, intraday: d.intraday, restingWide, cfg: ctx.cfg.fair });
  res.fairs = fairs;
  if (lad.status === "active" && !lad.paused && !ctx.cfg.dryRun)
    try {
      await topUpAusd(ctx, now, lad);
    } catch (e) {
      ctx.log.warn(`AUSD top-up skipped: ${explainRevert(e)}`);
    }
  for (const f of fairs) {
    const s = lad.series[f.k];
    const view: StrikeView = { strike: f.k, seriesId: s?.seriesId ?? ("0x" as Hex), market: s?.market ?? null, mode: s?.mode ?? "pending", fair: f, desired: null, action: null, resting: {}, inventory: null, book: null };
    res.strikes.push(view);
    if (!s?.market || s.market === ZERO) continue;
    try {
      // ---- resting orders (tracked ids; one multicall)
      const ids = [s.orders.bid?.id, s.orders.ask?.id].filter((x): x is number => typeof x === "number");
      const st = await orderStatus(ctx, s.market, ctx.addr.maker, ids);
      for (const o of st) if (o.open) view.resting[o.isBuy ? "bid" : "ask"] = { id: o.id, price: o.price, remaining: o.remaining };
      // ---- inventory & book
      let inv = await inventory(ctx, s, view.resting.ask?.remaining ?? 0);
      if (lad.status === "active" && !lad.paused && !ctx.cfg.dryRun && f.certain === null && view.mode !== "closed") {
        try {
          await replenish(ctx, lad, s, inv, now);
          inv = await inventory(ctx, s, view.resting.ask?.remaining ?? 0);
        } catch (e) {
          ctx.log.warn(`replenish >=${f.k} skipped: ${explainRevert(e)}`);
        }
      }
      view.inventory = inv;
      const freeAusd = fromSizeUnits(await marginBalance(ctx, ctx.addr.maker, ctx.dep.ausd)) + (view.resting.bid ? view.resting.bid.remaining * view.resting.bid.price : 0);
      res.marginAusd = fromSizeUnits(await marginBalance(ctx, ctx.addr.maker, ctx.dep.ausd));
      const book = await getBook(ctx, s.market);
      view.book = book;
      const others = othersBest(book, { bid: view.resting.bid && { price: view.resting.bid.price, size: view.resting.bid.remaining }, ask: view.resting.ask && { price: view.resting.ask.price, size: view.resting.ask.remaining } });
      const desired = makeQuote({ fair: f.fair, source: f.source, flags: f.flags, netYes: inv.netYes, freeYes: inv.marginYes + inv.lockedYes, freeAusd, others, cfg: ctx.cfg.quote });
      view.desired = desired;
      const action = decide({ now, stopAt: lad.stopAt, mode: s.mode, certain: f.certain === "yes", fair: f.fair, desired, resting: view.resting, lastQuote: s.lastQuote, cfg: { ...ctx.cfg.policy, tick: ctx.cfg.quote.tick } });
      if (lad.paused || lad.status !== "active") {
        view.action = { kind: "none", urgent: false, reasons: [lad.paused ? "ladder paused (manual pull)" : `ladder ${lad.status}`] };
        continue;
      }
      view.action = action;
      const act: TickAction = { strike: f.k, kind: action.kind, reasons: action.reasons };
      res.actions.push(act);
      const cancelIds = [view.resting.bid?.id, view.resting.ask?.id].filter((x): x is number => typeof x === "number");
      if (action.kind === "none") {
        if (action.mode && action.mode !== s.mode && !ctx.cfg.dryRun) s.mode = action.mode;
        continue;
      }
      if (action.kind === "pull" || action.kind === "close") {
        await pull(ctx, s, cancelIds, action.kind === "close" ? "kill" : "pull", `${action.kind === "close" ? "KILL" : "pull"} >=${f.k}: ${action.reasons[0]}`, act);
        if (!ctx.cfg.dryRun) {
          s.mode = action.mode ?? "pulled";
          s.reason = action.reasons.join("; ");
          s.lastPullAt = now;
          if (act.tx) (view.resting = {}), (view.book = await getBook(ctx, s.market));
        }
        continue;
      }
      // quote / requote: one batchUpdate (cancels first, then places; post-only)
      if (desired.pull) continue;
      const bids = desired.bid !== null ? [{ p: desired.bid, s: desired.bidSize }] : [];
      const asks = desired.ask !== null ? [{ p: desired.ask, s: desired.askSize }] : [];
      try {
        const r = await send(
          ctx,
          "maker",
          { to: s.market, abi: kuruBookAbi, functionName: "batchUpdate", args: [bids.map((x) => toPriceUnits(x.p)), bids.map((x) => toSizeUnits(x.s)), asks.map((x) => toPriceUnits(x.p)), asks.map((x) => toSizeUnits(x.s)), cancelIds, true] },
          { label: `${action.kind} >=${f.k} ${desired.bidSize}@${desired.bid ?? "-"} / ${desired.askSize}@${desired.ask ?? "-"}${cancelIds.length ? ` cancel ${cancelIds.length}` : ""}`, kind: opts.quoteKind ?? "quote" },
        );
        if (r.dryRun) continue;
        act.tx = r.hash;
        const created = createdOrders(r.receipt, s.market);
        s.orders = {};
        for (const o of created) s.orders[o.isBuy ? "bid" : "ask"] = { id: o.id, price: o.price, size: o.size, placedAt: now };
        s.lastQuote = { fair: f.fair!, bid: desired.bid, ask: desired.ask, bidSize: desired.bidSize, askSize: desired.askSize, at: now, tx: r.hash, wide: f.flags.includes("guard-wide") };
        s.mode = "quoting";
        s.reason = action.reasons.join("; ");
        ctx.save();
        // the snapshot shows the book as it is AFTER this tick's action
        view.resting = {};
        if (s.orders.bid) view.resting.bid = { id: s.orders.bid.id, price: s.orders.bid.price, remaining: s.orders.bid.size };
        if (s.orders.ask) view.resting.ask = { id: s.orders.ask.id, price: s.orders.ask.price, remaining: s.orders.ask.size };
        view.book = await getBook(ctx, s.market);
      } catch (e) {
        act.error = explainRevert(e);
        if (e instanceof BudgetRefused) {
          ctx.log.warn(`>=${f.k} ${action.kind} refused by the MON budget: ${e.message}`);
          note(ctx.state, "budget", `${lad.key} >=${f.k}: ${action.kind} refused (${e.message})`, now);
          if (action.urgent) await pull(ctx, s, cancelIds, "pull", `pull >=${f.k}: urgent but no budget to re-quote`, act);
        } else {
          ctx.log.warn(`>=${f.k} ${action.kind} failed: ${act.error}`);
          if (action.urgent && !(e instanceof LiveRefused)) await pull(ctx, s, cancelIds, "pull", `pull >=${f.k}: re-quote failed`, act);
        }
      }
    } catch (e) {
      ctx.log.error(`tick ${lad.key} >=${f.k}: ${explainRevert(e)}`);
      res.actions.push({ strike: f.k, kind: "error", reasons: [], error: explainRevert(e) });
    }
  }
  ctx.save();
  return res;
}

async function pull(ctx: Ctx, s: SeriesState, ids: number[], kind: "pull" | "kill", label: string, act: TickAction) {
  if (!ids.length) {
    s.orders = {};
    return;
  }
  try {
    const r = await send(ctx, "maker", { to: s.market!, abi: kuruBookAbi, functionName: "batchCancelOrdersNoRevert", args: [ids] }, { label, kind });
    if (r.dryRun) return;
    act.tx = r.hash;
    s.orders = {};
    ctx.save();
  } catch (e) {
    act.error = explainRevert(e);
    ctx.log.error(`${label} FAILED: ${act.error}`);
  }
}
