// Order reconciliation: make the tracked Kuru order ids match the maker's open orders on chain.
//
// The Node runner trusts its state file (it is the only writer, and the state never gets lost). The Worker also has
// to handle: (a) SHADOW mode, where the orders on the books are the live Mac maker's, so the shadow tracks them to
// decide what it WOULD do about them; (b) the cutover, where live state may start without the Mac's order ids; and
// (c) a tick that died between broadcast and receipt (new orders on the book, their ids not in state).
// Per strike: read the book's order counter (one call); only when it moved since the last look, scan the new ids
// (bounded to the last 300, as the kill switch does) for open orders owned by the maker. The newest open bid / ask
// become the tracked ones when the tracked side is missing or closed; any other open maker order is an orphan:
// LIVE cancels it (kind "pull"), SHADOW records that it would.
import type { Address, Hex } from "viem";
import { kuruBookAbi } from "../../../packages/maker/src/abis.ts";
import { explainRevert, send, type Ctx } from "../../../packages/maker/src/chain.ts";
import { orderStatus, type OpenOrder } from "../../../packages/maker/src/kuru.ts";
import type { LadderState } from "../../../packages/maker/src/state-core.ts";
import type { Store } from "./store.ts";

export const SCAN_WINDOW = 300;

export interface ReconcileResult {
  strike: number;
  market: Address;
  counter: number;
  scanned: number;
  open: number;
  adopted: { bid?: number; ask?: number };
  orphans: number[];
  cancelTx?: Hex;
  error?: string;
}

export async function reconcileLadder(ctx: Ctx, lad: LadderState, store: Store, mode: "shadow" | "live", nowSec: number): Promise<ReconcileResult[]> {
  const out: ReconcileResult[] = [];
  for (const k of lad.strikes) {
    const s = lad.series[k];
    if (!s?.market || s.mode === "closed") continue;
    const memo = `rc:${mode}:${s.market.toLowerCase()}`;
    const res: ReconcileResult = { strike: k, market: s.market, counter: 0, scanned: 0, open: 0, adopted: {}, orphans: [] };
    try {
      const counter = Number(await ctx.pub.readContract({ address: s.market, abi: kuruBookAbi, functionName: "s_orderIdCounter" }));
      res.counter = counter;
      const last = store.get<number>(memo);
      if (last === counter) continue; // nothing new on this book since the last look
      const from = Math.max(1, last === undefined ? counter - SCAN_WINDOW + 1 : Math.max(last + 1, counter - SCAN_WINDOW + 1));
      const ids: number[] = [];
      for (let id = from; id <= counter; id++) ids.push(id);
      const tracked = [s.orders.bid?.id, s.orders.ask?.id].filter((x): x is number => typeof x === "number" && !ids.includes(x));
      const all = [...tracked, ...ids];
      const st: OpenOrder[] = [];
      for (let i = 0; i < all.length; i += 100) st.push(...(await orderStatus(ctx, s.market, ctx.addr.maker, all.slice(i, i + 100))));
      res.scanned = ids.length;
      const open = st.filter((o) => o.open);
      res.open = open.length;
      const newest = (isBuy: boolean) => open.filter((o) => o.isBuy === isBuy).sort((a, b) => b.id - a.id)[0];
      const isOpen = (id: number | undefined) => id !== undefined && open.some((o) => o.id === id);
      for (const [side, isBuy] of [["bid", true], ["ask", false]] as const) {
        const cur = s.orders[side];
        const n = newest(isBuy);
        // shadow follows the books exactly (they are the live maker's); live keeps its own tracked order while open
        const keep = mode === "live" && cur && isOpen(cur.id);
        if (keep) continue;
        if (n) {
          if (cur?.id !== n.id) res.adopted[side] = n.id;
          s.orders[side] = { id: n.id, price: n.price, size: n.remaining, placedAt: cur?.id === n.id ? cur.placedAt : nowSec };
        } else if (cur && !isOpen(cur.id) && mode === "shadow") delete s.orders[side];
      }
      if (open.length && s.mode === "pending") s.mode = "quoting";
      res.orphans = open.filter((o) => o.id !== s.orders.bid?.id && o.id !== s.orders.ask?.id).map((o) => o.id);
      if (res.orphans.length) {
        if (mode === "live") {
          const r = await send(ctx, "maker", { to: s.market, abi: kuruBookAbi, functionName: "batchCancelOrdersNoRevert", args: [res.orphans] }, { label: `reconcile >=${k} cancel ${res.orphans.length} untracked order(s)`, kind: "pull" });
          if (!r.dryRun) res.cancelTx = r.hash;
        } else ctx.log.info(`shadow: >=${k} has ${res.orphans.length} more open maker order(s) than one bid + one ask (${res.orphans.join(",")})`);
      }
      store.put(memo, counter);
    } catch (e) {
      res.error = explainRevert(e);
      ctx.log.warn(`reconcile ${lad.key} >=${k}: ${res.error}`);
    }
    out.push(res);
  }
  if (out.some((r) => Object.keys(r.adopted).length || r.cancelTx)) ctx.save();
  return out;
}
