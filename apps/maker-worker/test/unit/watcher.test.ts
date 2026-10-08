// The challenge watcher (port of the Mac's challenge-watch.ts) against the fake chain and recorded METAR archives:
// eth_getLogs pages of at most 100 blocks, MATCH / MISMATCH verdicts from the CRE workflow's own decide(), the
// challenge only in live mode with a matching guardian key, and the live guardian key refused on a fork.
import { stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { canonicalSources, recompute, watchPass, type WatchDeps } from "../../src/watcher.ts";
import { NonceTracker } from "../../src/nonces.ts";
import { MemStore } from "../../src/store.ts";
import { D, FakeChain } from "./fake-chain.ts";
import { fixtureSources, GUARDIAN, world } from "./helpers.ts";

function deps(chain: FakeChain, over: Partial<WatchDeps> = {}): WatchDeps {
  const store = new MemStore();
  return {
    pub: chain.publicClient(),
    store,
    resolver: D.resolver,
    vault: D.vault,
    stations: ["RCSS", "RJTT"],
    liveRpc: true,
    liveGuardian: D.guardian,
    live: false,
    guardian: GUARDIAN,
    autoChallenge: true,
    lookbackBlocks: 4000,
    recheckSec: 0,
    backstopSec: 600,
    gasMult: 1.1,
    sources: fixtureSources(),
    wallet: chain.wallet() as any,
    nonces: new NonceTracker(store, () => chain.time * 1000),
    alert: () => {},
    log: () => {},
    sleep: async () => {},
    now: () => chain.time * 1000,
    ...over,
  };
}

describe("challenge watcher", () => {
  it("recomputes with the CRE rule (fixtures: RCSS 2026-10-05 settles 29 on IEM + AWC)", async () => {
    const x = await recompute("RCSS", 20261005, fixtureSources());
    expect(x.d).toMatchObject({ status: "SETTLED", tmaxC: 29, reason: "primary sources agree" });
    expect(x.canonical).toMatch(/^isotherm-sources-v1\|RCSS\|20261005\|SETTLED\|IEM:29,\d+,\d+,\d\d:\d\d,1\|AWC:29,\d+,\d+,\d\d:\d\d,1\|OGIMET:-$/);
    expect(x.usedOgimet).toBe(false);
    // the canonical summary format is the CRE report.ts one (sample line from packages/cre-workflow/evidence/fork-e2e.txt)
    expect(canonicalSources("RCSS", 20261008, "SETTLED", [{ name: "IEM", stats: { tmaxC: 29, nObs: 50, nHours: 24, lastLocal: "23:30", complete: true, split: false, healthy: true } }, { name: "AWC", stats: { tmaxC: 29, nObs: 50, nHours: 24, lastLocal: "23:30", complete: true, split: false, healthy: true } }, { name: "OGIMET", stats: null }])).toBe(
      "isotherm-sources-v1|RCSS|20261008|SETTLED|IEM:29,50,24,23:30,1|AWC:29,50,24,23:30,1|OGIMET:-",
    );
  });

  it("pages eth_getLogs in <= 100 blocks; a correct result is a MATCH; a wrong one in SHADOW is alerted, simulated, not sent", async () => {
    const w = world();
    const c = w.chain;
    c.mine(10);
    const d = deps(c);
    // first pass establishes the cursor (bounded lookback)
    await watchPass(d);
    c.mine(37);
    c.resolve("RJTT", 20261005, 0); // placeholder, replaced below by the real value
    const rj = await recompute("RJTT", 20261005, fixtureSources());
    c.results.get(`${stringToHex("RJTT", { size: 4 }).toLowerCase()}:20261005`)!.tmaxC = rj.d.tmaxC!;
    c.mine(120);
    c.resolve("RCSS", 20261005, 31); // the rule says 29
    c.mine(90);
    const alerts: string[] = [];
    const r = await watchPass({ ...d, alert: (t) => alerts.push(t) });
    expect(c.getLogsRanges.every(([a, b]) => b - a + 1n <= 100n)).toBe(true);
    expect(r.pages).toBe(Math.ceil((r.head - r.from + 1) / 100));
    expect(r.events).toBe(2);
    const v = Object.fromEntries(r.verdicts.map((x) => [x.key, x]));
    expect(v["RJTT:20261005"].verdict).toBe("MATCH");
    expect(v["RCSS:20261005"]).toMatchObject({ verdict: "MISMATCH-NOT-CHALLENGED", final: false, action: "shadow mode: challenge NOT sent (would send it now)" });
    expect(r.intents).toEqual([expect.objectContaining({ key: "RCSS:20261005", gasLimit: String(Math.ceil(44_000 * 1.1)) })]);
    expect(alerts).toEqual(expect.arrayContaining([expect.stringMatching(/^MISMATCH RCSS:20261005: reported Settled 31 C, the rule gives 29 C/), expect.stringMatching(/NOT CHALLENGED/)]));
    expect(c.sent).toEqual([]);
    // the MATCH is final; the mismatch is re-examined next pass
    const again = await watchPass({ ...d, alert: () => {} });
    expect(again.verdicts.map((x) => x.key)).toEqual(["RCSS:20261005"]);
  });

  it("LIVE with the guardian key: challenges a reproduced mismatch inside the window (Void)", async () => {
    const w = world();
    const c = w.chain;
    c.guardian = GUARDIAN.address;
    c.resolve("RCSS", 20261005, 31);
    c.mine(5);
    const r = await watchPass(deps(c, { live: true }));
    expect(r.challenges).toEqual([expect.objectContaining({ key: "RCSS:20261005", ok: true })]);
    expect(c.sent.map((t) => [t.functionName, t.from, t.gas])).toEqual([["challenge", GUARDIAN.address, BigInt(Math.ceil(44_000 * 1.1))]]);
    expect(c.results.get(`${stringToHex("RCSS", { size: 4 }).toLowerCase()}:20261005`)!.status).toBe(2);
    expect(r.verdicts[0].verdict).toBe("MISMATCH-CHALLENGED");
  });

  it("LIVE but the guardian key does not match Resolver.guardian(), or auto-challenge is off, or the window closed: no tx", async () => {
    for (const [over, why] of [
      [{}, /guardian key .* != Resolver.guardian\(\)/],
      [{ autoChallenge: false }, /WATCH_AUTO_CHALLENGE=0/],
    ] as const) {
      const c = world().chain; // its guardian is the deployment's, not our test key
      c.resolve("RCSS", 20261005, 31);
      const r = await watchPass(deps(c, { live: true, ...over }));
      expect(r.verdicts[0].action).toMatch(why);
      expect(c.sent).toEqual([]);
    }
    const c = world().chain;
    c.guardian = GUARDIAN.address;
    c.resolve("RCSS", 20261005, 31);
    c.time += 901;
    c.mine();
    const r = await watchPass(deps(c, { live: true }));
    expect(r.verdicts[0].verdict).toBe("MISMATCH-WINDOW-CLOSED");
    expect(c.sent).toEqual([]);
  });

  it("refuses the LIVE guardian key on a fork (a tx signed for 10143 there is valid on live)", async () => {
    const c = world().chain;
    c.guardian = GUARDIAN.address;
    c.resolve("RCSS", 20261005, 31);
    const r = await watchPass(deps(c, { live: true, liveRpc: false, liveGuardian: GUARDIAN.address }));
    expect(r.guardian).toMatch(/REFUSED: the LIVE guardian key on a non-live RPC/);
    expect(c.sent).toEqual([]);
  });
});
