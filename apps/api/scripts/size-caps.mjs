#!/usr/bin/env node
// Sizes the drip / relay budget vars in wrangler.toml to what the relayer can actually pay. Read-only: one
// eth_getBalance and one eth_gasPrice against the public RPC; it never signs or sends anything.
//
//   node scripts/size-caps.mjs                       # relayer address from the live /api/health
//   node scripts/size-caps.mjs --address 0x... [--reserve 0.1] [--drip-share 0.65] [--relay-gas 335000]
//
// Formula (all MON; Monad bills gas LIMIT x price, so limits are used, not gas used):
//   spendable        = balance - RELAYER_MIN_MON                          (the reserve is never spent on users)
//   dripCost         = DRIP_MON + (21,000 + 78,752 gas) x gasPrice          (MON leg + AUSD-transfer leg, live limits)
//   relayCost        = 335,000 gas x gasPrice      (fork, first-time holder: estimate 309,470 x 1.08 = 334,228 limit)
//   DRIP_DAILY_CAP   = floor(spendable x dripShare / dripCost)
//   RELAY_DAILY_CAP  = floor((spendable - DRIP_DAILY_CAP x dripCost) / relayCost)
//   DRIP_PER_IP_PER_DAY = max(1, floor(DRIP_DAILY_CAP / 2))                (one network gets at most half a day)
//   RELAY_PER_IP_PER_DAY = RELAY_PER_ADDRESS_PER_DAY = max(1, floor(RELAY_DAILY_CAP / 2))
// so the worst case for a whole UTC day, DRIP_DAILY_CAP x dripCost + RELAY_DAILY_CAP x relayCost, fits in spendable.
// Re-run after funding the relayer, paste the printed vars into wrangler.toml and redeploy.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const RPC = args.rpc ?? 'https://testnet-rpc.monad.xyz';
const API = args.api ?? '<former API host>';
const reserve = Number(args.reserve ?? 0.1);
const dripMon = Number(args['drip-mon'] ?? 0.15);
const dripShare = Number(args['drip-share'] ?? 0.65);
const dripGasUnits = 21_000 + 78_752;
const relayGasUnits = Number(args['relay-gas'] ?? 335_000);

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

let address = args.address;
if (!address) address = (await (await fetch(`${API}/api/health`)).json()).relayer;
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) throw new Error('no relayer address (pass --address)');

const [balHex, gpHex, head] = await Promise.all([rpc('eth_getBalance', [address, 'latest']), rpc('eth_gasPrice', []), rpc('eth_blockNumber', [])]);
const balance = Number(BigInt(balHex)) / 1e18;
const gasPrice = Number(BigInt(gpHex)) / 1e18; // MON per gas
const spendable = Math.max(0, balance - reserve);
const dripGas = dripGasUnits * gasPrice;
const dripCost = dripMon + dripGas;
const relayCost = relayGasUnits * gasPrice;
const dripCap = Math.floor((spendable * dripShare) / dripCost);
const relayCap = Math.floor((spendable - dripCap * dripCost) / relayCost);
const dripPerIp = Math.max(1, Math.floor(dripCap / 2));
const relayPerIp = Math.max(1, Math.floor(relayCap / 2));
const worst = dripCap * dripCost + relayCap * relayCost;
const f = (x, d = 6) => x.toFixed(d);
const ceil3 = (x) => (Math.ceil(x * 1000) / 1000).toFixed(3);

console.log(`relayer ${address} at block ${BigInt(head)} (${new Date().toISOString()})`);
console.log(`balance ${f(balance, 9)} MON, gas price ${f(gasPrice * 1e9, 1)} gwei, reserve ${reserve} -> spendable ${f(spendable)} MON`);
console.log(`dripCost  = ${dripMon} + ${dripGasUnits} gas x price = ${f(dripCost)} MON`);
console.log(`relayCost = ${relayGasUnits} gas x price = ${f(relayCost)} MON`);
console.log(`DRIP_DAILY_CAP  = floor(${f(spendable)} x ${dripShare} / ${f(dripCost)}) = ${dripCap}`);
console.log(`RELAY_DAILY_CAP = floor((${f(spendable)} - ${dripCap} x ${f(dripCost)}) / ${f(relayCost)}) = ${relayCap}`);
console.log(`worst-case day  = ${f(worst)} MON <= spendable ${f(spendable)} MON: ${worst <= spendable + 1e-12 ? 'yes' : 'NO'}`);
if (dripCap === 0) console.log('WARNING: the relayer cannot pay for a single drip above the reserve; fund it (docs/OPERATIONS.md) or set DRIP_ENABLED=0.');
console.log('\n# wrangler.toml [vars]');
console.log(`RELAYER_MIN_MON = "${reserve}"`);
console.log(`DRIP_GAS_MON = "${ceil3(dripGas)}"`);
console.log(`RELAY_COST_MON = "${ceil3(relayCost)}"`);
console.log(`DRIP_DAILY_CAP = "${dripCap}"`);
console.log(`DRIP_PER_IP_PER_DAY = "${dripPerIp}"`);
console.log(`RELAY_DAILY_CAP = "${relayCap}"`);
console.log(`RELAY_PER_IP_PER_DAY = "${relayPerIp}"`);
console.log(`RELAY_PER_ADDRESS_PER_DAY = "${relayPerIp}"`);
