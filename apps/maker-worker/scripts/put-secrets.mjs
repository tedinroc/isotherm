// Sets the maker Worker's secrets from the local key files, piping each value to `wrangler secret put` on stdin:
// nothing is printed, nothing is written to disk, nothing goes on a command line (`ps` never sees a key).
//   MAKER_KEY      <- ~/.config/isotherm/maker.key        (quotes, roll inventory, kill switch)
//   OPERATOR_KEY   <- ~/.config/isotherm/operator.key     (createLadder, Kuru markets, canonical registry)
//   GUARDIAN_KEY   <- ~/.config/isotherm/guardian.key     (challenge(); used only in live mode)
//   SNAPSHOT_TOKEN <- ~/.config/isotherm/api-snapshot.token (the API Worker's SNAPSHOT_TOKEN, for POST /api/snapshot)
//   ALERT_WEBHOOK_URL <- ~/.config/isotherm/alert-webhook.url (OPTIONAL push channel for alerts: an ntfy topic URL
//                     https://ntfy.sh/<topic>, a Telegram bot URL https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>,
//                     or any https JSON webhook; skipped when the file is absent, unless named with --only)
//   ALERT_WEBHOOK_TOKEN <- ~/.config/isotherm/alert-webhook.token (OPTIONAL: an ntfy access token tk_..., sent as
//                     `Authorization: Bearer`; skipped when absent)
//   TREASURY_KEY   <- ~/.config/isotherm/treasury.key     (OPTIONAL: the dedicated treasury key that tops up the role keys
//                     in live mode; its address must be config/worker.json treasury.address, and it is refused if it
//                     is the deployer's or any other role's key; skipped when absent)
// Usage: node scripts/put-secrets.mjs [--only NAME[,NAME]] [--dry] [--live]
//   --dry   validates the files, uploads nothing
//   --live  required once wrangler.toml has MAKER_MODE = "live" (after the cutover). `wrangler secret put` changes
//           only that secret; the vars stay those of the deployed version.
// The Worker must exist (run scripts/deploy.mjs first) so that `secret put` never creates a bare Worker.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';
import { withTempConfig } from './deploy.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(homedir(), '.config/isotherm');
const SECRETS = [
  { name: 'MAKER_KEY', file: 'maker.key', kind: 'key' },
  { name: 'OPERATOR_KEY', file: 'operator.key', kind: 'key' },
  { name: 'GUARDIAN_KEY', file: 'guardian.key', kind: 'key' },
  { name: 'SNAPSHOT_TOKEN', file: 'api-snapshot.token', kind: 'token' },
  { name: 'ALERT_WEBHOOK_URL', file: 'alert-webhook.url', kind: 'url', optional: true },
  { name: 'ALERT_WEBHOOK_TOKEN', file: 'alert-webhook.token', kind: 'bearer', optional: true },
  { name: 'TREASURY_KEY', file: 'treasury.key', kind: 'key', optional: true, check: checkTreasury },
];

/** The treasury key: the configured treasury address, and never the deployer's or another role's key. */
function checkTreasury(v) {
  const addr = privateKeyToAccount(v).address;
  const cfg = JSON.parse(readFileSync(join(here, 'config/worker.json'), 'utf8')).treasury ?? {};
  if (!cfg.address || cfg.address.toLowerCase() !== addr.toLowerCase()) return `its address ${addr} is not config/worker.json treasury.address ${cfg.address ?? '(unset)'}`;
  for (const other of ['deployer', 'maker', 'operator', 'guardian', 'attester', 'relayer']) {
    const f = join(dir, `${other}.key`);
    if (!existsSync(f)) continue;
    const raw = readFileSync(f, 'utf8').trim();
    try {
      if (privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`).address.toLowerCase() === addr.toLowerCase()) return `it is the same key as ${other}.key`;
    } catch {}
  }
  for (const [role, r] of Object.entries(cfg.roles ?? {})) if (String(r.address).toLowerCase() === addr.toLowerCase()) return `its address is the funded role ${role}`;
  return null;
}
const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const live = argv.includes('--live');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(argv[onlyIdx + 1].split(',')) : null;

const values = [];
for (const s of SECRETS) {
  if (only && !only.has(s.name)) continue;
  const f = join(dir, s.file);
  if (!existsSync(f)) {
    if (s.optional && !only) {
      console.log(`${s.name}: optional, ~/.config/isotherm/${s.file} not found: skipped`);
      continue;
    }
    console.error(`${s.name}: ~/.config/isotherm/${s.file} not found`);
    process.exit(2);
  }
  let v = readFileSync(f, 'utf8').trim();
  if (s.kind === 'key') {
    if (!v.startsWith('0x')) v = `0x${v}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
      console.error(`${s.name}: ~/.config/isotherm/${s.file} is not a 32-byte hex key`); // the value is never echoed
      process.exit(2);
    }
    const bad = s.check?.(v);
    if (bad) {
      console.error(`${s.name}: refused: ${bad}`);
      process.exit(2);
    }
  } else if (s.kind === 'bearer') {
    if (v.length > 512 || !/^[\x21-\x7e]+$/.test(v)) {
      console.error(`${s.name}: ~/.config/isotherm/${s.file} is not a single printable token`);
      process.exit(2);
    }
  } else if (s.kind === 'url') {
    // https only, one URL, no credentials in the authority part (the Worker re-validates it and ignores a bad one)
    let u = null;
    try {
      u = new URL(v);
    } catch {}
    if (!u || u.protocol !== 'https:' || /\s/.test(v) || u.username || u.password || v.length > 2048) {
      console.error(`${s.name}: ~/.config/isotherm/${s.file} is not a single https:// URL`); // the value is never echoed
      process.exit(2);
    }
  } else if (v.length < 16) {
    console.error(`${s.name}: ~/.config/isotherm/${s.file} looks too short`);
    process.exit(2);
  }
  values.push({ name: s.name, value: v });
}
if (dry) {
  console.log(`ok: ${values.map((x) => x.name).join(', ')} readable and well-formed (not uploaded)`);
  process.exit(0);
}
withTempConfig(
  (tmp) => {
    for (const { name, value } of values) {
      const r = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--config', tmp], { cwd: here, input: value, stdio: ['pipe', 'inherit', 'inherit'] });
      if (r.status !== 0) {
        console.error(`${name}: wrangler secret put failed (exit ${r.status})`);
        process.exit(r.status ?? 1);
      }
    }
  },
  { allowLive: live },
);
