// Recorder used for this comparison: polls the Worker's KV outbox (tick:last every 12 s; status + shadow:summary every
// 5 min) with wrangler, and the Mac maker's var/snapshot.json. Usage (from apps/maker-worker, XDG_CONFIG_HOME set to the
// wrangler login of the account): node recorder.mjs <out-dir> <minutes>
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
const W = process.env.MAKER_WORKER_DIR ?? process.cwd(); // apps/maker-worker
const OUT = process.argv[2];
const ns = readFileSync(homedir() + '/.config/isotherm/maker-kv-namespace-id', 'utf8').trim();
const MAC = homedir() + '/isotherm-live/packages/maker/var/snapshot.json';
let lastW = null, lastM = null, lastStatus = 0;
const kvget = (key) => {
  const r = spawnSync(W + '/node_modules/.bin/wrangler', ['kv', 'key', 'get', key, '--namespace-id', ns], { cwd: W, encoding: 'utf8', timeout: 30000, env: { ...process.env } });
  if (r.status !== 0) return { err: (r.stderr || '').slice(0, 200).replace(/[0-9a-f]{32}/g, '<id>') };
  try { return { v: JSON.parse(r.stdout) }; } catch { return { err: 'parse' }; }
};
const end = Date.now() + Number(process.argv[3] ?? 90) * 60000;
while (Date.now() < end) {
  const t0 = Date.now();
  const w = kvget('tick:last');
  if (w.v && w.v.at !== lastW) { lastW = w.v.at; appendFileSync(OUT + '/worker-ticks.jsonl', JSON.stringify({ seenAt: new Date().toISOString(), ...w.v }) + '\n'); }
  else if (w.err) appendFileSync(OUT + '/recorder-errors.log', `${new Date().toISOString()} ${w.err}\n`);
  try {
    const s = JSON.parse(readFileSync(MAC, 'utf8'));
    if (s.generatedAt !== lastM) {
      lastM = s.generatedAt;
      delete s.deployment; delete s.honesty;
      for (const l of s.ladders) { if (l.polymarket) delete l.polymarket.buckets; }
      s.ladders = s.ladders.filter((l) => l.status !== 'closed');
      appendFileSync(OUT + '/mac-snaps.jsonl', JSON.stringify({ seenAt: new Date().toISOString(), ...s }) + '\n');
    }
  } catch (e) { appendFileSync(OUT + '/recorder-errors.log', `${new Date().toISOString()} mac ${String(e).slice(0, 100)}\n`); }
  if (Date.now() - lastStatus > 300000) {
    const st = kvget('status');
    if (st.v) appendFileSync(OUT + '/worker-status.jsonl', JSON.stringify({ seenAt: new Date().toISOString(), ...st.v }) + '\n');
    const sm = kvget('shadow:summary');
    if (sm.v) appendFileSync(OUT + '/worker-summary.jsonl', JSON.stringify({ seenAt: new Date().toISOString(), ...sm.v }) + '\n');
    lastStatus = Date.now();
  }
  const wait = 12000 - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
