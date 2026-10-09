// Operator console for the maker Worker. It has no public URL: everything goes through its control KV namespace
// (`wrangler kv`, authenticated with your Cloudflare login). Writes a control document the Durable Object applies on
// its next tick (seq = now in ms, so a newer document always wins); reads the outbox the Worker writes every tick.
//
//   node scripts/control.mjs status | summary | tick | alerts | result | cron
//                                              (status: mode, ladders, meters with the quoting tier and the reserve meter,
//                                              RPC endpoints, push channel, watcher, and the treasury section)
//   node scripts/control.mjs treasury          the last treasury pass: balances vs min/target, today's top-ups and caps
//   node scripts/control.mjs ticks [n]          the last n (<= 90) ticks, one line per strike: fair, guard, action,
//                                              desired vs resting quote, and the live maker's published quote
//   node scripts/control.mjs compare [maker.log] shadow vs the live Mac maker over those ticks (agreement %, and every
//                                              difference classified: timing or UNEXPLAINED)
//   node scripts/control.mjs arm               live flag ON (confirms with the maker address derived from
//                                              ~/.config/isotherm/maker.key; live also needs MAKER_MODE=live)
//   node scripts/control.mjs disarm            live flag OFF (shadow from the next tick)
//   node scripts/control.mjs import-state <state.json> [txs.jsonl]   the Mac maker's state (order ids, lastQuote,
//                                              budget) -> live state; disarmed only. Today's MON is re-booked onto the
//                                              Worker's split meters from txs.jsonl (default: next to state.json)
//   node scripts/control.mjs pull <all|RCSS:20261010>     cancel quotes now and pause re-quoting
//   node scripts/control.mjs resume <RCSS:20261010>
//   node scripts/control.mjs roll <RCSS> <2026-10-10>     queue a roll (idempotent)
//   node scripts/control.mjs reset-shadow
//   node scripts/control.mjs test-alert         raise one "TEST ALERT <seq>" on the next tick: it lands in `alerts` and,
//                                              if the ALERT_WEBHOOK_URL secret is set, on that push channel
// A new control document is refused while the previous one has not been applied yet (--force replaces it).
// Set XDG_CONFIG_HOME to your wrangler config dir if you use several Cloudflare logins.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';
import { kvNamespaceId } from './deploy.mjs';
import { prepareImport } from './import-budget.mjs';
import { compare, macTxs } from './shadow-compare.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, a1, a2] = process.argv.slice(2).filter((a) => a !== '--force');
const ns = kvNamespaceId();
const wr = (args, input) => {
  const r = spawnSync('npx', ['wrangler', 'kv', 'key', ...args, '--namespace-id', ns], { cwd: here, encoding: 'utf8', input });
  if (r.status !== 0) {
    console.error((r.stderr || r.stdout).split('\n').filter((l) => !/out-of-date|update available|npm install --save-dev wrangler|After installation|Please update/.test(l)).join('\n').replace(/[0-9a-f]{32}/g, '<id>'));
    process.exit(r.status ?? 1);
  }
  return r.stdout;
};
const get = (key) => {
  const out = wr(['get', key]);
  try {
    return JSON.parse(out);
  } catch {
    return out.trim();
  }
};
const tryGet = (key) => {
  const r = spawnSync('npx', ['wrangler', 'kv', 'key', 'get', key, '--namespace-id', ns], { cwd: here, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};
const putDoc = (doc) => {
  // The Durable Object applies only the LATEST document (KV key `control`). Writing a new one before the previous
  // one was applied would silently drop it (e.g. an import-state followed too quickly by arm): refuse unless --force.
  const prev = tryGet('control');
  const done = tryGet('control:result');
  if (prev?.seq && done?.seq !== prev.seq && !process.argv.includes('--force')) {
    console.error(`refusing: the previous control document (seq ${prev.seq}: ${JSON.stringify(prev).slice(0, 160)}) has not been applied yet (last applied: ${done?.seq ?? 'none'}). Wait for \`node scripts/control.mjs result\` (<= 2 min) or pass --force to replace it.`);
    process.exit(3);
  }
  const full = { seq: Date.now(), ...doc };
  wr(['put', 'control', JSON.stringify(full)]);
  console.log(`control document written (seq ${full.seq}); the Durable Object applies it on its next tick (<= 1 min). Check: node scripts/control.mjs result`);
};
const makerAddress = () => {
  const f = join(homedir(), '.config/isotherm/maker.key');
  if (!existsSync(f)) throw new Error('~/.config/isotherm/maker.key not found');
  const raw = readFileSync(f, 'utf8').trim();
  return privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`).address;
};

switch (cmd) {
  case 'status':
  case 'summary':
  case 'alerts':
    console.log(JSON.stringify(get(cmd === 'summary' ? 'shadow:summary' : cmd), null, 1));
    break;
  case 'tick':
    console.log(JSON.stringify(get('tick:last'), null, 1));
    break;
  case 'ticks': {
    const lines = get('ticks:recent');
    const n = Math.max(1, Math.min(90, Number(a1 ?? 15)));
    for (const t of (Array.isArray(lines) ? lines : []).slice(-n)) {
      console.log(`${t.at} ${t.mode} ${t.ms}ms block ${t.block}${t.errors.length ? ` ERRORS ${t.errors.join(' | ')}` : ''}${t.alerts.length ? ` ALERTS ${t.alerts.join(' | ')}` : ''}`);
      for (const x of [...t.kill.map((k) => `kill ${k}`), ...t.rolls.map((r) => `roll ${r}`), ...t.intents.map((i) => `would send: ${i}`), ...t.txs.map((i) => `sent: ${i}`), ...(t.treasury ?? []).map((i) => `treasury: ${i}`)]) console.log(`    ${x}`);
      for (const s of t.strikes)
        console.log(`    ${s.key} >=${s.k} fair ${s.fair ?? '-'} guard ${s.guard ?? '-'}${s.flags.length ? ` [${s.flags.join(',')}]` : ''} ${s.action ?? '-'} want ${s.desired} rest ${s.resting}${s.action && s.action !== 'none' ? ` (${s.reasons})` : ''}${s.mac ? ` | live maker: ${typeof s.mac === 'string' ? s.mac : `fair ${s.mac.fair} guard ${s.mac.guard} quote ${s.mac.quote} ${s.mac.mode ?? '-'}`}` : ''}`);
    }
    break;
  }
  case 'compare': {
    // shadow vs the live Mac maker over the last <= 90 ticks (the cutover review, docs/OPERATIONS.md section 8.2)
    const log = a1 ? resolve(a1) : join(homedir(), 'isotherm-live/packages/maker/var/maker.log');
    const r = compare(get('ticks:recent'), existsSync(log) ? macTxs(readFileSync(log, 'utf8')) : []);
    if (!existsSync(log)) console.log(`(no ${log}: live-maker txs not checked)`);
    console.log(`shadow ticks ${r.ticks} (${r.from} .. ${r.to}); strike decisions ${r.pairs}: agreement ${r.agreementPct}%, agreement or timing ${r.explainedPct}%`);
    console.log(`  ${JSON.stringify(r.verdicts)}`);
    console.log(`live-maker txs in the window ${r.macTxs}: ${JSON.stringify(r.macVerdicts)}`);
    for (const i of r.items) console.log(`  ${i.at} ${i.key ?? ''} >=${i.k} ${i.verdict} | shadow: ${i.shadow ?? '-'} | live: ${i.live}`);
    break;
  }
  case 'cron':
    console.log(JSON.stringify(get('cron:last'), null, 1));
    break;
  case 'treasury': {
    const st = get('status');
    const t = st?.treasury ?? {};
    const cfg = JSON.parse(readFileSync(join(here, 'config/worker.json'), 'utf8')).treasury ?? { roles: {} };
    console.log(`treasury ${t.address ?? cfg.address}: ${t.mon ?? '?'} MON (floor ${cfg.floorMon}, alert below ${cfg.lowAlertMon}); key: ${t.key ?? '?'}; last pass ${t.at ?? 'none'} (${t.mode ?? '-'})`);
    for (const [role, r] of Object.entries(cfg.roles)) {
      const bal = t.balances?.[role];
      const sent = t.today?.sent?.[role] ?? 0;
      console.log(`  ${role.padEnd(9)} ${String(bal ?? '?').padStart(10)} MON  min ${r.minMon} target ${r.targetMon}  topped up today ${sent} of ${r.dailyCapMon}${bal !== undefined && bal < r.minMon ? '  BELOW MIN' : ''}`);
    }
    console.log(`  all roles today: ${t.today?.total ?? 0} of ${cfg.globalDailyCapMon} MON (${t.today?.day ?? '-'})`);
    for (const a of t.actions ?? []) console.log(`  last pass: ${a.role} ${a.balanceMon} MON -> ${a.amountMon} MON: ${a.outcome}${a.hash ? ` ${a.hash}` : ''}`);
    break;
  }
  case 'result':
    console.log(JSON.stringify({ applied: get('control:result'), document: get('control') }, null, 1));
    break;
  case 'arm':
    putDoc({ live: true, confirm: makerAddress(), note: 'arm (scripts/control.mjs)' });
    break;
  case 'disarm':
    putDoc({ live: false, note: 'disarm (scripts/control.mjs)' });
    break;
  case 'import-state': {
    if (!a1) throw new Error('usage: import-state <state.json> [txs.jsonl]');
    const p = resolve(a1);
    const state = JSON.parse(readFileSync(p, 'utf8')); // must be JSON
    const tx = a2 ? resolve(a2) : join(dirname(p), 'txs.jsonl');
    const { state: out, notes } = prepareImport(state, existsSync(tx) ? readFileSync(tx, 'utf8') : null);
    for (const n of notes) console.log(n);
    console.log(`ladders: ${Object.values(out.ladders ?? {}).map((l) => `${l.key} ${l.status}`).join(', ') || 'none'}`);
    const dir = mkdtempSync(join(tmpdir(), 'isotherm-import-'));
    const f = join(dir, 'state.json');
    // a fresh key per import: KV is eventually consistent, and a re-used key could serve an older import for ~60 s
    const key = `import:state:${Date.now()}`;
    try {
      writeFileSync(f, JSON.stringify(out), { mode: 0o600 });
      wr(['put', key, '--path', f]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    putDoc({ importState: key });
    break;
  }
  case 'pull':
    putDoc({ pull: a1 || 'all' });
    break;
  case 'resume':
    if (!a1) throw new Error('usage: resume <ladder key>');
    putDoc({ resume: a1 });
    break;
  case 'roll':
    if (!a1 || !/^\d{4}-\d{2}-\d{2}$/.test(a2 ?? '')) throw new Error('usage: roll <ICAO> <YYYY-MM-DD>');
    putDoc({ roll: [{ station: a1.toUpperCase(), date: a2 }] });
    break;
  case 'reset-shadow':
    putDoc({ resetShadow: true });
    break;
  case 'test-alert':
    putDoc({ testAlert: true, note: 'test alert (scripts/control.mjs)' });
    break;
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 23).join('\n'));
}
