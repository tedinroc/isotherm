// Deploys the maker Worker with the real control-KV namespace id, which is account-specific and therefore not
// committed (same pattern as apps/api/scripts/deploy.mjs). wrangler.toml carries the placeholder
// "<MAKER_KV_NAMESPACE_ID>"; this script writes a temporary copy next to it with the id from
// $ISO_MAKER_KV_NAMESPACE_ID or ~/.config/isotherm/maker-kv-namespace-id, runs `wrangler deploy --config` on it, and
// removes the copy. Extra arguments are passed through to wrangler.
//
// Identity + safety guards (refuses to deploy otherwise):
//   - no public hostname: workers_dev = false, preview_urls = false, no route(s);
//   - MAKER_MODE stays "shadow" in wrangler.toml unless --live is given (the cutover, docs/OPERATIONS.md section 8);
//     live ALSO needs the Durable Object flag (scripts/control.mjs arm), so a deploy alone never starts trading.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const live = args.includes('--live');
const passthrough = args.filter((a) => a !== '--live');

export function kvNamespaceId() {
  const idFile = join(homedir(), '.config/isotherm/maker-kv-namespace-id');
  const id = (process.env.ISO_MAKER_KV_NAMESPACE_ID || (existsSync(idFile) ? readFileSync(idFile, 'utf8') : '')).trim();
  if (!/^[0-9a-f]{32}$/.test(id)) {
    console.error('Set ISO_MAKER_KV_NAMESPACE_ID or write the id to ~/.config/isotherm/maker-kv-namespace-id (32 hex chars).');
    console.error('Create the namespace once with: npx wrangler kv namespace create MAKER_KV');
    process.exit(2);
  }
  return id;
}

/** The checks every publish path applies to wrangler.toml (also used by put-secrets.mjs). Returns the toml text. */
export function checkedToml({ allowLive = false } = {}) {
  const src = readFileSync(join(here, 'wrangler.toml'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const fail = (m) => {
    console.error(`refusing: ${m}`);
    process.exit(2);
  };
  if (!/^workers_dev\s*=\s*false\s*$/m.test(code)) fail('wrangler.toml must keep workers_dev = false (no public hostname)');
  if (!/^preview_urls\s*=\s*false\s*$/m.test(code)) fail('wrangler.toml must keep preview_urls = false (no public hostname)');
  if (/^\s*routes?\s*=|^\s*\[\[routes\]\]|^\s*\[route\]/m.test(code)) fail('wrangler.toml must not declare routes (no public hostname)');
  if (!code.includes('"<MAKER_KV_NAMESPACE_ID>"')) fail('wrangler.toml no longer contains the "<MAKER_KV_NAMESPACE_ID>" placeholder; refusing to guess');
  const mode = (code.match(/^MAKER_MODE\s*=\s*"([^"]*)"/m) || [])[1];
  if (mode !== 'shadow' && !(allowLive && mode === 'live')) fail(`MAKER_MODE is "${mode}" in wrangler.toml; it must be "shadow" (pass --live for the cutover)`);
  if (passthrough.some((a) => /MAKER_MODE/.test(a)) && !allowLive) fail('MAKER_MODE overrides on the command line need --live');
  return src;
}

export function withTempConfig(fn, opts = {}) {
  const src = checkedToml(opts);
  const tmp = join(here, '.wrangler.deploy.toml');
  writeFileSync(tmp, src.replace('"<MAKER_KV_NAMESPACE_ID>"', JSON.stringify(kvNamespaceId())), { mode: 0o600 });
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  withTempConfig(
    (tmp) => {
      console.log(`deploying isotherm-maker (${live ? 'MAKER_MODE as in wrangler.toml, --live given' : 'MAKER_MODE=shadow'}; no public hostname)`);
      const r = spawnSync('npx', ['wrangler', 'deploy', '--config', tmp, ...passthrough], { cwd: here, stdio: 'inherit' });
      process.exitCode = r.status ?? 1;
    },
    { allowLive: live },
  );
}
