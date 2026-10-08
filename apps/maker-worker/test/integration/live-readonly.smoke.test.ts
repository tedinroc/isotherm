// READ-ONLY smoke of the bundled Worker in Miniflare/workerd against the LIVE Monad testnet RPC and the real public
// data sources (Polymarket Gamma + CLOB, aviationweather + IEM METARs, Open-Meteo for the v0 guard), in SHADOW mode
// with NO key secrets at all: the watch-only MAKER_ADDRESS / OPERATOR_ADDRESS (public, in deployments and the API
// config) are mirrored, so nothing can be signed, let alone sent. The API binding is a stand-in that relays GET
// /api/snapshot to the public site (for the shadow-vs-live comparison) and refuses anything else.
// Opt-in: MW_LIVE_SMOKE=1 npx vitest run test/integration/live-readonly.smoke.test.ts   (Miniflare port 19803)
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Response as MfResponse } from "miniflare";
import { describe, expect, it } from "vitest";

const RUN_IT = process.env.MW_LIVE_SMOKE === "1";
const PKG = fileURLToPath(new URL("../..", import.meta.url));
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN = join(PKG, ".test-run", `smoke-${STAMP}`);
const OUT = join(PKG, "evidence", `live-readonly-${STAMP}`);
const PUBLIC_MAKER = "0xd572638F07829D1c3636400FB73CF34Ca6c7448a";
const PUBLIC_OPERATOR = "0x602dbf3937558B1d18d76315635fD5410089bd51";

describe.skipIf(!RUN_IT)("live read-only smoke (shadow, watch-only, no keys)", () => {
  it("computes fair values, guards and decisions from live data inside workerd and sends nothing", async () => {
    mkdirSync(join(RUN, "dist"), { recursive: true });
    const b = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", join(RUN, "dist")], { cwd: PKG, encoding: "utf8" });
    expect(b.status).toBe(0);
    let posts = 0;
    const mf = new Miniflare({
      modules: true,
      scriptPath: join(RUN, "dist", "index.js"),
      compatibilityDate: "2025-07-18",
      port: Number(process.env.MW_SMOKE_PORT ?? 19803),
      durableObjects: { MAKER: { className: "MakerDO", useSQLite: true } },
      kvNamespaces: ["MAKER_KV"],
      bindings: { MAKER_MODE: "shadow", RPC_URL: "https://testnet-rpc.monad.xyz", STATIONS: "RCSS", WATCH_EVERY_SEC: "0", MAKER_ADDRESS: PUBLIC_MAKER, OPERATOR_ADDRESS: PUBLIC_OPERATOR },
      serviceBindings: {
        API: async (req: any) => {
          const u = new URL(req.url);
          if (req.method === "GET" && u.pathname === "/api/snapshot") {
            const r = await fetch("https://isotherm.pages.dev/api/snapshot");
            return new MfResponse(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
          }
          posts++;
          return new MfResponse("refused by the smoke test", { status: 403 });
        },
      },
    } as any);
    try {
      const ns = await mf.getDurableObjectNamespace("MAKER");
      const stub = ns.get(ns.idFromName("maker"));
      const tick = async () => (await (await stub.fetch("http://maker.internal/tick?schedule=0", { method: "POST" })).json()) as any;
      const t0 = Date.now();
      const r = await tick();
      const ms1 = Date.now() - t0;
      const r2 = await tick(); // warm: caches, v0 from the Durable Object
      const lines = [
        `live read-only smoke ${new Date().toISOString()}: block ${r.block}; tick 1 ${ms1} ms (cold), tick 2 ${r2.ms} ms`,
        `mode ${r.mode}; reasons ${JSON.stringify(r.reasons)}; errors ${JSON.stringify(r.errors)}`,
        `rolls ${JSON.stringify(r.rolls.map((x: any) => `${x.key}:${x.ok}`))}; intents ${r.intents.length + r2.intents.length}; txs ${r.txs.length + r2.txs.length}; snapshot POSTs ${posts}`,
        ...r2.ladders.flatMap((l: any) => [`ladder ${l.key} ${l.status}`, ...l.strikes.map((s: any) => `  >=${s.k} fair ${s.fair} (${s.source}${s.flags.length ? `; ${s.flags.join(",")}` : ""}) desired ${JSON.stringify(s.desired)} resting ${s.resting.bid}/${s.resting.ask} -> ${s.action} [${s.reasons.join("; ")}] | live maker: ${s.mac ? `fair ${s.mac.fair} quote ${s.mac.bid}/${s.mac.ask}` : "-"}`)]),
        `intents: ${JSON.stringify([...r.intents, ...r2.intents].map((i: any) => i.label))}`,
        `watcher: ${JSON.stringify(r.watcher && "verdicts" in r.watcher ? { from: r.watcher.from, head: r.watcher.head, pages: r.watcher.pages, events: r.watcher.events, verdicts: r.watcher.verdicts.map((v: any) => `${v.key}:${v.verdict}`) } : r.watcher)}`,
      ];
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, "summary.txt"), lines.join("\n") + "\n");
      console.log(lines.join("\n"));
      expect(r.mode).toBe("shadow");
      expect(r.reasons).toContain("watch-only addresses (no key secrets): shadow only");
      expect(r.errors).toEqual([]);
      expect(r.txs).toEqual([]);
      expect(r2.txs).toEqual([]);
      expect(posts).toBe(0);
      expect(r2.ladders.length).toBeGreaterThan(0);
      expect(r2.ladders[0].strikes.some((s: any) => s.fair !== null)).toBe(true);
    } finally {
      await mf.dispose();
      rmSync(RUN, { recursive: true, force: true });
    }
  }, 600_000);
});
