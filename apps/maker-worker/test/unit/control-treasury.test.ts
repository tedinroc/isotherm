// scripts/control.mjs treasury: the thresholds are the ones the Worker merges (config/worker.json, then wrangler.toml
// CONFIG_OVERRIDES), not config/worker.json alone. Once the 2026-10-13 judging override is deployed, worker.json alone
// would show the maker's minimum as 1.5 instead of 2, the global cap as 6 instead of 12 and the LOW line as 10 instead of 20.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import defaults from "../../../../packages/maker/config/default.json";
import overlay from "../../config/worker.json";
// @ts-expect-error plain .mjs operator script (no types)
import { KV_COMMANDS, tomlConfigOverrides, treasuryConfig, treasuryLines } from "../../scripts/control.mjs";
import { workerConfig } from "../../src/config.ts";
import { settingsFrom, type Env } from "../../src/env.ts";
import { parseTreasuryCfg } from "../../src/treasury.ts";

// the judging override as committed on 2026-10-13 (pinned here so the test outlives its revert)
const OVER = '{"budget":{"dailyCapMon":{"maker":4},"softRatio":0.75,"reserveMon":{"maker":0.8}},"treasury":{"globalDailyCapMon":12,"lowAlertMon":20,"roles":{"maker":{"minMon":2,"targetMon":5,"dailyCapMon":6}}}}';
const toml = (vars: string, more = "") => `name = "isotherm-maker"\n\n[[kv_namespaces]]\nbinding = "MAKER_KV"\n\n[vars]\nSTATIONS = "RCSS"\n${vars}\nTICK_SEC = "60"\n${more}`;
const WITH = toml(`# deep-merged over config/worker.json\nCONFIG_OVERRIDES = '${OVER}'`);
const WITHOUT = toml("");
const viaWorker = (over?: string) => parseTreasuryCfg((workerConfig(settingsFrom({ CONFIG_OVERRIDES: over } as Env), "live") as any).treasury);
const cfgOf = (t: string) => treasuryConfig({ defaults, overlay, toml: t });

// synthetic: the balances of the live status at 2026-10-13T06:39Z (before the override was deployed: the Worker still
// reported worker.json's global cap of 6), with the cap set to the override's 12 as if it ran with the override
const STATUS = {
  treasury: {
    at: "2026-10-13T06:39:50.066Z",
    mode: "live",
    address: "0x655dE7F5E6EdB42f26C422ED056F94BA9964BEed",
    mon: 156.965721,
    key: "ok",
    balances: { maker: 1.929558, operator: 2.24064, relayer: 39.423603, attester: 0.798, guardian: 0.05 },
    today: { day: "2026-10-13", sent: { operator: 1.5 }, total: 1.5, globalCap: 12 },
    actions: [],
    alerts: [],
  },
};
const line = (lines: string[], role: string) => lines.find((l) => l.startsWith(`  ${role} `))!;

const SCRIPT = fileURLToPath(new URL("../../scripts/control.mjs", import.meta.url));
// a stub npx: answers `get status` (ISO_TEST_STATUS), `put control` and a missing control document, logs every call;
// anything else fails the command
const NPX = `#!/bin/sh
echo "$*" >> "$ISO_TEST_DIR/npx.log"
case "$1 $2 $3 $4 $5" in
  "wrangler kv key get status") exec cat "$ISO_TEST_STATUS" ;;
  "wrangler kv key get control" | "wrangler kv key get control:result") exit 1 ;;
  "wrangler kv key put control") exit 0 ;;
esac
echo "unexpected npx $*" >&2
exit 9
`;
// runs scripts/control.mjs under plain Node with the stub first on PATH (nothing reaches Cloudflare) and a dummy KV id;
// asynchronously, so a slow machine does not block the vitest worker's event loop
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "isotherm-control-"));
  writeFileSync(join(dir, "npx"), NPX);
  chmodSync(join(dir, "npx"), 0o755);
  const run = (args: string[], env: Record<string, string> = {}, node: string[] = []) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((done, fail) => {
      const p = spawn(process.execPath, [...node, SCRIPT, ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ISO_MAKER_KV_NAMESPACE_ID: "0".repeat(32), ISO_TEST_DIR: dir, ...env } });
      let stdout = "", stderr = "";
      p.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      p.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      p.on("error", fail).on("close", (status) => done({ status, stdout, stderr }));
    });
  return { dir, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}
// stderr without the type-stripping ExperimentalWarning that some Node versions in the supported range still print
const errOf = (stderr: string) => stderr.split("\n").filter((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l)).join("\n");

describe("control.mjs treasury thresholds", () => {
  it("merges CONFIG_OVERRIDES over config/worker.json exactly as the Worker's workerConfig does", () => {
    const { cfg, source } = cfgOf(WITH);
    expect(parseTreasuryCfg(cfg)).toEqual(viaWorker(OVER));
    expect([cfg.floorMon, cfg.lowAlertMon, cfg.globalDailyCapMon]).toEqual([2, 20, 12]);
    expect(cfg.roles.maker).toMatchObject({ minMon: 2, targetMon: 5, dailyCapMon: 6 });
    expect(cfg.roles.operator).toEqual(overlay.treasury.roles.operator); // untouched roles keep worker.json
    expect(source).toBe("config/worker.json + CONFIG_OVERRIDES from wrangler.toml, deep-merged as src/config.ts does");
    // without the line it is config/worker.json alone, also the Worker's view
    expect(parseTreasuryCfg(cfgOf(WITHOUT).cfg)).toEqual(viaWorker(undefined));
    expect(cfgOf(WITHOUT).source).toBe("config/worker.json (wrangler.toml sets no CONFIG_OVERRIDES)");
  });

  it("matches the Worker on the committed wrangler.toml", () => {
    const real = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    const m = real.match(/^CONFIG_OVERRIDES = '([^'\n]*)'$/m); // how test/unit/infra.test.ts reads it
    expect(parseTreasuryCfg(cfgOf(real).cfg)).toEqual(viaWorker(m?.[1]));
  });

  it("reads only an uncommented one-line literal string under [vars]; anything else is flagged, never silently dropped", () => {
    expect(tomlConfigOverrides(toml(`#CONFIG_OVERRIDES = '${OVER}'`))).toBeUndefined();
    expect(tomlConfigOverrides(toml("", `\n[env.staging.vars]\nCONFIG_OVERRIDES = '${OVER}'\n`))).toBeUndefined();
    expect(tomlConfigOverrides(toml(`CONFIG_OVERRIDES = '${OVER}'  # judging`))).toEqual(JSON.parse(OVER));
    expect(tomlConfigOverrides(toml("CONFIG_OVERRIDES = ''"))).toEqual({});
    expect(tomlConfigOverrides(toml(`CONFIG_OVERRIDES = '${OVER}'`).replace("[vars]", "[ vars ]  # spaced"))).toEqual(JSON.parse(OVER));
    const other = [
      `"CONFIG_OVERRIDES" = '${OVER}'`, // quoted key
      `NOTE = '''\n[not a section]\n'''\nCONFIG_OVERRIDES = '${OVER}'`, // a "[" line inside a multi-line string
    ].map((v) => toml(v));
    other.push(`name = "isotherm-maker"\nvars.CONFIG_OVERRIDES = '${OVER}'\n`, `name = "isotherm-maker"\nvars = { CONFIG_OVERRIDES = '${OVER}' }\n`); // dotted key, inline table
    for (const bad of [...[`CONFIG_OVERRIDES = "${OVER.replace(/"/g, '\\"')}"`, "CONFIG_OVERRIDES = '{\"treasury\":'", "CONFIG_OVERRIDES = '5'", "CONFIG_OVERRIDES = '''"].map((v) => toml(v)), ...other]) {
      expect(tomlConfigOverrides(bad), bad).toBeNull();
      const { cfg, source } = cfgOf(bad);
      expect(cfg.roles.maker.minMon).toBe(overlay.treasury.roles.maker.minMon);
      expect(source).toMatch(/^config\/worker\.json ONLY: .* may NOT be the live thresholds$/);
    }
  });

  it("synthetic: the 06:39Z balances under the override's thresholds flag the maker; worker.json alone shows min 1.5 and does not", () => {
    const lines: string[] = treasuryLines(STATUS, cfgOf(WITH));
    expect(lines[0]).toBe("treasury 0x655dE7F5E6EdB42f26C422ED056F94BA9964BEed: 156.965721 MON (floor 2, alert below 20); key: ok; last pass 2026-10-13T06:39:50.066Z (live)");
    expect(lines[1]).toBe("  thresholds: config/worker.json + CONFIG_OVERRIDES from wrangler.toml, deep-merged as src/config.ts does; global cap from the live status");
    expect(line(lines, "maker")).toBe("  maker       1.929558 MON  min 2 target 5  topped up today 0 of 6  BELOW MIN");
    expect(line(lines, "operator")).toBe("  operator     2.24064 MON  min 1.2 target 2.5  topped up today 1.5 of 1.5");
    expect(lines.filter((l) => l.includes("BELOW MIN"))).toHaveLength(1);
    expect(lines).toContain("  all roles today: 1.5 of 12 MON (2026-10-13)");
    expect(lines.some((l) => l.includes("WARNING"))).toBe(false);

    // the old view: worker.json alone. The maker looks fine, and the live cap disagrees with the files: warned
    const old: string[] = treasuryLines(STATUS, cfgOf(WITHOUT));
    expect(line(old, "maker")).toBe("  maker       1.929558 MON  min 1.5 target 4  topped up today 0 of 4");
    expect(old).toContain("  all roles today: 1.5 of 12 MON (2026-10-13)");
    expect(old[2]).toMatch(/^ {2}WARNING: the live global cap is 12 but these files give 6: .* may not be the live ones$/);
  });

  it("falls back to the files' cap before the first pass, and marks a treasury under its alert line", () => {
    const none: string[] = treasuryLines({ treasury: { key: "set (no pass yet)" } }, cfgOf(WITH));
    expect(none[1]).toMatch(/global cap from those files \(no treasury pass in the status\)$/);
    expect(none).toContain("  all roles today: 0 of 12 MON (-)");
    expect(none.some((l) => l.includes("BELOW"))).toBe(false);
    const low: string[] = treasuryLines({ treasury: { ...STATUS.treasury, mon: 15.2 } }, cfgOf(WITH));
    expect(low[0]).toContain("15.2 MON (floor 2, alert below 20) BELOW ALERT LINE; key: ok");
  });

  it("says when the status is unreadable, and when the merged config turns the treasury off", () => {
    const raw: string[] = treasuryLines("Value not found", cfgOf(WITH)); // get() returns non-JSON output as text
    expect(raw[0]).toContain(": ? MON (floor 2, alert below 20); key: ?; last pass ? (-)");
    expect(raw[1]).toMatch(/global cap from those files \(status unreadable: not JSON\)$/);
    const off = cfgOf(toml(`CONFIG_OVERRIDES = '{"treasury":null}'`));
    expect(off.cfg).toBeNull();
    expect(viaWorker('{"treasury":null}')).toBeNull(); // the Worker's treasury is off too
    const lines: string[] = treasuryLines(STATUS, off);
    expect(lines[0]).toBe("treasury: off in the merged config (no treasury block), so the Worker runs no treasury pass; last pass in the status 2026-10-13T06:39:50.066Z (a recent one means the Worker runs another config)");
    expect(lines.join("\n")).not.toContain("undefined");
  });

  it("the command runs end to end on the committed files (status read through a stub npx: no Cloudflare call)", async () => {
    const sb = sandbox();
    try {
      const real = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
      const live = viaWorker(real.match(/^CONFIG_OVERRIDES = '([^'\n]*)'$/m)?.[1])!;
      const status = join(sb.dir, "status.json");
      writeFileSync(status, JSON.stringify({ treasury: { ...STATUS.treasury, today: { ...STATUS.treasury.today, globalCap: live.globalDailyCapMon } } }));
      const r = await sb.run(["treasury"], { ISO_TEST_STATUS: status });
      expect(errOf(r.stderr)).toBe("");
      expect(r.status).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(lines[0]).toContain(`(floor ${live.floorMon}, alert below ${live.lowAlertMon})`);
      expect(lines[1]).toMatch(/^ {2}thresholds: config\/worker\.json.*; global cap from the live status$/);
      const maker = line(lines, "maker");
      expect(maker).toContain(`min ${live.roles.maker.minMon} target ${live.roles.maker.targetMon}  topped up today 0 of ${live.roles.maker.dailyCapMon}`);
      expect(maker.endsWith("BELOW MIN")).toBe(1.929558 < live.roles.maker.minMon);
      expect(lines).toContain(`  all roles today: 1.5 of ${live.globalDailyCapMon} MON (2026-10-13)`);
      expect(lines.some((l) => l.includes("WARNING"))).toBe(false);
      expect(readFileSync(join(sb.dir, "npx.log"), "utf8")).toBe(`wrangler kv key get status --namespace-id ${"0".repeat(32)}\n`);
    } finally {
      sb.done();
    }
  });
});

describe("control.mjs commands", () => {
  it("KV_COMMANDS (namespace id checked first) lists exactly the commands of the switch", () => {
    const cases = [...readFileSync(SCRIPT, "utf8").matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1]);
    expect(cases.sort()).toEqual([...KV_COMMANDS].sort());
  });

  it("a missing namespace id stops import-state before its temp file and arm before the maker key", async () => {
    const sb = sandbox();
    try {
      const tmp = join(sb.dir, "tmp");
      mkdirSync(tmp);
      writeFileSync(join(sb.dir, "state.json"), "{}");
      // no id in the env and none under HOME (the sandbox): kvNamespaceId() exits 2
      const env = { ISO_MAKER_KV_NAMESPACE_ID: "", HOME: sb.dir, TMPDIR: tmp };
      for (const args of [["import-state", join(sb.dir, "state.json")], ["arm"]]) {
        const r = await sb.run(args, env);
        expect(r.status, args[0]).toBe(2);
        expect(errOf(r.stderr)).toMatch(/^Set ISO_MAKER_KV_NAMESPACE_ID /);
        expect(r.stdout).toBe("");
      }
      expect(readdirSync(tmp)).toEqual([]); // no isotherm-import-*/state.json left behind
      expect(existsSync(join(sb.dir, "npx.log"))).toBe(false);
    } finally {
      sb.done();
    }
  });

  it.skipIf(!process.allowedNodeEnvironmentFlags.has("--experimental-strip-types"))("help and pull run when Node cannot load the .ts config; only treasury fails, and says why", async () => {
    const sb = sandbox();
    try {
      const noTs = ["--no-experimental-strip-types"];
      const help = await sb.run(["help"], {}, noTs);
      expect([help.status, errOf(help.stderr)]).toEqual([0, ""]);
      expect(help.stdout).toMatch(/^\/\/ Operator console for the maker Worker\./);
      const pull = await sb.run(["pull"], {}, noTs);
      expect([pull.status, errOf(pull.stderr)]).toEqual([0, ""]);
      expect(pull.stdout).toMatch(/^control document written \(seq \d+\)/);
      expect(readFileSync(join(sb.dir, "npx.log"), "utf8")).toMatch(/^wrangler kv key put control \{"seq":\d+,"pull":"all"\} --namespace-id 0{32}$/m);
      const t = await sb.run(["treasury"], {}, noTs);
      expect(t.status).toBe(1);
      expect(t.stderr).toContain("cannot load packages/maker/src/config-core.ts (plain Node needs >= 22.18)");
    } finally {
      sb.done();
    }
  });
});
