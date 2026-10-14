// Evaluator of vps/stack-watch.sh (run by it, never on its own). READ-ONLY: it reads the JSON that stack-watch.sh
// fetched with GETs and its reads of the web app's RPCs (or the test fixtures), makes a few `cast` read calls
// (balances, Resolver.resultOf), and prints what to do as tab-separated lines; stack-watch.sh does the pushes and
// saves the state. It sends no transaction, holds no key and never writes the settlement job's var/ files.
//
//   node vps/stack-watch.mjs --in DIR --state FILE --out-state FILE --now EPOCH [--watch DIR] [--push 0|1] [--fixtures]
//                            [--cre-runs FILE --cre-after N]
//     DIR       <name>.json (+ <name>.code, the HTTP status) for health, snapshot, settlements, stats. A missing or
//               unparsable file = that GET failed. The web app's RPCs (check i): webrpc.* (its RPC) and webfb<N>.*
//               (the Nth fallback RPC listed in webbuild, the deployed build's script then its fallbacks), each
//               .json / .code / .headers (eth_blockNumber) and -pre.code / -pre.headers (its CORS preflight).
//               With --fixtures, also balance-<role>.txt and result-<STATION>-<yyyymmdd>.txt (cast's output)
//               instead of chain reads; a missing file = a failed read.
//     FILE      the previous state (may be missing) / where to write the new one (stack-watch.sh moves it into place)
//     --watch   the watch's own directory (lib.sh STATE), read only: alerts/<slug>.last (push_alert's delivery stamps),
//               snooze-until and snooze-web-until (stack-watch.sh --snooze / --snooze-web)
//     --push 1  an alert URL file is there, so a one-off push is re-sent until it is delivered (0: handed over once)
//     --cre-runs  the settlement job's runs as stack-watch.sh classified them from var/evidence/settle-runs.jsonl
//               (a JSON list; a missing file = no settlement job on this host: the digest has no CRE line);
//               --cre-after = lib.sh CRE_NEEDED_AFTER
// Output, one per line (fields separated by a TAB; a body's newlines encoded as \x1f):
//   LOG <text>                                  a journal line
//   PUSH <priority> <dedupe s> <title> <body>   a phone push through lib.sh push_alert (per-title dedupe)
//   UNSTAMP <title>                             forget that title's last push (it cleared: a recurrence pushes at once)
// Env: ISOTHERM_CAST (default `cast` on PATH), ISOTHERM_WATCH_RPCS (space-separated; default Ankr, then the official
// RPC, the same order as the Workers' RPC_URLS minus thirdweb).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ------------------------------------------------------------------------------------------------ thresholds
// Each one is tied to the live config of the judging override (docs/OPERATIONS.md section 0) or to the docs.
const MIN = 60, HOUR = 3600, DAY = 86400;
const T = {
  // a. The maker Worker posts its snapshot on every tick (cron every minute, apps/maker-worker engine.ts step 6), so a
  //    snapshot older than 15 min means 15 ticks in a row failed or the cron stopped. Pushed on the second stale run
  //    of a problem (or at once when the snapshot is already 25 min old), so one 16-minute gap that heals by itself
  //    is not a night-time push; ticks failing on and off (2026-10-09 14:00-15:27 UTC) still are, once.
  stalledSec: 15 * MIN,
  stalledRuns: 2,
  stalledAtOnceSec: 25 * MIN,
  // b. "At the money" = fair 0.10..0.90: outside it the maker pulls on purpose (it stops quoting a strike whose
  //    outcome is ~known, fair outside 0.03..0.97, and the far wings are not where judges trade). 60 min: a fill is
  //    refilled within a tick or two and an urgent crossing is re-quoted at once, so an hour without one side is the
  //    budget cap or a stuck maker, which is what left the at-the-money books empty 10-20 h a day before the override.
  booksFairLo: 0.10,
  booksFairHi: 0.90,
  booksAfterSec: 60 * MIN,
  // Around a close: the kill switch pulls the closing ladder's quotes ~12 min before closeTime (09:18 UTC for the
  // 09:30 UTC Taipei close). No BOOKS EMPTY for a ladder from closeTime - 15 min on, and none at all from closeTime - 15
  // min to closeTime + 5 min (09:15-09:35 UTC), while the maker is busy with the kill switch and the margin withdraw.
  // NO ACTIVE LADDER is not counted in that window either.
  closeBeforeSec: 15 * MIN,
  closeAfterSec: 5 * MIN,
  // c. /api/health readiness: false for 20 min over at least 3 runs, so one RPC hiccup of the API (it reads the
  //    relayer balance from the chain on each call) is not reported. The same for the float and the role balances.
  readyAfterSec: 20 * MIN,
  readyRuns: 3,
  // Relayer: 15 MON. At the current caps a worst-case UTC day costs 17 x 0.2602 + 28 x 0.0342 = 5.38 MON
  // (apps/api/evidence/size-caps-2026-10-13-judging.txt), so 15 MON is ~2.8 worst-case days: time to see the push and
  // fund it. A "need until 10-31" line is not used as the trigger: the caps were sized to spend the whole balance by
  // 10-31 at worst case (102.2 of 102.3 MON), so that line sits within a rounding error of the balance and would fire
  // on day one; the runway is printed in the body and the digest instead.
  relayerLowMon: 15,
  // AUSD float: the API's cron refills it every minute (one faucet call, +10,000) below its 50,000 target, and a drip
  // takes 1,000. Under 5 drips' worth (5,000) for 20 min means the refill is failing; drips then fall back to the
  // public faucet per user (slower, cooldown-limited), so default priority.
  floatLowDrips: 5,
  // d. The drip/relay counters reset at 00:00 UTC. All 17 drips (5 per network, so 4+ networks) or all 28 relays gone
  //    by 08:00 UTC (16:00 Taipei) is far beyond what judges did so far (9 drips in 6 days): likely a bot (high).
  //    Later in the day it is CAP REACHED at low priority (no sound): 15:00-24:00 UTC is the Taipei night, and heavy
  //    judge use is fine.
  capEarlyHourUtc: 8,
  // e. TREASURY LOW 20 = the judging override's own line (the Worker's TREASURY LOW push does not arrive: ntfy refuses
  //    Cloudflare's shared IPs). The treasury tops the maker up below 2 (to 6) and the operator below 1.2 (to 2.5)
  //    every 10 min, so the maker under 1.0 or the operator under 0.9 for 20 min (two treasury passes) means the
  //    top-ups are failing. Operator 0.9, not 0.6: the 12:00 Taipei roll (04:00 UTC) needs ~0.85 MON and is refused
  //    below that, so 0.6 would warn only after the roll failed. The 20 min also covers the roll's own dip (0.78 MON)
  //    until the next treasury pass refills it.
  treasuryLowMon: 20,
  makerLowMon: 1.0,
  operatorLowMon: 0.9,
  roleLowAfterSec: 20 * MIN,
  //    The guardian (the Worker's GUARDIAN_KEY) pays the gas of challenge() (~44k gas, about 0.011 MON) and pause();
  //    the attester is the settlement job's transaction sender, about 0.0204 MON per report (docs/OPERATIONS.md
  //    section 2). The treasury tops them up below 0.05 (to 0.15) and below 0.3 (to 0.8), so the guardian under 0.03
  //    (two challenges' worth) or the attester under 0.08 (three reports) for 20 min means those top-ups are failing.
  //    The attester's line sits under the settlement job's own "ISOTHERM VPS: attester low on MON" (vps/settle-vps.sh:
  //    below 0.1, default priority, once a day): that one is the first word, this high one says the top-ups failed.
  //    Read after the settlement check (f): under RPC trouble the 60 s chain budget goes to that first.
  guardianLowMon: 0.03,
  attesterLowMon: 0.08,
  // f. The day ends 16:00 UTC; the VPS settles at 18:05 UTC (day end + 2 h 05) and retries hourly. Day end + 5 h
  //    (21:00 UTC) = three attempts (18:05, 19:05, 20:05) without a result. The Worker's own SETTLEMENT OVERDUE (day end
  //    + 3 h) does not reach the phone. Only a ladder that reached the chain (a series or a market, or once "active")
  //    is checked: a roll that never sent a transaction has nothing to settle (LADDER NOT OPENED covers it).
  overdueAfterSec: 5 * HOUR,
  // How long a ladder or a station seen in a snapshot is remembered (the snapshot drops a closed ladder 36 h after
  // its close).
  ladderMemorySec: 4 * DAY,
  // g. The digest goes out on the first run at or after 01:00 UTC (09:00 Taipei; stack-watch.sh reads the settlement
  //    records only from then). Its CRE line: the settlement job runs hourly at :05, so a newest record over 2 h old
  //    (two runs missing) is NO SETTLEMENT RUN, and a step over 2 h between two records is a gap in them.
  digestHourUtc: 1,
  creStaleSec: 2 * HOUR,
  creGapSec: 2 * HOUR,
  // h. Ladders. The maker opens (rolls) the ladder of local day D at 12:00 local on D-1 (rollNotBeforeLocal: 04:00 UTC
  //    for Taipei), retries a refused roll every 5 min, and a normal roll takes a few minutes. So from 13:00 local the
  //    ladder of tomorrow must be "active" (before 13:00, today's): "planned" (saved before any transaction),
  //    "rolling" (series created, markets or margin not) or missing (refused before planning) is LADDER NOT OPENED,
  //    high. A refused roll is documented when the operator is short of MON (docs/OPERATIONS.md section 4).
  rollLocalSec: 12 * HOUR,
  rollGraceSec: 60 * MIN,
  //    When rolls work there is always an active ladder (D+1 is active from ~04:05 UTC on D, D closes 09:30 UTC), so
  //    none for 20 min over 3 runs, outside a close window, means nothing can be traded at all: NO ACTIVE LADDER, high.
  noActiveAfterSec: 20 * MIN,
  // The watchdog's own trouble: one or two failed runs are normal network weather.
  apiFailRuns: 3,
  // i. The web app reads prices, trades and signs (the Dynamic wallet) through https://testnet-rpc.monad.xyz
  //    (apps/web/src/config.ts RPC_URL), while the API, the maker and this watch read Ankr first, so nothing else would
  //    notice it down. Each run reads it as a browser on the site does: its CORS preflight (OPTIONS) and one
  //    eth_blockNumber (a POST with Origin isotherm.pages.dev). Failed = no answer, not HTTP 200, no block number, a
  //    CORS answer that does not allow the site (preflight not 2xx, allow-origin not the site or "*", allow-headers
  //    without content-type: the browser never sends the POST or drops its answer), or the same block as 5+ min
  //    before (stuck). Pushed on the 3rd failed run in a row, as for the API: the endpoint limits each IP to
  //    15 req/s and has short hiccups; a good run resets the count. High priority while the deployed build has no
  //    fallback RPC that answers (the build of 2026-10-13 has none: judges see no prices); default while one does
  //    (the site still works through it), back to high at once if they fail too. stack-watch.sh --snooze-web holds it.
  webRpcFailRuns: 3,
  webRpcStuckSec: 5 * MIN,
  // A problem is over only after 30 min without it (from its first clean reading: four runs). Until then it keeps its
  // start time, its run count and push_alert's repeat stamp, so a problem that comes and goes is one push per repeat
  // window (not one per recurrence, each followed by a CLEARED), and a pending one keeps counting toward its
  // threshold through a good reading. A SETTLEMENT OVERDUE clears at once: a result on the Resolver is final.
  clearSec: 30 * MIN,
  // A timer start drifts by up to 10 s (AccuracySec), so "20 min" between two runs can read 1,190 s.
  jitterSec: 30,
  // One-off pushes (the digest, CAP USED EARLY / CAP REACHED, CLEARED, the end-date reminder) are re-sent on the next
  // runs until push_alert's delivery stamp of that title changes: up to 2 per run (each can take curl's 10 s when ntfy
  // hangs, and a run must end inside the unit's 150 s), for at most 24 h.
  outboxRetriesPerRun: 2,
  outboxKeepSec: DAY,
  // After this the judging override is reverted; the watch stops checking and asks once a day to be uninstalled.
  untilEpoch: Date.parse("2026-11-01T00:00:00Z") / 1000,
};
// Repeat windows (push_alert's per-title dedupe): 3 h by default; 6 h for balances, which move slowly and need a
// person to fund them (two reminders per waking day). One-off pushes use the outbox instead (dedupe 0).
const STD = 3 * HOUR, BAL = 6 * HOUR;
// Unit costs for the relayer runway (size-caps 2026-10-13 at 102 gwei): drip = DRIP_MON + 99,752 gas, relay 335,000 gas.
const DRIP_GAS_MON = 0.010175, RELAY_MON = 0.03417;
const REPORT_MON = 0.0204; // one settlement report tx, billed to the attester (docs/OPERATIONS.md section 2)
const END_DAY = "2026-10-31";
// The web app's RPC and origin (= stack-watch.sh WEB_RPC, SITE).
const WEB_RPC = "https://testnet-rpc.monad.xyz", SITE = "https://isotherm.pages.dev";

// Public addresses (deployments/testnet.json; docs/OPERATIONS.md section 2).
const ADDR = {
  treasury: "0x655dE7F5E6EdB42f26C422ED056F94BA9964BEed",
  maker: "0xd572638F07829D1c3636400FB73CF34Ca6c7448a",
  operator: "0x602dbf3937558B1d18d76315635fD5410089bd51",
  guardian: "0x30C8E371719Ff00577284dd9c10587Fa89357d50",
  attester: "0x63D2523dDC4BB055A19682Bf2d61fe94959D0Bb9",
  resolver: "0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B",
};
const W = "ISOTHERM WATCH: ";
const OPS = "docs/OPERATIONS.md";
const JIT = T.jitterSec;

// ------------------------------------------------------------------------------------------------ inputs
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const IN = arg("--in"), STATE_IN = arg("--state"), STATE_OUT = arg("--out-state"), NOW = Number(arg("--now"));
const WATCHDIR = arg("--watch") || null, CAN_PUSH = arg("--push") === "1";
const FIX = argv.includes("--fixtures");
const CRE_RUNS = arg("--cre-runs") || null, CRE_AFTER = Number(arg("--cre-after")) || 2;
if (!IN || !STATE_OUT || !Number.isFinite(NOW)) { console.error("usage: stack-watch.mjs --in DIR --state FILE --out-state FILE --now EPOCH [--watch DIR] [--push 0|1] [--fixtures] [--cre-runs FILE --cre-after N]"); process.exit(2); }
const CAST = process.env.ISOTHERM_CAST || "cast";
const RPCS = (process.env.ISOTHERM_WATCH_RPCS || "https://rpc.ankr.com/monad_testnet https://testnet-rpc.monad.xyz").split(/\s+/).filter(Boolean);

const readText = (f) => { try { return fs.readFileSync(path.join(IN, f), "utf8"); } catch { return null; } };
function readIn(name) {
  const code = (readText(`${name}.code`) || "").trim();
  const raw = readText(`${name}.json`);
  if (raw == null) return { ok: false, why: `/api/${name}: ${code && code !== "200" ? (code === "000" ? "no answer" : `HTTP ${code}`) : "no answer"}` };
  try { const j = JSON.parse(raw); if (!j || typeof j !== "object") throw new Error(); return { ok: true, json: j }; } catch { return { ok: false, why: `/api/${name}: not JSON` }; }
}
let prev = {};
try { prev = JSON.parse(fs.readFileSync(STATE_IN, "utf8")) || {}; } catch { prev = {}; }
if (typeof prev !== "object" || Array.isArray(prev)) prev = {};

// ------------------------------------------------------------------------------------------------ helpers
const out = [];
const clean = (s) => String(s).replace(/\t/g, " ").replace(/\r?\n/g, "\x1f");
const log = (m) => out.push(`LOG\t${clean(m)}`);
const push = (prio, dedupe, title, body) => out.push(["PUSH", prio, dedupe, clean(title), clean(body)].join("\t"));
const unstamp = (title) => out.push(`UNSTAMP\t${clean(title)}`);
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const f2 = (x) => (x === null ? "?" : x.toFixed(2));
const f4 = (x) => (x === null ? "?" : x.toFixed(4));
const isoMin = (t) => new Date(t * 1000).toISOString().slice(0, 16) + "Z";
const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
const utcDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const dayStart = (t) => t - (((t % DAY) + DAY) % DAY);
const dur = (s) => { const m = Math.max(0, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
const durD = (s) => (s >= DAY ? `${Math.floor(s / DAY)} d ${Math.floor((s % DAY) / HOUR)} h` : dur(s));
const ymd = (d) => { const s = String(d); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s; };
const bytes4 = (station) => "0x" + Buffer.from(String(station).padEnd(4, "\0").slice(0, 4), "latin1").toString("hex");
const short = (title) => String(title).slice(W.length);

// One `cast` read: each RPC in turn (6 s per request, 10 s per process), or the fixture file. All chain reads of a run
// share a 60 s budget (a run must end well inside the unit's TimeoutStartSec even with every endpoint hanging); a
// read skipped for it is "unknown", like a failed one.
const castLog = [];
const castBudgetEnd = Date.now() + 60_000;
function cast(args, fixture) {
  if (FIX) { const v = readText(fixture); castLog.push(`${fixture}${v == null ? " (missing: a failed read)" : ""}`); return v == null ? null : v.trim(); }
  for (const rpc of RPCS) {
    if (Date.now() > castBudgetEnd) { log(`chain read skipped (60 s budget used): ${args[0]} ${args[1]}`); return null; }
    try {
      return execFileSync(CAST, [...args, "--rpc-url", rpc, "--rpc-timeout", "6"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { /* next RPC */ }
  }
  return null;
}
const balance = (role) => num(cast(["balance", ADDR[role], "--ether"], `balance-${role}.txt`));
// Resolver.resultOf(station, date) -> { status 0 none | 1 settled | 2 void, tmaxC, resolvedAt } or null on a failed read
function resultOf(station, date) {
  const r = cast(["call", ADDR.resolver, "resultOf(bytes4,uint32)((uint8,int16,uint64,uint64,bytes32))", bytes4(station), String(date)], `result-${station}-${date}.txt`);
  const m = r && r.match(/^\(\s*(\d+),\s*(-?\d+),\s*(\d+)/);
  return m ? { status: Number(m[1]), tmaxC: Number(m[2]), resolvedAt: Number(m[3]) } : null;
}

// The new state. Every field is rebuilt from `prev` on purpose, so nothing stale lingers.
const S = { v: 2, lastRun: NOW, conds: {}, books: {}, ladders: {}, stations: {}, api: { fails: 0 }, webRpc: { fails: 0 }, caps: {}, usage: prev.usage || null,
  usagePrev: prev.usagePrev || null, digest: prev.digest || null, counts: { runs: (prev.counts?.runs || 0) + 1, apiFails: prev.counts?.apiFails || 0 }, ended: prev.ended || null,
  outbox: (Array.isArray(prev.outbox) ? prev.outbox : []).filter((x) => x && typeof x.title === "string" && typeof x.body === "string").map((x) => ({ ...x, old: true })) };

// ---- the outbox: one-off pushes, re-sent until delivered. push_alert writes alerts/<slug>.last only on a 2xx answer,
// so a stamp that changed since the push was queued = delivered (its mtime too: two pushes in one second differ).
const slug = (title) => String(title).replace(/[^A-Za-z0-9]/g, "_").slice(0, 80); // = lib.sh alert_slug (titles are ASCII)
function stampOf(title) {
  if (!WATCHDIR) return "";
  const f = path.join(WATCHDIR, "alerts", `${slug(title)}.last`);
  try { return `${fs.readFileSync(f, "utf8").trim()}@${fs.statSync(f).mtimeMs}`; } catch { return ""; }
}
function once(prio, title, body) {
  S.outbox = S.outbox.filter((x) => x.title !== title);
  push(prio, 0, title, body);
  if (CAN_PUSH) S.outbox.push({ title, prio, body, at: NOW, stamp: stampOf(title), tries: 1 });
}
const unqueue = (title) => { S.outbox = S.outbox.filter((x) => x.title !== title); };
function flushOutbox() {
  let retried = 0;
  const keep = [];
  for (const x of S.outbox) {
    if (!x.old) { keep.push(x); continue; }
    delete x.old;
    if (!CAN_PUSH) continue; // no alert URL any more: nothing can be delivered
    if (stampOf(x.title) !== x.stamp) { log(`delivered: ${short(x.title)} (try ${x.tries})`); continue; }
    if (NOW - x.at >= T.outboxKeepSec) { log(`not delivered in ${dur(T.outboxKeepSec)} (${x.tries} tries), dropped: ${short(x.title)} (it stays in alerts/ALERTS.log)`); continue; }
    if (retried >= T.outboxRetriesPerRun) { keep.push(x); continue; }
    retried++;
    x.tries = (x.tries || 1) + 1;
    log(`re-sending (try ${x.tries}; not delivered since ${isoMin(x.at)}): ${short(x.title)}`);
    push(x.prio, 0, x.title, x.body);
    keep.push(x);
  }
  S.outbox = keep;
}

// A condition. active: true = the problem is there now, false = it is not, null = unknown this run (the state is kept
// unchanged: a failed read never clears or raises anything). It is pushed once due (o.due(since, runs), or `after`
// seconds since first seen over at least `minRuns` runs) and on every run after that while it is there, which
// push_alert's per-title dedupe turns into one push per window. It ends only after T.clearSec without it (o.clearSec):
// then, if it was pushed, one low-priority CLEARED push (re-sent until delivered) and the title's dedupe stamp is reset.
function cond(key, active, o) {
  const was = prev.conds?.[key];
  if (active === null) { if (was) S.conds[key] = was; return; }
  if (!active) {
    if (!was) return;
    const okSince = was.okSince ?? NOW, clearSec = o.clearSec ?? T.clearSec;
    if (clearSec > 0 && NOW - okSince < clearSec - JIT) {
      S.conds[key] = { ...was, okSince };
      log(`clearing: ${o.name} (not seen since ${hhmm(okSince)}Z; over after ${dur(clearSec)} without it${was.alerted ? ", then CLEARED" : ""})`);
      return;
    }
    if (was.alerted) {
      once("low", `${W}CLEARED ${o.name}`, `${o.okText ? o.okText() : "back to normal"}. Open since ${isoMin(was.since)}, not seen since ${isoMin(okSince)}. No action needed.`);
      unstamp(o.title);
    } else log(`over: ${o.name} (first seen ${isoMin(was.since)}, ${was.runs || 1} run(s); never pushed)`);
    return;
  }
  const since = was?.since ?? NOW, runs = (was?.runs || 0) + 1;
  const c = (S.conds[key] = { since, runs, title: o.title, alerted: !!was?.alerted });
  unqueue(`${W}CLEARED ${o.name}`); // back before its CLEARED was delivered: that message would be wrong now
  const due = c.alerted || (o.due ? o.due(since, runs) : NOW - since >= (o.after || 0) - JIT && runs >= (o.minRuns || 1));
  if (due) { push(o.prio, o.dedupe, o.title, o.body(since)); c.alerted = true; }
  else log(o.pending ? `pending: ${o.pending(since, runs)}` : `pending: ${o.name} (first seen ${isoMin(since)}, run ${runs}; pushed if it lasts ${dur(o.after || 0)}${o.minRuns > 1 ? ` over ${o.minRuns} runs` : ""})`);
}
const keepConds = (prefix) => { for (const [k, v] of Object.entries(prev.conds || {})) if (k.startsWith(prefix) && !(k in S.conds)) S.conds[k] = v; };

// ------------------------------------------------------------------------------------------------ end date
if (NOW >= T.untilEpoch) {
  if (S.ended !== utcDay(NOW)) {
    S.ended = utcDay(NOW);
    once("low", `${W}past its end date`, `The judging watchdog was meant to run until ${END_DAY}; it no longer checks anything. Uninstall it on the VPS: bash isotherm/packages/cre-workflow/vps/install-watch.sh --uninstall (vps/README.md, "Stack watchdog").`);
  } else log(`past ${END_DAY}: no checks (uninstall: vps/install-watch.sh --uninstall)`);
  Object.assign(S, { conds: prev.conds || {}, books: prev.books || {}, ladders: prev.ladders || {}, stations: prev.stations || {}, api: prev.api || { fails: 0 }, webRpc: prev.webRpc || { fails: 0 }, caps: prev.caps || {} });
  finish();
}

const health = readIn("health"), snap = readIn("snapshot"), setl = readIn("settlements"), stats = readIn("stats");
const H = health.ok ? health.json : null, L = H?.limits && typeof H.limits === "object" ? H.limits : {};

// The snooze (stack-watch.sh --snooze HOURS, for a deliberate pause of the maker: control.mjs pull or disarm, the
// rollback of docs/OPERATIONS.md 8.4): the maker checks (a, b, h) are held as unknown, everything else runs.
// --snooze-web HOURS holds WEB RPC DOWN the same way (an outage that cannot be fixed, or one only this VPS sees).
const snoozeOf = (f) => { if (!WATCHDIR) return null; try { return num(fs.readFileSync(path.join(WATCHDIR, f), "utf8").trim()); } catch { return null; } };
const snoozeUntil = snoozeOf("snooze-until"), webSnoozeUntil = snoozeOf("snooze-web-until");
const snoozed = snoozeUntil !== null && NOW < snoozeUntil, webSnoozed = webSnoozeUntil !== null && NOW < webSnoozeUntil;
if (snoozed) log(`snoozed until ${isoMin(snoozeUntil)}: MAKER STALLED, BOOKS EMPTY, LADDER NOT OPENED and NO ACTIVE LADDER are held (stack-watch.sh --snooze 0 ends it)`);
if (webSnoozed) log(`snoozed until ${isoMin(webSnoozeUntil)}: WEB RPC DOWN is held (stack-watch.sh --snooze-web 0 ends it)`);

// ------------------------------------------------------------------------------------------------ the API itself
const apiOk = health.ok && snap.ok;
if (!apiOk) {
  const why = [health, snap].filter((x) => !x.ok).map((x) => x.why).join("; ");
  S.api = { fails: (prev.api?.fails || 0) + 1, since: prev.api?.since ?? NOW, last: why };
  S.counts.apiFails++;
} else S.api = { fails: 0 };
cond("api", !apiOk, {
  name: "WATCH CANNOT REACH THE API", title: `${W}WATCH CANNOT REACH THE API`, prio: "high", dedupe: STD,
  due: () => S.api.fails >= T.apiFailRuns,
  pending: () => `API unreadable, ${S.api.fails}/${T.apiFailRuns} runs in a row (${S.api.last}); pushed from the ${T.apiFailRuns}rd`,
  body: () => `${S.api.fails} run(s) in a row since ${isoMin(S.api.since)} could not read the API (${S.api.last}). The other checks are blind meanwhile. Open https://isotherm.pages.dev/api/health in a browser: if it fails for you too, the API Worker or Pages is down (${OPS} section 5, npx wrangler tail isotherm-api); if not, it is the VPS's network.`,
  okText: () => "the watchdog reads the API again",
});

// ------------------------------------------------------------------------------------------------ i. web RPC down
// stack-watch.sh rpcprobe's reads of one RPC as the site's browser code reads it: <name>.code / .json (removed when not
// HTTP 200) / .headers (curl -D) for eth_blockNumber, <name>-pre.code / -pre.headers for its CORS preflight. kind: "net"
// (no answer, an HTTP error: maybe only from this VPS), "cors" (it answers, but a browser on the site cannot use it),
// "rpc" (an answer without a block number) or "stuck" (below).
const header = (h, k) => (h == null ? null : (new RegExp(`^${k}:[ \\t]*([^\\r\\n]*)`, "im").exec(h)?.[1].trim() ?? ""));
const httpWhy = (code) => (code && code !== "000" ? `HTTP ${code}` : "no answer");
function readRpc(name) {
  const code = (readText(`${name}.code`) || "").trim(), raw = readText(`${name}.json`), hdr = readText(`${name}.headers`);
  if (raw == null) return { ok: false, block: null, kind: "net", why: code === "200" ? "no answer" : httpWhy(code) };
  let j = null; try { j = JSON.parse(raw); } catch { /* below */ }
  const block = typeof j?.result === "string" && /^0x[0-9a-f]+$/i.test(j.result) ? parseInt(j.result, 16) : null;
  if (block === null) return { ok: false, block, kind: "rpc", why: !j || typeof j !== "object" ? "not JSON" : `no block number (${j.error ? `error ${j.error.code ?? "?"}: ${String(j.error.message ?? "").slice(0, 80)}` : "no result"})` };
  const acao = header(hdr, "access-control-allow-origin");
  if (acao !== null && acao !== "*" && acao !== SITE) return { ok: false, block, kind: "cors", why: `its CORS header (access-control-allow-origin ${acao ? `"${acao}"` : "missing"}) does not allow ${SITE}: browsers drop the answer` };
  // the preflight: a browser sends the POST only after a 2xx that allows the site's origin and the content-type header
  const pcode = (readText(`${name}-pre.code`) || "").trim(), ph = readText(`${name}-pre.headers`);
  const pao = header(ph, "access-control-allow-origin"), pah = header(ph, "access-control-allow-headers") || "";
  const allowed = pah.split(",").map((s) => s.trim().toLowerCase());
  const pre = !/^2\d\d$/.test(pcode) ? ["net", httpWhy(pcode)]
    : pao !== "*" && pao !== SITE ? ["cors", `access-control-allow-origin ${pao ? `"${pao}"` : "missing"}`]
    : !allowed.includes("content-type") && !allowed.includes("*") ? ["cors", `access-control-allow-headers ${pah ? `"${pah}"` : "missing"}, without content-type`]
    : null;
  if (pre) return { ok: false, block, kind: pre[0], why: `its CORS preflight (OPTIONS): ${pre[1]}, so browsers never send the read` };
  return { ok: true, block, kind: "", why: "" };
}
// Stuck = a block number not above the one it gave 5+ min before (a run seconds after another is not judged). Each
// judged reading becomes the next baseline, so a chain reset to a lower block fails one run, not every run after it.
const web = readRpc("webrpc"), pw = prev.webRpc || {};
const pwBlock = num(pw.block), pwAt = num(pw.blockAt);
const advanced = web.block !== null && (pwBlock === null || web.block > pwBlock);
const judged = web.block !== null && (advanced || pwAt === null || NOW - pwAt >= T.webRpcStuckSec - JIT);
if (web.ok && !advanced && judged) Object.assign(web, { ok: false, kind: "stuck", why: `stuck: block ${web.block}, and ${pwBlock} at ${isoMin(pwAt)}` });
// The deployed build's fallback RPCs (webbuild: its main script, then the fallbacks that script lists, read as webfb1,
// webfb2, ... in that order; no file = unknown, taken as none), each read the same way (one reading: no stuck check).
const build = (readText("webbuild") || "").split("\n").map((s) => s.trim()).filter(Boolean);
const siteJs = build[0] || null, fbs = build.slice(1).map((url, i) => ({ url, ...readRpc(`webfb${i + 1}`) }));
const fbOk = fbs.filter((f) => f.ok), webSev = fbOk.length ? "default" : "high";
const host = (u) => String(u).replace(/^https:\/\//, "");
const fbText = () => fbs.map((f) => `${host(f.url)} (${f.ok ? "ok" : f.why})`).join(", ");
const siteText = () => (!siteJs ? "the deployed site's script could not be read for its fallback RPCs (none assumed)"
  : `the deployed site (${siteJs}) ${fbs.length ? `falls back to ${fbText()}` : "has no fallback RPC"}`);
S.webRpc = { fails: web.ok ? 0 : (pw.fails || 0) + 1, block: judged ? web.block : pwBlock, blockAt: judged ? NOW : pwAt };
if (!web.ok) Object.assign(S.webRpc, { since: pw.fails ? pw.since ?? NOW : NOW, last: web.why, kind: web.kind });
// Pushed at default (the site was on a fallback) and now no fallback answers: the high push goes out at once, not
// after the default one's 3 h repeat window.
const wasWeb = prev.conds?.["web-rpc"];
if (!webSnoozed && !web.ok && webSev === "high" && wasWeb?.alerted && !pw.hi) unstamp(`${W}WEB RPC DOWN`);
const curlPost = `curl -s -D - -H 'content-type: application/json' -H 'Origin: ${SITE}' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' ${WEB_RPC}`;
const curlPre = `curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: ${SITE}' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' ${WEB_RPC}`;
const macCheck = (kind) => (kind === "cors"
  ? `Check from the Mac: ${curlPre} ; then ${curlPost} ; both must show access-control-allow-origin ${SITE} (or *), the first also content-type in access-control-allow-headers (a block number alone does not mean a browser can use it).`
  : kind === "net" ? `Check from the Mac: ${curlPost} ; if it answers there (HTTP 200, a block number, access-control-allow-origin ${SITE}) and WATCH CANNOT REACH THE API is open too, suspect this VPS's network.`
  : `Check from the Mac: ${curlPost} ; it answers, but ${kind === "stuck" ? "its block does not move (it should rise ~2.5 a second)" : "without a block number"}: a problem of the RPC itself.`);
cond("web-rpc", webSnoozed ? null : !web.ok, {
  name: "WEB RPC DOWN", title: `${W}WEB RPC DOWN`, prio: webSev, dedupe: STD,
  due: () => S.webRpc.fails >= T.webRpcFailRuns,
  pending: () => `WEB RPC DOWN: ${WEB_RPC} failed ${S.webRpc.fails}/${T.webRpcFailRuns} runs in a row (${S.webRpc.last}); pushed from the ${T.webRpcFailRuns}rd, ${webSev === "high" ? "high" : "default (a fallback answers)"}`,
  body: () => `${S.webRpc.fails} run(s) in a row since ${isoMin(S.webRpc.since)}, ${WEB_RPC} failed as a browser on ${SITE} reads it (eth_blockNumber and its CORS preflight): ${S.webRpc.last}. The web app reads prices, trades and signs (Dynamic) through it first (apps/web/src/config.ts RPC_URL), and ${siteText()}: ${fbOk.length ? "judges can still read and trade through the fallback" : "judges see no prices and cannot trade while it fails"}. The API, the maker and this watch read Ankr first, so nothing else notices. ${macCheck(S.webRpc.kind)} Known and nothing to fix: stack-watch.sh --snooze-web HOURS on the VPS.`,
  okText: () => `${WEB_RPC} answers the site again (block ${web.block})`,
});
S.webRpc.hi = !!S.conds["web-rpc"]?.alerted && (!!pw.hi || (!web.ok && webSev === "high" && !webSnoozed));

// ------------------------------------------------------------------------------------------------ a. maker stalled
const snapAt = snap.ok ? Date.parse(snap.json.receivedAt || snap.json.generatedAt || "") / 1000 : NaN;
const snapAge = Number.isFinite(snapAt) ? Math.max(0, NOW - snapAt) : null;
const stalled = snap.ok ? (snap.json.empty === true || snapAge === null || snapAge > T.stalledSec) : null;
cond("stalled", snoozed ? null : stalled, {
  name: "MAKER STALLED", title: `${W}MAKER STALLED`, prio: "high", dedupe: STD,
  due: (since, runs) => runs >= T.stalledRuns || (snapAge !== null && snapAge >= T.stalledAtOnceSec),
  pending: (since, runs) => `MAKER STALLED (snapshot ${snapAge === null ? "missing" : `${dur(snapAge)} old`}, stale run ${runs} since ${hhmm(since)}Z; pushed on the next stale run, or once it is ${dur(T.stalledAtOnceSec)} old)`,
  body: () => (snapAge === null
    ? "/api/snapshot holds no maker snapshot. "
    : `The maker Worker's last snapshot is ${dur(snapAge)} old (${isoMin(snapAt)}); it publishes one every minute. `)
    + "Its ticks are failing or stopped: quotes go stale, and the roll, the kill switch and the challenge watcher may not run. From apps/maker-worker: node scripts/control.mjs status, then node scripts/control.mjs ticks 5 (" + OPS + " 8.5; rollback 8.4). A deliberate pause: stack-watch.sh --snooze HOURS on the VPS.",
  okText: () => `the maker's snapshot is fresh again (${dur(snapAge ?? 0)} old)`,
});

// ------------------------------------------------------------------------------------------------ b. books empty
const ladders = snap.ok && Array.isArray(snap.json.ladders) ? snap.json.ladders.filter((l) => l && typeof l === "object") : [];
const makerFresh = stalled === false && !snoozed; // the ladder data is current and not deliberately paused
const inClose = ladders.some((l) => num(l.closeTime) !== null && NOW >= l.closeTime - T.closeBeforeSec && NOW <= l.closeTime + T.closeAfterSec);
const hasSide = (px, remaining, size) => px !== null && px !== undefined && (num(remaining) ?? num(size) ?? 1) > 0;
if (makerFresh) {
  const empties = [];
  for (const l of ladders) {
    // only a rolled, trading ladder (status "active"); not before its roll, not from its kill switch on
    if (l.status !== "active" || num(l.closeTime) === null || NOW >= l.closeTime - T.closeBeforeSec) continue;
    for (const s of Array.isArray(l.strikes) ? l.strikes : []) {
      if (!s || typeof s !== "object") continue;
      const fair = num(s.fair);
      if (fair === null || fair < T.booksFairLo || fair > T.booksFairHi) continue;
      const noBid = !hasSide(s.bid, s.bidRemaining, s.bidSize), noAsk = !hasSide(s.ask, s.askRemaining, s.askSize);
      if (!noBid && !noAsk) continue;
      const key = `${l.station}:${l.date}:${s.k}`;
      const since = prev.books?.[key]?.since ?? NOW;
      S.books[key] = { since };
      empties.push({ label: `${l.station} ${ymd(l.date)} >=${s.k}C (fair ${fair.toFixed(2)}) ${noBid && noAsk ? "no bid, no ask" : noBid ? "no bid" : "no ask"} since ${hhmm(since)}Z`, since, mode: s.mode });
    }
  }
  const due = empties.filter((e) => NOW - e.since >= T.booksAfterSec - JIT);
  for (const e of empties.filter((x) => !due.includes(x))) log(`pending: BOOKS EMPTY ${e.label} (pushed after ${dur(T.booksAfterSec)})`);
  if (inClose && due.length) log(`BOOKS EMPTY held: inside a close window (closeTime - 15 min to + 5 min: the kill switch); ${due.length} strike(s) due`);
  // Raised by a strike empty for 60 min; once raised, any empty at-the-money strike keeps it open (a refill followed
  // by a new gap is the same problem, not a CLEARED and a new alert an hour later).
  const shown = due.length ? due : empties;
  cond("books", inClose ? null : due.length > 0 || (!!prev.conds?.books?.alerted && empties.length > 0), {
    name: "BOOKS EMPTY", title: `${W}BOOKS EMPTY`, prio: "default", dedupe: STD,
    body: () => `${shown.length} at-the-money strike(s) without a maker quote on one side${due.length ? ` for over ${dur(T.booksAfterSec)}` : ""}: ${shown.map((e) => e.label + (e.mode && e.mode !== "quoting" ? ` [${e.mode}]` : "")).join("; ")}. Judges cannot trade there. Likely the quoting cap (6 MON per Taipei day, resets 16:00 UTC) is spent or the maker cannot send: from apps/maker-worker, node scripts/control.mjs status (budget.tier, errors). Cap: CONFIG_OVERRIDES, ${OPS} section 0. A deliberate pull: stack-watch.sh --snooze HOURS on the VPS.`,
    okText: () => "every at-the-money strike has a maker bid and ask again (or left 0.10-0.90)",
  });
} else {
  Object.assign(S.books, prev.books || {});
  cond("books", null, {});
}

// ------------------------------------------------------------------------------------------------ h. ladders open
// Each station's UTC offset, learned from its ladders (dayEnd = the local midnight that ends `date`), remembered for
// T.ladderMemorySec, so a station whose ladders all vanished from the snapshot is still checked.
const ymdOfDay = (dayNo) => new Date(dayNo * DAY * 1000).toISOString().slice(0, 10).replace(/-/g, "");
const isOpen = (l) => l.status === "active" || (l.status === "closed" && Array.isArray(l.strikes) && l.strikes.some((s) => s && s.market));
const activeL = ladders.filter((l) => l.status === "active");
const ladText = (l) => `${l.station} ${ymd(l.date)}`;
for (const [st, v] of Object.entries(prev.stations || {})) if (v && num(v.off) !== null && num(v.seen) !== null && NOW - v.seen < T.ladderMemorySec) S.stations[st] = v;
for (const l of ladders) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(l.date)), de = num(l.dayEnd);
  if (!m || de === null || typeof l.station !== "string" || !/^[A-Z0-9]{4}$/.test(l.station)) continue;
  const off = Date.UTC(+m[1], +m[2] - 1, +m[3] + 1) / 1000 - de;
  if (Math.abs(off) <= 14 * HOUR) S.stations[l.station] = { off, seen: NOW };
}
// the ladder that must be open now (due = its roll time, 12:00 local the day before) and the next one to be rolled
function ladderPlan(st, off) {
  const local = NOW + off, dayNo = Math.floor(local / DAY), sec = local - dayNo * DAY;
  const late = sec >= T.rollLocalSec + T.rollGraceSec - JIT;
  const mk = (d) => { const date = ymdOfDay(d); const l = ladders.find((x) => x.station === st && String(x.date) === date) || null; return { date, dueAt: (d - 1) * DAY + T.rollLocalSec - off, l, open: !!l && isOpen(l) }; };
  return { want: mk(dayNo + (late ? 1 : 0)), next: mk(dayNo + (late ? 2 : 1)) };
}
const stateText = (l) => (!l ? "not in the maker's state (its roll was refused before planning, e.g. no Polymarket ladder and no v0 forecast)"
  : l.status === "planned" ? '"planned" (strikes chosen, no transaction yet)'
  : l.status === "rolling" ? '"rolling" (series created; its markets or margin not done)'
  : l.status === "closed" ? "closed without markets (the kill switch closed it unrolled)"
  : `"${l.status}"`);
for (const [st, v] of Object.entries(S.stations)) {
  if (!makerFresh) break;
  const { want } = ladderPlan(st, v.off);
  cond(`roll:${st}`, !want.open, {
    name: `LADDER NOT OPENED ${st}`, title: `${W}LADDER NOT OPENED ${st}`, prio: "high", dedupe: STD,
    body: () => `${st} ${ymd(want.date)} is not open for trading: at ${hhmm(NOW)}Z it is ${stateText(want.l)}, ${dur(NOW - want.dueAt)} after the maker's roll time (12:00 local, ${isoMin(want.dueAt)}). Trading now: ${activeL.length ? activeL.map((l) => `${ladText(l)} to ${num(l.closeTime) !== null ? hhmm(l.closeTime) + "Z" : "?"}`).join(", ") : "nothing"}. The maker retries a refused roll every 5 min; the usual cause is the operator short of MON (the roll needs ~0.85) or the roll meter's cap. From apps/maker-worker: node scripts/control.mjs status (errors "roll ${st}:..."), then node scripts/control.mjs roll ${st} ${ymd(want.date)} (${OPS} sections 4 and 8.5).`,
    okText: () => `${st} ${ymd(want.date)} is active`,
  });
}
if (!makerFresh) keepConds("roll:");
cond("no-active", makerFresh ? (inClose ? null : activeL.length === 0) : null, {
  name: "NO ACTIVE LADDER", title: `${W}NO ACTIVE LADDER`, prio: "high", dedupe: STD, after: T.noActiveAfterSec, minRuns: T.readyRuns,
  body: (since) => `No ladder has been "active" since ${isoMin(since)}: judges cannot trade anything. In the snapshot: ${ladders.length ? ladders.map((l) => `${ladText(l)} ${l.status ?? "?"}`).join(", ") : "no ladders"}. When rolls work, tomorrow's ladder is active from 12:00 local, before today's closes. From apps/maker-worker: node scripts/control.mjs status (errors "roll ..."), node scripts/control.mjs roll <ICAO> <date> (${OPS} sections 4 and 8.5).`,
  okText: () => `trading again: ${activeL.map(ladText).join(", ")}`,
});

// ------------------------------------------------------------------------------------------------ c. drip / relay / relayer
const dripCap = num(L.dripDailyCap), relayCap = num(L.relayDailyCap), drips = num(L.dripsToday), relays = num(L.relaysToday);
const dripCapUsed = dripCap !== null && drips !== null && drips >= dripCap;
const relayCapUsed = relayCap !== null && relays !== null && relays >= relayCap;
const mon = H ? num(H.monBalance) : null, dripMon = H ? num(H.dripMon) : null;
const perDay = dripCap !== null && relayCap !== null && dripMon !== null ? dripCap * (dripMon + DRIP_GAS_MON) + relayCap * RELAY_MON : null;
const daysTo = (T.untilEpoch - NOW) / DAY; // to the end of END_DAY (UTC)
const runway = () => (mon !== null && perDay ? `${(mon / perDay).toFixed(1)} worst-case days at the current caps (${dripCap} drips x ${(dripMon + DRIP_GAS_MON).toFixed(3)} + ${relayCap} relays x ${RELAY_MON} = ${perDay.toFixed(2)} MON/day; ${Math.max(0, daysTo).toFixed(1)} days left to ${END_DAY.slice(5)})` : "runway unknown");
const why = () => (mon === null ? "the API could not read the relayer's balance (RPC trouble: see health.rpc)" : `relayer ${f2(mon)} MON`);
cond("api-unhealthy", H ? (H.ok !== true || !H.relayer) : null, {
  name: "API UNHEALTHY", title: `${W}API UNHEALTHY`, prio: "high", dedupe: STD, after: T.readyAfterSec, minRuns: T.readyRuns,
  body: (since) => `/api/health has reported ${H.ok !== true ? "ok=false" : "no relayer (RELAYER_KEY secret missing?)"} since ${isoMin(since)}. Drips and gasless mints are down. npx wrangler tail isotherm-api; ${OPS} section 5.`,
  okText: () => "/api/health is ok again",
});
cond("drip-down", H ? (H.dripEnabled !== false && H.dripReady === false && !dripCapUsed) : null, {
  name: "DRIP DOWN", title: `${W}DRIP DOWN`, prio: "high", dedupe: STD, after: T.readyAfterSec, minRuns: T.readyRuns,
  body: (since) => `/api/health has said dripReady=false since ${isoMin(since)} (${drips ?? "?"}/${dripCap ?? "?"} drips today, so not the cap; ${why()}; a drip needs dripMon + gas + the reserve). New users get no test MON. Check /api/health rpc and the balance; npx wrangler tail isotherm-api (${OPS} section 5).`,
  okText: () => "drips are ready again",
});
cond("relay-down", H ? (H.relayEnabled !== false && H.relayReady === false && !relayCapUsed) : null, {
  name: "RELAY DOWN", title: `${W}RELAY DOWN`, prio: "high", dedupe: STD, after: T.readyAfterSec, minRuns: T.readyRuns,
  body: (since) => `/api/health has said relayReady=false since ${isoMin(since)} (${relays ?? "?"}/${relayCap ?? "?"} relays today, so not the cap; ${why()}). Gasless mints fail for new users. Check /api/health rpc and the balance; npx wrangler tail isotherm-api (${OPS} section 5).`,
  okText: () => "gasless mints are ready again",
});
cond("relayer-low", mon === null ? null : mon < T.relayerLowMon, {
  name: "RELAYER LOW", title: `${W}RELAYER LOW`, prio: "high", dedupe: BAL,
  body: () => `The relayer holds ${f2(mon)} MON (< ${T.relayerLowMon}): ${runway()}. Fund it from the deployer, then re-size the caps (apps/api: node scripts/size-caps.mjs, npm run deploy; ${OPS} sections 0 and 5).`,
  okText: () => `the relayer holds ${f2(mon)} MON`,
});
const flt = H ? num(H.ausdFloat) : null, dripAusd = (H && num(H.dripAusd)) || 1000;
cond("float-low", flt === null ? null : flt < T.floatLowDrips * dripAusd, {
  name: "AUSD FLOAT LOW", title: `${W}AUSD FLOAT LOW`, prio: "default", dedupe: STD, after: T.readyAfterSec, minRuns: T.readyRuns,
  body: (since) => `The relayer's AUSD float is ${flt} (< ${T.floatLowDrips} drips of ${dripAusd}) since ${isoMin(since)}; the API's minute cron should refill it from the faucet to 50,000, so the refill is failing (faucet cooldown or MON). Drips fall back to the public faucet meanwhile. npx wrangler tail isotherm-api (${OPS} section 5).`,
  okText: () => `the AUSD float is ${flt}`,
});

// ------------------------------------------------------------------------------------------------ d. caps used
const today = utcDay(NOW), t0 = dayStart(NOW);
S.caps = prev.caps?.day === today ? { ...prev.caps } : { day: today };
if (H) {
  for (const [k, used, cap, full, what, fix] of [
    ["drip", drips, dripCap, dripCapUsed, "drips", `If no judges are active, it is likely a bot: set DRIP_MON back to 0.15 or pause drips (DRIP_ENABLED = "0" in apps/api/wrangler.toml, then npm run deploy in apps/api): see ${OPS} section 0.`],
    ["relay", relays, relayCap, relayCapUsed, "relayed mints", `If no judges are active, it is likely a bot: lower RELAY_DAILY_CAP / RELAY_PER_IP_PER_DAY or pause relays (RELAY_ENABLED = "0" in apps/api/wrangler.toml, then npm run deploy in apps/api): see ${OPS} section 0.`],
  ]) {
    if (!full || S.caps[k]) continue; // once per UTC day (the counter only resets at 00:00 UTC); the outbox re-sends it until delivered
    S.caps[k] = NOW;
    const K = k.toUpperCase();
    if (NOW < t0 + T.capEarlyHourUtc * HOUR) once("high", `${W}${K} CAP USED EARLY`, `${used}/${cap} ${what} used by ${hhmm(NOW)} UTC (the counter resets 00:00 UTC). ${fix} New users get none until 00:00 UTC.`);
    else once("low", `${W}${K} CAP REACHED`, `${used}/${cap} ${what} used by ${hhmm(NOW)} UTC: new users get none until 00:00 UTC (08:00 Taipei). Heavy judge use is fine; if it is a bot, ${OPS} section 0.`);
  }
  // usage per UTC day for the digest (the peak seen: the counters only grow within a day)
  if (drips !== null && relays !== null) {
    if (S.usage && S.usage.day !== today) { S.usagePrev = S.usage; S.usage = null; }
    S.usage = { day: today, drips: Math.max(drips, S.usage?.drips || 0), relays: Math.max(relays, S.usage?.relays || 0), at: NOW, dripCap, relayCap };
  }
}

// ------------------------------------------------------------------------------------------------ e. balances
const bal = { treasury: balance("treasury"), maker: balance("maker"), operator: balance("operator") };
if (bal.maker === null && stalled === false && num(snap.json?.maker?.mon) !== null) bal.maker = num(snap.json.maker.mon); // the snapshot's own reading
cond("treasury-low", bal.treasury === null ? null : bal.treasury < T.treasuryLowMon, {
  name: "TREASURY LOW", title: `${W}TREASURY LOW`, prio: "high", dedupe: BAL,
  body: () => `The treasury holds ${f2(bal.treasury)} MON (< ${T.treasuryLowMon}, the judging line); it tops up the maker, operator, relayer, attester and guardian, up to 14 MON a day. Fund it from the deployer: cd docs/evidence/golive && node fund.mjs treasury=20 --dry, then without --dry (${OPS} section 4).`,
  okText: () => `the treasury holds ${f2(bal.treasury)} MON`,
});
cond("maker-low", bal.maker === null ? null : bal.maker < T.makerLowMon, {
  name: "MAKER LOW", title: `${W}MAKER LOW`, prio: "high", dedupe: BAL, after: T.roleLowAfterSec, minRuns: T.readyRuns,
  body: (since) => `The maker holds ${f2(bal.maker)} MON (< ${T.makerLowMon}) since ${isoMin(since)}; the treasury (${f2(bal.treasury)} MON) tops it up below 2, so its top-ups are failing. Quotes stop soon. From apps/maker-worker: node scripts/control.mjs treasury; by hand: cd docs/evidence/golive && node fund.mjs maker=3 (${OPS} section 4).`,
  okText: () => `the maker holds ${f2(bal.maker)} MON`,
});
cond("operator-low", bal.operator === null ? null : bal.operator < T.operatorLowMon, {
  name: "OPERATOR LOW", title: `${W}OPERATOR LOW`, prio: "high", dedupe: BAL, after: T.roleLowAfterSec, minRuns: T.readyRuns,
  body: (since) => `The operator holds ${f2(bal.operator)} MON (< ${T.operatorLowMon}) since ${isoMin(since)}; the treasury (${f2(bal.treasury)} MON) tops it up below 1.2, so its top-ups are failing, and the 12:00 Taipei roll (04:00 UTC) needs ~0.85 MON. From apps/maker-worker: node scripts/control.mjs treasury; by hand: cd docs/evidence/golive && node fund.mjs operator=1.5 (${OPS} section 4).`,
  okText: () => `the operator holds ${f2(bal.operator)} MON`,
});

// ------------------------------------------------------------------------------------------------ f. settlement overdue
// Ladders: those in this snapshot (closed ones stay listed 36 h after their close) plus those remembered from earlier
// runs; only those that reached the chain. Resolved = in /api/settlements, else Resolver.resultOf (one cast call,
// only past day end + 5 h and only until it is resolved; a normal night makes no chain read here at all).
const setlList = setl.ok && Array.isArray(setl.json.settlements) ? setl.json.settlements.filter((x) => x && typeof x === "object") : null;
const setlAge = setl.ok ? NOW - Date.parse(setl.json.updatedAt || "") / 1000 : NaN;
const setlFresh = setlList !== null && Number.isFinite(setlAge) && setlAge < 30 * MIN;
const onChain = (l) => l.status === "active" || (Array.isArray(l.strikes) && l.strikes.some((s) => s && (s.seriesId || s.market)));
for (const [k, v] of Object.entries(prev.ladders || {})) if (v && num(v.dayEnd) !== null && NOW - v.dayEnd < T.ladderMemorySec) S.ladders[k] = v;
for (const l of ladders) {
  const k = `${l.station}:${l.date}`;
  if (num(l.dayEnd) !== null && NOW - l.dayEnd < T.ladderMemorySec) S.ladders[k] = { dayEnd: l.dayEnd, resolved: S.ladders[k]?.resolved || false, chain: !!S.ladders[k]?.chain || onChain(l) };
}
const chainReads = [];
for (const [k, v] of Object.entries(S.ladders)) {
  const [station, date] = k.split(":");
  if (setlList?.some((x) => x.station === station && String(x.date) === date && Number(x.status) >= 1)) v.resolved = true;
  if (!v.chain || NOW < v.dayEnd + T.overdueAfterSec - JIT) continue; // never reached the chain: nothing to settle
  let unresolved = null, via = "";
  if (v.resolved) unresolved = false;
  else {
    const r = resultOf(station, date);
    chainReads.push(`resultOf ${station} ${date} -> ${r ? `status ${r.status}` : "read failed"}`);
    if (r) { unresolved = r.status === 0; v.resolved = !unresolved; }
    else if (setlFresh) { unresolved = true; via = " (chain read failed; per /api/settlements)"; }
  }
  const title = `${W}SETTLEMENT OVERDUE ${station} ${ymd(date)}`;
  cond(`overdue:${k}`, unresolved, {
    name: `SETTLEMENT OVERDUE ${station} ${ymd(date)}`, title, prio: "high", dedupe: STD, clearSec: 0,
    body: () => `No result on the Resolver ${dur(NOW - v.dayEnd)} after the day end (${isoMin(v.dayEnd)})${via}; the VPS settles at day end + 2 h 05 and retries hourly. On the Mac: ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh status (writer, conflict, cre session), then ... logs 100. Fix as vps/README.md sections 4 and 9; the Worker voids it at day end + 48 h.`,
    okText: () => `${station} ${ymd(date)} has its result on the Resolver`,
  });
}

// ------------------------------------------------------------------------------------------------ e2. guardian, attester
bal.guardian = balance("guardian");
bal.attester = balance("attester");
cond("guardian-low", bal.guardian === null ? null : bal.guardian < T.guardianLowMon, {
  name: "GUARDIAN LOW", title: `${W}GUARDIAN LOW`, prio: "high", dedupe: BAL, after: T.roleLowAfterSec, minRuns: T.readyRuns,
  body: (since) => `The guardian holds ${f4(bal.guardian)} MON (< ${T.guardianLowMon}) since ${isoMin(since)}; the treasury (${f2(bal.treasury)} MON) tops it up below 0.05, so its top-ups are failing. It pays the gas of challenge() (~0.011 MON: the Worker challenges a wrong settlement inside the 900 s window) and pause(); without it a wrong result pays out. From apps/maker-worker: node scripts/control.mjs treasury; by hand: cd docs/evidence/golive && node fund.mjs guardian=0.15 (${OPS} sections 3 and 4).`,
  okText: () => `the guardian holds ${f4(bal.guardian)} MON`,
});
cond("attester-low", bal.attester === null ? null : bal.attester < T.attesterLowMon, {
  name: "ATTESTER LOW", title: `${W}ATTESTER LOW`, prio: "high", dedupe: BAL, after: T.roleLowAfterSec, minRuns: T.readyRuns,
  body: (since) => `The attester holds ${f4(bal.attester)} MON (< ${T.attesterLowMon}, about ${Math.floor(bal.attester / REPORT_MON)} reports at ${REPORT_MON}) since ${isoMin(since)}; the treasury (${f2(bal.treasury)} MON) tops it up below 0.3, so its top-ups are failing. It sends every settlement report (18:05 UTC, retried hourly): without gas no day settles, and the Worker voids a day 48 h after its end. From apps/maker-worker: node scripts/control.mjs treasury; by hand: cd docs/evidence/golive && node fund.mjs attester=0.5 (${OPS} sections 2 and 4).`,
  okText: () => `the attester holds ${f4(bal.attester)} MON`,
});

// ------------------------------------------------------------------------------------------------ summary line
const plans = makerFresh || stalled === false ? Object.entries(S.stations).map(([st, v]) => [st, ladderPlan(st, v.off)]) : [];
const planText = ([st, p]) => `next ${st} ${ymd(p.next.date)} at ${isoMin(p.next.dueAt)} (${p.next.l ? `${p.next.l.status ?? "?"}` : "not planned yet"})${p.want.open ? "" : `; ${st} ${ymd(p.want.date)} NOT OPEN`}`;
log(`read: snapshot ${snapAge === null ? "?" : dur(snapAge)} old, ${activeL.length} active ladder(s)${plans.length ? ` (${plans.map(planText).join("; ")})` : ""}${snoozed ? `, maker checks snoozed until ${hhmm(snoozeUntil)}Z` : ""}; relayer ${f2(mon)} MON, float ${flt ?? "?"}, drips ${drips ?? "?"}/${dripCap ?? "?"}, relays ${relays ?? "?"}/${relayCap ?? "?"}; treasury ${f2(bal.treasury)}, maker ${f2(bal.maker)}, operator ${f2(bal.operator)}, guardian ${f4(bal.guardian)}, attester ${f4(bal.attester)} MON; settlements ${setlList ? setlList.length : "?"}${chainReads.length ? `; chain: ${chainReads.join(", ")}` : ""}; web RPC ${web.ok ? `block ${web.block}` : `FAILED (${web.why})`}${fbs.length ? `, fallbacks ${fbText()}` : siteJs ? "" : ", the site's fallbacks unknown"}${webSnoozed ? `, WEB RPC DOWN snoozed until ${hhmm(webSnoozeUntil)}Z` : ""}`);
if (FIX) log(`fixture reads: ${castLog.join(", ") || "none"}`);

// ------------------------------------------------------------------------------------------------ g. daily digest
// The CRE line: the settlement job's runs (--cre-runs; login "ok" / "missed" / "other" per lib.sh CRE_LAPSE_JS). It
// says only what the records show: the login showed on the recorded runs from the first one after the last lapse
// (CRE_AFTER misses in a row, what CRE LOGIN NEEDED pushes on) to the last one with it. That span is not the session's
// age: a relogin with no miss before it (vps/relogin.sh run ahead of time) leaves no trace in the records, and a gap in
// them (T.creGapSec without a record) is time nobody looked. A single miss is a CRE API error, not a new session.
function creLine() {
  if (!CRE_RUNS || !fs.existsSync(CRE_RUNS)) return null; // no settlement records on this host
  let runs = null; try { runs = JSON.parse(fs.readFileSync(CRE_RUNS, "utf8")); } catch { /* below */ }
  if (!Array.isArray(runs)) return "CRE: ? (the settlement job's evidence records are unreadable).";
  const at = (r) => Date.parse(r.at) / 1000;
  runs = runs.filter((r) => r && typeof r === "object" && Number.isFinite(at(r)));
  if (!runs.length) return "CRE: no settlement run recorded yet.";
  let streak = null, misses = [], singles = [];
  for (const r of runs) {
    if (r.login === "missed") misses.push(r);
    else if (r.login === "ok") {
      if (misses.length >= CRE_AFTER || !streak) { streak = r; singles = []; } else singles.push(...misses);
      misses = [];
    }
  }
  const last = runs[runs.length - 1], off = runs.filter((r) => r.path === "official").pop();
  const rep = runs.filter((r) => Array.isArray(r.sent) && r.sent.length).pop(), shown = runs.filter((r) => r.login === "ok").pop();
  const exitText = (r) => (Number(r.exit) === 0 ? "ok" : `FAILED (exit ${r.exit ?? "?"}${r.meaning ? `: ${r.meaning}` : ""})`);
  const parts = [];
  if (NOW - at(last) > T.creStaleSec) parts.push(`NO SETTLEMENT RUN RECORDED SINCE ${isoMin(at(last))} (${durD(NOW - at(last))} ago; it runs hourly at :05): is isotherm-settle.timer running? (isotherm-vps.sh status)`);
  parts.push(off ? `last official run ${isoMin(at(off))} ${exitText(off)}` : `no official run in the last ${runs.length} runs`);
  if (last.stoodDown) parts.push(`the last run (${isoMin(at(last))}) STOOD DOWN (${last.stoodDown === "don" ? "settlement runs on the Chainlink DON" : "this host released the settlement writer role to another host"}; nothing signed here)`);
  else if (last !== off && last.path !== "official" && last.login === "ok") parts.push(`the last run (${isoMin(at(last))}) took the HARNESS fallback${last.why ? ` (${last.why})` : ""}`);
  if (rep) parts.push(`last report ${rep.sent.map((o) => `${o.station} ${ymd(o.date)} ${o.action ?? "?"}${o.tmaxC !== null && o.tmaxC !== undefined ? ` ${o.tmaxC}C` : ""}${o.confirmed ? ` (${o.confirmed})` : ""}`).join(", ")} at ${isoMin(at(rep))} on the ${rep.path === "official" ? "official path" : "HARNESS fallback"}`);
  let login;
  if (misses.length >= CRE_AFTER) login = `LOGIN LAPSED: ${misses.length} runs in a row without it since ${isoMin(at(misses[0]))}${shown ? ` (last shown ${isoMin(at(shown))})` : ""}; CRE LOGIN NEEDED has the fix (vps/relogin.sh on the Mac)`;
  else {
    if (streak) {
      const span = runs.slice(runs.indexOf(streak), runs.indexOf(shown) + 1), gaps = [];
      for (let i = 1; i < span.length; i++) if (at(span[i]) - at(span[i - 1]) > T.creGapSec) gaps.push([at(span[i - 1]), at(span[i])]);
      const big = gaps.slice().sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))[0];
      login = `Login shown from ${isoMin(at(streak))} to ${isoMin(at(shown))} on every recorded run`
        + (singles.length ? ` but ${singles.length} single miss(es) (the last at ${isoMin(at(singles[singles.length - 1]))}; each followed by a run with it: CRE API errors, no action)` : "")
        + (big ? `; no run recorded ${isoMin(big[0])} to ${isoMin(big[1])}${gaps.length > 1 ? ` (and ${gaps.length - 1} shorter gap(s))` : ""}` : "")
        + `; a span of ${durD(at(shown) - at(streak))}, not the session's age (a relogin with no miss before it leaves no record)`;
    } else login = "No run showed the login";
    if (misses.length) login += `; the LAST run (${isoMin(at(misses[0]))}) missed it: CRE LOGIN NEEDED follows if the next one does too`;
  }
  return `CRE: ${parts.join("; ")}. ${login}.`;
}
if (NOW >= t0 + T.digestHourUtc * HOUR - JIT && S.digest?.day !== today) {
  const first = !prev.lastRun;
  const yday = utcDay(t0 - 1);
  const u = S.usagePrev?.day === yday ? S.usagePrev : S.usage?.day === yday ? S.usage : null;
  const tot = { drips: num(H?.dripsTotal), relays: num(H?.relayedTotal) };
  const d0 = S.digest?.totals || {};
  const delta = (a, b) => (a !== null && num(b) !== null ? `+${a - b}` : "?");
  const set = setlList || [];
  const latest = set.slice().sort((a, b) => Number(b.date) - Number(a.date))[0];
  const st = stats.ok ? stats.json : null;
  const open = Object.values(S.conds).filter((c) => c.alerted).map((c) => `${c.title.slice(W.length)} (since ${isoMin(c.since)}${c.okSince ? `; not seen since ${hhmm(c.okSince)}Z` : ""})`);
  const lines = [
    first ? `First digest: the watchdog is running (every 10 min; this digest daily at 01:00 UTC).` : null,
    u ? `Yesterday (UTC ${yday.slice(5)}): ${u.drips}/${u.dripCap ?? "?"} drips, ${u.relays}/${u.relayCap ?? "?"} relayed mints (last seen ${hhmm(u.at)}Z). Since the last digest: ${delta(tot.drips, d0.drips)} drips, ${delta(tot.relays, d0.relays)} mints.`
      : `Yesterday (UTC ${yday.slice(5)}): no counter samples. Totals: ${tot.drips ?? "?"} drips, ${tot.relays ?? "?"} relayed mints.`,
    `Relayer ${f2(mon)} MON = ${runway()}; AUSD float ${flt ?? "?"}.`,
    `Treasury ${f2(bal.treasury)}, maker ${f2(bal.maker)}, operator ${f2(bal.operator)}, guardian ${f4(bal.guardian)}, attester ${f4(bal.attester)} MON. Maker quoting spend vs its 6 MON cap is not public (control.mjs status).`,
    `Web RPC (${host(WEB_RPC)}): ${web.ok ? `ok, block ${web.block}` : `FAILING (${web.why})`}; ${siteText()}.`,
    !snap.ok ? "Ladders: ? (/api/snapshot unreadable)."
      : `Ladders: ${activeL.length ? `${activeL.length} active (${activeL.map((l) => `${ladText(l)} to ${num(l.closeTime) !== null ? hhmm(l.closeTime) + "Z" : "?"}`).join(", ")})` : "NONE active"}${plans.length ? `; ${plans.map(([s, p]) => `next ${s} ${ymd(p.next.date)} opens ${isoMin(p.next.dueAt)} (${p.next.l ? `now ${p.next.l.status ?? "?"}` : "not planned yet"})`).join("; ")}` : ""}${stalled !== false ? " (from a stale snapshot)" : ""}.`,
    setlList ? `Settlements: ${set.filter((x) => Number(x.status) === 1).length} settled, ${set.filter((x) => Number(x.status) === 2).length} void${latest ? `; latest ${latest.station} ${ymd(latest.date)} ${Number(latest.status) === 1 ? `${latest.tmaxC}C` : "void"}` : ""}.` : "Settlements: ? (/api/settlements unreadable).",
    creLine(),
    st ? `Trading: ${st.nonMakerWallets ?? "?"} non-maker wallets, ${st.nonMakerFills ?? "?"} non-maker fills in all.` : null,
    `Open alerts: ${open.length ? open.join("; ") : "none"}.`,
    snoozed ? `Snoozed: the maker checks until ${isoMin(snoozeUntil)} (stack-watch.sh --snooze 0 ends it).` : null,
    webSnoozed ? `Snoozed: WEB RPC DOWN until ${isoMin(webSnoozeUntil)} (stack-watch.sh --snooze-web 0 ends it).` : null,
    `Watch: ${S.counts.runs} run(s) since the last digest, ${S.counts.apiFails} could not read the API.`,
  ].filter(Boolean);
  once("default", `${W}daily digest ${today}`, lines.join("\n"));
  S.digest = { day: today, at: NOW, totals: { drips: tot.drips, relays: tot.relays } };
  S.counts = { runs: 0, apiFails: 0 };
}
finish();

function finish() {
  flushOutbox();
  fs.writeFileSync(STATE_OUT, JSON.stringify(S) + "\n");
  process.stdout.write(out.length ? out.join("\n") + "\n" : "");
  process.exit(0);
}
