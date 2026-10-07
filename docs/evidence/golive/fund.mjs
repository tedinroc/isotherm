// Go-live funding: deployer -> role keys, one value transfer at a time, >=4 blocks apart (Monad reserve-balance
// "emptying transaction" rule for accounts under 10 MON). Keys are read from ~/.config/isotherm and never printed.
// Usage: node fund.mjs operator=0.75 maker=1.65 relayer=0.9 guardian=0.05   (add --dry to only print the plan)
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from '../../../packages/maker/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../../../packages/maker/node_modules/viem/_esm/accounts/index.js';
import { readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC = 'https://testnet-rpc.monad.xyz';
const chain = { id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const key = (r) => { const k = readFileSync(join(homedir(), '.config/isotherm', `${r}.key`), 'utf8').trim(); return k.startsWith('0x') ? k : `0x${k}`; };
const pub = createPublicClient({ chain, transport: http(RPC) });
const deployer = privateKeyToAccount(key('deployer'));
const wal = createWalletClient({ chain, account: deployer, transport: http(RPC) });
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fund-log.tsv');
const dry = process.argv.includes('--dry');
const plan = process.argv.slice(2).filter((a) => a.includes('=')).map((a) => { const [r, v] = a.split('='); return { role: r, to: privateKeyToAccount(key(r)).address, value: parseEther(v) }; });
if ((await pub.getChainId()) !== 10143) throw new Error('not Monad testnet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastBlock = 0n;
for (const p of plan) {
  const before = await pub.getBalance({ address: p.to });
  const depBal = await pub.getBalance({ address: deployer.address });
  console.log(`${p.role} ${p.to}: has ${formatEther(before)} MON, send ${formatEther(p.value)} (deployer ${formatEther(depBal)})`);
  if (dry) continue;
  while (lastBlock && (await pub.getBlockNumber()) < lastBlock + 5n) await sleep(700);
  const gasPrice = await pub.getGasPrice();
  const hash = await wal.sendTransaction({ to: p.to, value: p.value, gas: 21000n, gasPrice });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  lastBlock = rc.blockNumber;
  await sleep(1500);
  const after = await pub.getBalance({ address: p.to });
  const line = [new Date().toISOString(), p.role, p.to, formatEther(p.value), hash, rc.blockNumber, rc.status, formatEther(before), formatEther(after)].join('\t');
  appendFileSync(OUT, line + '\n');
  console.log(`  ${rc.status} block ${rc.blockNumber} tx ${hash}; ${p.role} now ${formatEther(after)}`);
  if (rc.status !== 'success' || after - before !== p.value) throw new Error(`transfer to ${p.role} did not land as expected`);
}
console.log(`deployer now ${formatEther(await pub.getBalance({ address: deployer.address }))} MON`);
