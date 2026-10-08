import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAddr, loadDeployment, FEASIBILITY } from "../src/deployment.ts";
import { acquireLock, enqueueRoll, takeRollRequests } from "../src/lock.ts";
import { decodeL2, othersBest } from "../src/kuru.ts";
import { emptyState, loadState, saveState } from "../src/state.ts";
import { loadConfig } from "../src/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "isotherm-maker-"));

test("deployment reader tolerates shapes; falls back to the feasibility deployment", () => {
  const dir = tmp();
  const f = join(dir, "testnet.json");
  writeFileSync(f, JSON.stringify({ chainId: 10143, contracts: { CollateralVault: { address: "0x00000000000000000000000000000000000000a1" }, Resolver: "0x00000000000000000000000000000000000000a2", IsothermZap: { address: "0x00000000000000000000000000000000000000a3" } }, roles: { operator: "0x00000000000000000000000000000000000000b1" } }));
  const d = loadDeployment(f);
  assert.equal(d.variant, "v1");
  assert.equal(d.vault, "0x00000000000000000000000000000000000000A1");
  assert.equal(d.zap, "0x00000000000000000000000000000000000000A3");
  assert.equal(d.roles.operator, "0x00000000000000000000000000000000000000B1");
  assert.equal(d.kuruRouter, "0x7EFbE105Ca7415dE98F96622173458ac1c054630");
  assert.equal(findAddr({ a: { b: { vault: "0x00000000000000000000000000000000000000c1" } } }, /^vault$/i), "0x00000000000000000000000000000000000000C1");
  const fb = loadDeployment(join(dir, "missing.json"));
  assert.equal(fb.variant, "feasibility");
  assert.equal(fb.vault, FEASIBILITY.vault);
  writeFileSync(f, JSON.stringify({ chainId: 143, vault: "0x00000000000000000000000000000000000000a1", resolver: "0x00000000000000000000000000000000000000a2" }));
  assert.throws(() => loadDeployment(f), /not Monad testnet/);
});

test("lock: a live holder blocks, a dead holder's lock is stolen; roll requests queue", () => {
  const dir = tmp();
  const f = join(dir, "maker.lock");
  writeFileSync(f, JSON.stringify({ pid: process.ppid, cmd: "loop", at: 0 }));
  const held = acquireLock(f, "tick");
  assert.ok("heldBy" in held && held.heldBy.pid === process.ppid);
  writeFileSync(f, JSON.stringify({ pid: 999_999, cmd: "loop", at: 0 }));
  const got = acquireLock(f, "tick");
  assert.ok("release" in got);
  got.release();
  assert.equal(existsSync(f), false);
  const state = join(dir, "state.json");
  enqueueRoll(state, { station: "RCSS", isoDate: "2026-10-08", at: 1 });
  assert.deepEqual(takeRollRequests(state).map((x) => x.req.isoDate), ["2026-10-08"]);
});

test("Kuru L2 decode and 'others' best quotes exclude our own size", () => {
  const w = (x: bigint) => x.toString(16).padStart(64, "0");
  const hex = ("0x" + [w(123n), w(4400n), w(100_000_000n), w(4300n), w(5_000_000n), w(0n), w(5000n), w(100_000_000n), w(5100n), w(7_000_000n)].join("")) as `0x${string}`;
  const b = decodeL2(hex);
  assert.deepEqual([b.bestBid, b.bestAsk, b.bids.length, b.asks.length], [0.44, 0.5, 2, 2]);
  assert.deepEqual(othersBest(b, { bid: { price: 0.44, size: 100 }, ask: { price: 0.5, size: 100 } }), { bid: 0.43, ask: 0.51 });
  assert.deepEqual(othersBest(b, { bid: { price: 0.44, size: 60 } }), { bid: 0.44, ask: 0.5 });
});

test("state: atomic save/load, refuses a state file from another vault", () => {
  const dir = tmp();
  const f = join(dir, "state.json");
  const dep = { vault: "0x00000000000000000000000000000000000000a1" as const, resolver: "0x00000000000000000000000000000000000000a2" as const, zap: null, source: "t", variant: "v1" };
  const s = emptyState(dep);
  s.events.push({ at: 1, kind: "x", msg: "y" });
  saveState(f, s);
  assert.equal(loadState(f, dep).events.length, 1);
  assert.throws(() => loadState(f, { ...dep, vault: "0x00000000000000000000000000000000000000ff" }), /belongs to vault/);
});

test("config: defaults validate; live broadcast needs ISOTHERM_ALLOW_LIVE=1", () => {
  const c = loadConfig();
  assert.equal(c.chainId, 10143);
  assert.equal(c.allowLive, process.env.ISOTHERM_ALLOW_LIVE === "1");
  assert.throws(() => loadConfig({ quote: { tick: 0.0015 } }), /multiple of the Kuru tick/);
  assert.throws(() => loadConfig({ gas: { makerMult: 2 } }), /gas multipliers/);
  // the Mac keeps requoteTicks 2 (the Worker sets 3 in its own overlay); the guard-wide hysteresis is shared
  assert.equal(c.policy.requoteTicks, 2);
  assert.deepEqual([c.fair.guardWarn, c.fair.guardWarnExit], [0.15, 0.13]);
  assert.throws(() => loadConfig({ fair: { guardWarnExit: 0.2 } }), /guardWarnExit 0.2 must be in \(0, guardWarn 0.15\]/);
  assert.throws(() => loadConfig({ fair: { guardWarnExit: 0 } }), /guardWarnExit/);
  assert.equal(loadConfig({ fair: { guardWarnExit: null } }).fair.guardWarnExit, null);
  assert.throws(() => loadConfig({ policy: { requoteTicks: 0 } }), /requoteTicks 0 must be >= 1/);
});
