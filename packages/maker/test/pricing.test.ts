import { test } from "node:test";
import assert from "node:assert/strict";
import { makeQuote, type QuoteInput } from "../src/pricing.ts";
import type { QuoteCfg } from "../src/config.ts";

const cfg: QuoteCfg = { tick: 0.01, kuruTick: 0.001, halfSpreadTicks: 3, minPrice: 0.01, maxPrice: 0.99, pullBelow: 0.03, pullAbove: 0.97, guardWidenMult: 2, fallbackWidenMult: 2, sizeYes: 100, maxPositionYes: 300, skewTicksAtCap: 2, minOrderYes: 1 };
const base: QuoteInput = { fair: 0.47, source: "polymarket", flags: [], netYes: 0, freeYes: 300, freeAusd: 400, others: { bid: null, ask: null }, cfg };
const q = (o: Partial<QuoteInput>) => makeQuote({ ...base, ...o });
const quoted = (o: Partial<QuoteInput>) => {
  const r = q(o);
  if (r.pull) throw new Error("expected a quote, got pull: " + r.reasons.join("; "));
  return r;
};

test("symmetric quote: 3 ticks each side, outward rounding, full size", () => {
  const r = quoted({});
  assert.deepEqual([r.bid, r.ask, r.bidSize, r.askSize], [0.44, 0.5, 100, 100]);
  const off = quoted({ fair: 0.505 });
  assert.deepEqual([off.bid, off.ask], [0.47, 0.54]);
});

test("bid < fair < ask even when fair sits exactly on the grid", () => {
  const r = quoted({ fair: 0.5 });
  assert.ok(r.bid! < 0.5 && r.ask! > 0.5);
  assert.deepEqual([r.bid, r.ask], [0.47, 0.53]);
});

test("price band and near-certain outcomes: clamp to [0.01, 0.99], pull at <= 0.03 / >= 0.97", () => {
  const lo = quoted({ fair: 0.035 });
  assert.deepEqual([lo.bid, lo.ask], [0.01, 0.07]);
  const hi = quoted({ fair: 0.965 });
  assert.deepEqual([hi.bid, hi.ask], [0.93, 0.99]);
  assert.equal(q({ fair: 0.03 }).pull, true);
  assert.equal(q({ fair: 0.97 }).pull, true);
  assert.equal(q({ fair: null, source: "none" }).pull, true);
});

test("guard disagreement and fallback fair widen the spread; guard-pull pulls", () => {
  assert.deepEqual(((r) => [r.bid, r.ask])(quoted({ flags: ["guard-wide"] })), [0.41, 0.53]);
  assert.deepEqual(((r) => [r.bid, r.ask])(quoted({ source: "fallback-v0" })), [0.41, 0.53]);
  assert.deepEqual(((r) => [r.bid, r.ask])(quoted({ source: "fallback-v0", flags: ["guard-wide"] })), [0.35, 0.59]);
  assert.equal(q({ flags: ["guard-pull"] }).pull, true);
});

test("inventory skew and caps: long YES lowers quotes and stops bidding at the cap", () => {
  const half = quoted({ netYes: 150 }); // skew -1 tick
  assert.deepEqual([half.bid, half.ask], [0.43, 0.49]);
  assert.equal(half.bidSize, 100);
  const cap = quoted({ netYes: 300 }); // skew -2 ticks, no room to buy
  assert.equal(cap.bid, null);
  assert.equal(cap.ask, 0.48);
  const short = quoted({ netYes: -250 }); // skew +1.67 ticks, ask room 50
  assert.equal(short.askSize, 50);
  assert.ok(short.bid! > 0.44 && short.bid! < 0.47);
  const nearCap = quoted({ netYes: 260 });
  assert.equal(nearCap.bidSize, 40); // never buy past the cap
});

test("post-only safety: never cross someone else's quote", () => {
  const r = quoted({ others: { bid: null, ask: 0.43 } });
  assert.equal(r.bid, 0.42);
  const s = quoted({ others: { bid: 0.52, ask: null } });
  assert.equal(s.ask, 0.53);
  const t = quoted({ fair: 0.04, others: { bid: null, ask: 0.01 } }); // nothing below the floor -> no bid
  assert.equal(t.bid, null);
});

test("sizes follow free margin; dust below the minimum order is dropped", () => {
  const r = quoted({ freeAusd: 10, freeYes: 5 });
  assert.equal(r.bidSize, 22); // 10 / 0.44
  assert.equal(r.askSize, 5);
  const none = q({ freeAusd: 0.2, freeYes: 0.5 });
  assert.equal(none.pull, true);
});

test("property: 5000 random inputs never produce a crossed, off-grid, out-of-band or negative-edge quote", () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 5000; i++) {
    const fair = 0.031 + rnd() * 0.938;
    const ob = rnd() < 0.5 ? null : Math.round(rnd() * 990) / 1000 + 0.001;
    const oa = rnd() < 0.5 ? null : Math.max(ob ?? 0, Math.round(rnd() * 990) / 1000) + 0.001;
    const r = q({ fair, netYes: (rnd() - 0.5) * 800, freeYes: rnd() * 400, freeAusd: rnd() * 400, others: { bid: ob, ask: oa }, flags: rnd() < 0.2 ? ["guard-wide"] : [] });
    if (r.pull) continue;
    const onGrid = (p: number) => Math.abs(p * 100 - Math.round(p * 100)) < 1e-6;
    if (r.bid !== null) {
      assert.ok(r.bid < fair && r.bid >= 0.01 && onGrid(r.bid), `bid ${r.bid} fair ${fair}`);
      if (oa !== null) assert.ok(r.bid < oa - 1e-9, `bid ${r.bid} crosses others' ask ${oa}`);
      assert.ok(r.bidSize >= 1);
    }
    if (r.ask !== null) {
      assert.ok(r.ask > fair && r.ask <= 0.99 && onGrid(r.ask), `ask ${r.ask} fair ${fair}`);
      if (ob !== null) assert.ok(r.ask > ob + 1e-9, `ask ${r.ask} crosses others' bid ${ob}`);
      assert.ok(r.askSize >= 1);
    }
    if (r.bid !== null && r.ask !== null) assert.ok(r.bid < r.ask);
  }
});
