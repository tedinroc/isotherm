// Offline probe: does Dynamic's server-wallet SDK load on this machine (native MPC addon),
// and does the installed version export what Isotherm's relayer/auto-roll needs?
// Makes NO network calls to Dynamic.
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const t0 = performance.now();
const sdk = await import('@dynamic-labs-wallet/node-evm');
const loadMs = Math.round(performance.now() - t0);
const pkg = require('@dynamic-labs-wallet/node-evm/package.json');

const need = [
  'DynamicEvmWalletClient',
  'createDelegatedEvmWalletClient',
  'delegatedSignTypedData',
  'delegatedSignTransaction',
  'delegatedSignMessage',
  'revokeDelegation',
];
const have = Object.fromEntries(need.map((n) => [n, typeof (sdk as Record<string, unknown>)[n]]));

// The MPC executor is a native .node addon shipped per-platform.
const nodePkgDir = dirname(require.resolve('@dynamic-labs-wallet/node/package.json'));
const addonName = `libmpc_executor_${platform() === 'darwin' ? 'macos' : platform()}_${arch() === 'arm64' ? 'arm64' : 'x86_64'}_nodejs.node`;
let addon = 'not loaded';
try {
  const m = require(join(nodePkgDir, 'internal/node/native', addonName));
  addon = `loaded (${Object.keys(m).length} exports)`;
} catch (e) {
  addon = `FAILED: ${(e as Error).message.split('\n')[0]}`;
}

const client = new sdk.DynamicEvmWalletClient({ environmentId: '00000000-0000-0000-0000-000000000000', enableMPCAccelerator: false });
const methods = ['authenticateApiToken', 'createWalletAccount', 'getWalletClient', 'signTypedData', 'signTransaction', 'getAvailableEvmGaslessRelayer']
  .map((m) => `${m}:${typeof (client as unknown as Record<string, unknown>)[m]}`);

console.log(JSON.stringify({ node: process.version, platform: platform(), arch: arch(), version: pkg.version, loadMs, exports: have, nativeAddon: `${addonName} ${addon}`, clientMethods: methods }, null, 2));
