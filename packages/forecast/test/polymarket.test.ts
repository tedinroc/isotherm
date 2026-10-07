import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bucketPrice, ladderFromGamma, pAtLeast, pickStrikes } from "../src/polymarket.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8"));
const OCT8 = fx("gamma_taipei_2026-10-08.json")[0]; // captured 2026-10-07 04:51Z, D-1
const OCT7 = fx("gamma_taipei_2026-10-07_intraday.json")[0]; // captured 2026-10-07 ~04:52Z, day D (obs max 28 by 12:30)

test("bucketPrice: mid, wide spread -> last or mid-wide, one-sided books, fallbacks", () => {
  assert.deepEqual(bucketPrice(0.39, 0.4, 0.4, 0.395), { price: 0.395, priceSource: "mid", spread: 0.010000000000000009, illiquid: false });
  assert.equal(bucketPrice(0.1, 0.5, 0.2, null).priceSource, "last"); // spread 0.4 > 0.10, last inside
  assert.equal(bucketPrice(0.1, 0.5, 0.2, null).price, 0.2);
  assert.equal(bucketPrice(0.1, 0.5, 0.9, null).priceSource, "mid-wide"); // last outside the book
  assert.equal(bucketPrice(0.1, 0.5, 0.9, null).price, 0.3);
  assert.equal(bucketPrice(null, 0.002, null, 0.001).price, 0.001); // tail: no bids -> half the ask
  assert.equal(bucketPrice(0, 0.002, null, null).priceSource, "ask-half"); // CLOB reports bid "0" when empty
  assert.equal(bucketPrice(0.97, null, null, null).priceSource, "bid-only");
  assert.equal(bucketPrice(null, null, null, 0.42).priceSource, "outcome");
  assert.equal(bucketPrice(null, null, null, null).priceSource, "none");
});

test("Oct 8 ladder from Gamma quotes: normalised, cumulative, monotone, median, determined strikes", () => {
  const l = ladderFromGamma(OCT8, "RCSS", null, "2026-10-07T04:51:00Z");
  assert.equal(l.ok, true, l.warnings.join(";"));
  assert.equal(l.quoteSource, "gamma");
  assert.equal(l.slug, "highest-temperature-in-taipei-on-october-8-2026");
  assert.equal(l.settlementSource, "wunderground:RCSS");
  assert.deepEqual(l.strikes, [25, 26, 27, 28, 29, 30, 31, 32, 33, 34]);
  assert.ok(Math.abs(l.sumRaw - 1.039) < 1e-9);
  assert.ok(Math.abs(l.ladder[30] - (0.39 + 0.075 + 0.0135 + 0.0045 + 0.008) / 1.039) < 1e-5);
  for (let k = 26; k <= 34; k++) assert.ok(l.ladder[k] <= l.ladder[k - 1] + 1e-12, `monotone at ${k}`);
  assert.equal(l.median, 29); // P(>=29)=0.853, P(>=30)=0.473
  assert.ok(Math.abs(l.buckets.reduce((s, b) => s + b.p, 0) - 1) < 1e-5);
});

test("CLOB quotes override Gamma per token (Gamma can lag the book)", () => {
  const tok34 = JSON.parse(OCT8.markets.find((m: any) => m.groupItemTitle === "34°C or higher").clobTokenIds)[0];
  const clob = new Map([[tok34, { bid: 0.001, ask: 0.004 }]]);
  const l = ladderFromGamma(OCT8, "RCSS", clob, "t");
  const b = l.buckets.find((x) => x.label === "34°C or higher")!;
  assert.equal(b.quoteSource, "clob");
  assert.equal(b.price, 0.0025);
  assert.equal(l.quoteSource, "mixed");
});

test("day-D ladder: empty-bid tails priced at half the ask; strikes at/below the observed max ~1", () => {
  const l = ladderFromGamma(OCT7, "RCSS", null, "t");
  assert.equal(l.ok, true, l.warnings.join(";"));
  assert.ok(l.ladder[28] > 0.99);
  assert.ok(l.ladder[29] > 0.05 && l.ladder[29] < 0.2);
  assert.equal(l.buckets.find((b) => b.label === "23°C")!.priceSource, "ask-half");
});

test("broken inputs are flagged not ok: grid gap, sum out of band, other settlement station, closed", () => {
  const gap = structuredClone(OCT8);
  gap.markets = gap.markets.filter((m: any) => m.groupItemTitle !== "30°C");
  const lg = ladderFromGamma(gap, "RCSS", null, "t");
  assert.equal(lg.ok, false);
  assert.ok(lg.warnings.some((w) => w.includes("grid gap")));
  const cheap = structuredClone(OCT8);
  for (const m of cheap.markets) (m.bestBid = 0.01), (m.bestAsk = 0.02);
  assert.equal(ladderFromGamma(cheap, "RCSS", null, "t").ok, false);
  const other = structuredClone(OCT8);
  other.resolutionSource = "https://www.cwa.gov.tw/";
  other.description = "resolves on CWA station 46692";
  assert.equal(ladderFromGamma(other, "RCSS", null, "t").ok, false);
  const closed = structuredClone(OCT8);
  closed.closed = true;
  assert.equal(ladderFromGamma(closed, "RCSS", null, "t").ok, false);
});

test("pAtLeast: exact on the grid, bounded extrapolation off it", () => {
  const l = ladderFromGamma(OCT8, "RCSS", null, "t");
  assert.deepEqual(pAtLeast(l, 30), { p: l.ladder[30], determined: true });
  const lo = pAtLeast(l, 22);
  assert.equal(lo.determined, false);
  assert.ok(lo.p >= l.ladder[25] && lo.p <= 1);
  const hi = pAtLeast(l, 37);
  assert.ok(hi.p <= l.ladder[34] && hi.p >= 0);
});

test("pickStrikes: most-uncertain consecutive window around the median, edges outside [0.03,0.97] trimmed", () => {
  const l = ladderFromGamma(OCT8, "RCSS", null, "t");
  assert.deepEqual(pickStrikes(l), [28, 29, 30, 31]); // 32 (P=0.025) trimmed; min 4 kept
  assert.deepEqual(pickStrikes(l, { count: 6, minCount: 6 }), [27, 28, 29, 30, 31, 32]);
  assert.deepEqual(pickStrikes(l, { mode: "offsets", offsets: [-1, 0, 1, 2], minCount: 4 }), [28, 29, 30, 31]);
  assert.deepEqual(pickStrikes({ ladder: {}, strikes: [], median: null }), []);
});
