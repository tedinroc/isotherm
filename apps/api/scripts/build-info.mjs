// Writes src/generated/build.json, which /api/health and /api report as `version` (with the Cloudflare version id and
// upload time from the version_metadata binding), so anyone can tell exactly which build is live.
//
//   build = <git short commit>[-dirty].<sha256 of the deployed inputs, 12 hex>
//
// The content hash covers every file that goes into the bundle or its config: src/** (including the generated
// deployments + ABI copies, excluding this output), wrangler.toml, package.json and package-lock.json. A working tree
// with uncommitted changes to those inputs is marked "-dirty"; the hash still identifies the exact build.
// Runs as part of `npm run prepare-data` (so before test, dev and deploy). No network access.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(pkgDir, 'src', 'generated', 'build.json');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue; // .DS_Store and the like are not part of the bundle
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const inputs = [...walk(join(pkgDir, 'src')).filter((p) => p !== outFile), ...['wrangler.toml', 'package.json', 'package-lock.json'].map((f) => join(pkgDir, f))]
  .map((p) => relative(pkgDir, p).split(sep).join('/'))
  .sort();
const h = createHash('sha256');
for (const rel of inputs) {
  h.update(rel);
  h.update('\0');
  h.update(readFileSync(join(pkgDir, rel)));
  h.update('\0');
}
const sourceHash = h.digest('hex').slice(0, 12);

const git = (...args) => execFileSync('git', args, { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let commit = null;
let dirty = null;
try {
  commit = git('rev-parse', '--short=7', 'HEAD');
  // only the inputs above (src/generated is gitignored) and the two sources copied into src/generated
  dirty = git('status', '--porcelain', '--', 'src', 'wrangler.toml', 'package.json', 'package-lock.json', '../../deployments', '../../packages/abi') !== '';
} catch {
  /* not a git checkout: the content hash alone identifies the build */
}

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const info = {
  app: pkg.version,
  build: `${commit ?? 'nogit'}${dirty ? '-dirty' : ''}.${sourceHash}`,
  commit,
  dirty,
  sourceHash,
  builtAt: new Date().toISOString(),
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(info, null, 2) + '\n');
console.log(`[build-info] ${info.app} build ${info.build} (${inputs.length} files)`);
