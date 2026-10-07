// Build-time copy of the single source of truth for addresses (deployments/testnet.json, written by the
// contracts workstream) and the contract ABIs (packages/abi/*.json) into src/generated/.
// If the v1 deployment does not exist yet, the feasibility deployment (live testnet, 2026-10-06) is used and the
// file is marked `source: "feasibility-fallback"` so the UI and API can say so.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const repo = join(pkg, '..', '..');
const out = join(pkg, 'src', 'generated');
mkdirSync(out, { recursive: true });

const FALLBACK = {
  source: 'feasibility-fallback',
  chainId: 10143,
  note: 'Feasibility deployment used by the 56/56 live e2e run on 2026-10-06 (spikes/e2e/logs/live-2026-10-06T15-04-29).',
  contracts: {
    resolver: '0x1c7a8a5df93f7f33c778c2163d8887e9249475f1',
    vault: '0xc83fe722eb5bd29a0355c090f14ccb0605153713',
    zap: '0x1b1d91ebd1590c7814aedcae66ac6ded492c792e',
  },
  external: {
    ausd: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
    ausdFaucet: '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C',
    kuruRouter: '0x7EFbE105Ca7415dE98F96622173458ac1c054630',
    kuruMarginAccount: '0xd029C2D98ff85D8F64799017fE00a59B1159CE02',
    mockForwarder: '0xB9F79d863261869B234c481D1f9A7af84AeAd192',
    keystoneForwarder: '0xF8344CFd5c43616a4366C34E3EEE75af79a74482',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  },
  roles: {
    deployer: '0xb855f2bCA7C12Db2aA9D70740c6cF40808325c11',
    maker: '0xd572638F07829D1c3636400FB73CF34Ca6c7448a',
    taker1: '0x636D0598E416e5f66acD0F6Ac2Ae96306529b4d5',
    taker2: '0x029049a9dA77231dd86A90E52Fd6Db542424e727',
  },
  deployBlock: 68716118,
};

const src = join(repo, 'deployments', 'testnet.json');
let data = FALLBACK;
if (existsSync(src)) {
  try {
    data = { source: 'deployments/testnet.json', ...JSON.parse(readFileSync(src, 'utf8')) };
  } catch (e) {
    console.warn(`[copy-deployments] ${src} is not valid JSON (${e.message}); using the feasibility fallback`);
  }
}
writeFileSync(join(out, 'deployments.json'), JSON.stringify(data, null, 2) + '\n');

// ABIs: copy whatever the contracts workstream exported (forge `out/<File>.sol/<Name>.json` or a bare ABI array).
const abiDir = join(repo, 'packages', 'abi');
const bundle = {};
if (existsSync(abiDir)) {
  for (const f of readdirSync(abiDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(abiDir, f), 'utf8'));
      const abi = Array.isArray(j) ? j : Array.isArray(j.abi) ? j.abi : null;
      const isAbi = abi && abi.length > 0 && abi.every((x) => x && typeof x === 'object' && typeof x.type === 'string');
      if (isAbi) bundle[f.replace(/\.json$/, '')] = abi;
    } catch {
      /* ignore unreadable ABI */
    }
  }
}
const copied = Object.keys(bundle);
writeFileSync(join(out, 'abi-bundle.json'), JSON.stringify(bundle) + '\n');
console.log(`[copy-deployments] deployments: ${data.source}; ABIs: ${copied.length ? copied.join(', ') : 'none (built-in fragments)'}`);
