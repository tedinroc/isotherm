// scripts/shadow-compare.mjs: the cutover review's tick-by-tick shadow vs live-maker classification.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs operator script (no types)
import { compare, macTxs } from "../../scripts/shadow-compare.mjs";

const strike = (k: number, o: Record<string, unknown>) => ({ key: "RCSS:20261009", k, fair: 0.686, guard: 0.8364, flags: [], action: "none", desired: "0.65/0.72", resting: "0.65/0.72", reasons: "", mac: { fair: 0.686, guard: 0.8364, quote: "0.65/0.72", mode: "quoting" }, ...o });
const tick = (at: string, strikes: unknown[]) => ({ at, ms: 4000, mode: "shadow", block: 1, intents: [], txs: [], errors: [], alerts: [], kill: [], rolls: [], strikes });
const log = (t: string, msg: string) => JSON.stringify({ t, level: "info", msg });

describe("shadow-compare", () => {
  it("agrees on quiet ticks and on a would-send the live maker also sent; classifies a v0-refresh disagreement as timing", () => {
    const ticks = [
      tick("2026-10-08T16:47:00.000Z", [strike(30, {})]),
      // the shadow predicts a requote the live maker sends 9 s later
      tick("2026-10-08T16:59:00.000Z", [strike(29, { fair: 0.9175, action: "requote", desired: "0.88/0.95", resting: "0.9/0.97", mac: { fair: 0.9272, guard: 0.9529, quote: "0.9/0.97", mode: "quoting" } })]),
      // the shadow's hourly v0 guard is older: guard-wide on its side only
      tick("2026-10-08T17:00:00.000Z", [strike(30, { fair: 0.686, guard: 0.8364, flags: ["guard-wide"], action: "requote", desired: "0.62/0.75", mac: { fair: 0.686, guard: 0.8353, quote: "0.65/0.72", mode: "quoting" } })]),
      tick("2026-10-08T17:01:00.000Z", [strike(29, { fair: 0.9175, desired: "0.88/0.95", resting: "0.88/0.95" })]),
    ];
    const txs = macTxs([log("2026-10-08T16:59:09.000Z", "tx maker         requote >=29 100@0.88 / 100@0.95 cancel 2        used   536884 limit   536884 0.0548 MON 2018ms 0xabc"), log("2026-10-08T16:59:10.000Z", "tick 1 done in 20000 ms; no changes")].join("\n"));
    expect(txs).toEqual([expect.objectContaining({ kind: "requote", k: 29, bid: 0.88, ask: 0.95 })]);
    const r = compare(ticks, txs);
    expect(r.pairs).toBe(4);
    expect(r.verdicts).toEqual({ agree: 2, "agree (the live maker sent the same tx)": 1, "timing: v0 guard refreshed at another minute": 1 });
    expect(r.macVerdicts).toEqual({ "predicted by the shadow": 1 });
    expect(r.agreementPct).toBe(75);
    expect(r.explainedPct).toBe(100);
  });

  it("flags a live-maker tx the shadow never wanted, and a would-send with identical inputs, as UNEXPLAINED", () => {
    const ticks = [tick("2026-10-08T17:00:00.000Z", [strike(31, { action: "requote", desired: "0.17/0.3" })]), tick("2026-10-08T17:01:00.000Z", [strike(31, {})]), tick("2026-10-08T17:02:00.000Z", [strike(31, {})])];
    const txs = macTxs(log("2026-10-08T17:01:30.000Z", "tx maker         requote >=31 100@0.2 / 100@0.33 cancel 2        used   567427 limit   567427 0.0579 MON 1009ms 0xdef"));
    const r = compare(ticks, txs);
    expect(r.verdicts).toEqual({ agree: 2, UNEXPLAINED: 1 });
    expect(r.macVerdicts).toEqual({ UNEXPLAINED: 1 });
  });
});
