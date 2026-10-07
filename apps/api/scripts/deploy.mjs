// Deploys the Worker with the real KV namespace id, which is account-specific and therefore not committed.
// wrangler.toml carries the placeholder "<KV_NAMESPACE_ID>"; this script writes a temporary copy next to it with
// the id from $ISO_KV_NAMESPACE_ID or ~/.config/isotherm/kv-namespace-id, runs `wrangler deploy --config` on it,
// and removes the copy. Extra arguments are passed through to wrangler.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const idFile = join(homedir(), '.config/isotherm/kv-namespace-id');
const id = (process.env.ISO_KV_NAMESPACE_ID || (existsSync(idFile) ? readFileSync(idFile, 'utf8') : '')).trim();
if (!/^[0-9a-f]{32}$/.test(id)) {
  console.error('Set ISO_KV_NAMESPACE_ID or write the id to ~/.config/isotherm/kv-namespace-id (32 hex chars).');
  process.exit(2);
}
const src = readFileSync(join(here, 'wrangler.toml'), 'utf8');
if (!src.includes('"<KV_NAMESPACE_ID>"')) {
  console.error('wrangler.toml no longer contains the "<KV_NAMESPACE_ID>" placeholder; refusing to guess.');
  process.exit(2);
}
const tmp = join(here, '.wrangler.deploy.toml');
writeFileSync(tmp, src.replace('"<KV_NAMESPACE_ID>"', JSON.stringify(id)), { mode: 0o600 });
try {
  const r = spawnSync('npx', ['wrangler', 'deploy', '--config', tmp, ...process.argv.slice(2)], { cwd: here, stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(tmp, { force: true });
}
