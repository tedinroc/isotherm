// Sets the maker Worker's secrets from the local key files, piping each value to `wrangler secret put` on stdin:
// nothing is printed, nothing is written to disk, nothing goes on a command line (`ps` never sees a key).
//   MAKER_KEY      <- ~/.config/isotherm/maker.key        (quotes, roll inventory, kill switch)
//   OPERATOR_KEY   <- ~/.config/isotherm/operator.key     (createLadder, Kuru markets, canonical registry)
//   GUARDIAN_KEY   <- ~/.config/isotherm/guardian.key     (challenge(); used only in live mode)
//   SNAPSHOT_TOKEN <- ~/.config/isotherm/api-snapshot.token (the API Worker's SNAPSHOT_TOKEN, for POST /api/snapshot)
// Usage: node scripts/put-secrets.mjs [--only NAME[,NAME]] [--dry]   (--dry validates the files, uploads nothing)
// The Worker must exist (run scripts/deploy.mjs first) so that `secret put` never creates a bare Worker.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { withTempConfig } from './deploy.mjs';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(homedir(), '.config/isotherm');
const SECRETS = [
  { name: 'MAKER_KEY', file: 'maker.key', kind: 'key' },
  { name: 'OPERATOR_KEY', file: 'operator.key', kind: 'key' },
  { name: 'GUARDIAN_KEY', file: 'guardian.key', kind: 'key' },
  { name: 'SNAPSHOT_TOKEN', file: 'api-snapshot.token', kind: 'token' },
];
const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(argv[onlyIdx + 1].split(',')) : null;

const values = [];
for (const s of SECRETS) {
  if (only && !only.has(s.name)) continue;
  const f = join(dir, s.file);
  if (!existsSync(f)) {
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
withTempConfig((tmp) => {
  for (const { name, value } of values) {
    const r = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--config', tmp], { cwd: here, input: value, stdio: ['pipe', 'inherit', 'inherit'] });
    if (r.status !== 0) {
      console.error(`${name}: wrangler secret put failed (exit ${r.status})`);
      process.exit(r.status ?? 1);
    }
  }
});
