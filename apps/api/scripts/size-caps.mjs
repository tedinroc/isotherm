#!/usr/bin/env node
// Sizes the drip / relay budget vars in wrangler.toml to what the relayer can actually pay, spread over a HORIZON of
// N UTC days so that one day of worst-case use can never take the whole balance. Read-only: one eth_getBalance, one
// eth_gasPrice and one eth_blockNumber against the public RPC; it never signs or sends anything.
//
//   node scripts/size-caps.mjs                          # relayer address from the live /api/health, 7-day horizon
//   node scripts/size-caps.mjs --days 14                # spread the balance over 14 days instead
//   node scripts/size-caps.mjs --address 0x... [--days 7] [--reserve 0.1] [--drip-share 0.65] [--relay-gas 335000]
//
// Formula (all MON; Monad bills gas LIMIT x price, so limits are used, not gas used):
//   spendable        = balance - RELAYER_MIN_MON                          (the reserve is never spent on users)
//   perDay           = spendable / days                                   (days = --days, default 7)
//   dripCost         = DRIP_MON + (21,000 + 78,752 gas) x gasPrice          (MON leg + AUSD-transfer leg, live limits)
//   relayCost        = 335,000 gas x gasPrice      (fork, first-time holder: estimate 309,470 x 1.08 = 334,228 limit)
//   DRIP_DAILY_CAP   = floor(perDay x dripShare / dripCost)
//   RELAY_DAILY_CAP  = floor((perDay - DRIP_DAILY_CAP x dripCost) / relayCost)
//   DRIP_PER_IP_PER_DAY = max(1, floor(DRIP_DAILY_CAP / 2))                (one network gets at most half a day)
//   RELAY_PER_IP_PER_DAY = RELAY_PER_ADDRESS_PER_DAY = max(1, floor(RELAY_DAILY_CAP / 2))
// so the worst case for one UTC day, DRIP_DAILY_CAP x dripCost + RELAY_DAILY_CAP x relayCost, fits in perDay, and
// `days` consecutive worst-case days fit in spendable: the relayer lasts at least `days` days of maximum use without a
// top-up. After that, drips and relays stop at the reserve (dripReady / relayReady turn false); they never spend it.
// Re-run after funding the relayer (or when the horizon to the next top-up changes), paste the printed vars into
// wrangler.toml and redeploy.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = Object.freeze({
  reserve: 0.1, // RELAYER_MIN_MON
  dripMon: 0.15, // DRIP_MON
  dripShare: 0.65, // share of a day's budget that may go to drips (the rest to relays)
  days: 7, // horizon: the balance must cover this many consecutive worst-case UTC days
  dripGasUnits: 21_000 + 78_752, // MON transfer + AUSD transfer gas LIMITS (live)
  relayGasUnits: 335_000, // relayed mintSetWithAuthorization gas LIMIT, first-time holder (fork: 334,228)
});

const FLAGS = { rpc: 'rpc', api: 'api', address: 'address', reserve: 'reserve', 'drip-mon': 'dripMon', 'drip-share': 'dripShare', 'relay-gas': 'relayGasUnits', days: 'days' };

/** `--flag value` pairs -> { flag: value }. Unknown flags and flags without a value are errors (a typo such as
 *  `--day 14` must not silently fall back to the 7-day default). */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: 'true' };
    if (!a.startsWith('--') || !(a.slice(2) in FLAGS)) throw new Error(`unknown argument ${a} (flags: ${Object.keys(FLAGS).map((f) => `--${f}`).join(' ')})`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    out[a.slice(2)] = v;
    i++;
  }
  return out;
}

const positive = (name, x) => {
  if (!Number.isFinite(x) || x <= 0) throw new Error(`${name} must be a positive number (got ${x})`);
  return x;
};

/** Pure sizing (no I/O). balance and gasPrice in MON (gasPrice = MON per gas unit). */
export function sizeCaps(input) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  if (!Number.isFinite(o.balance) || o.balance < 0) throw new Error(`balance must be >= 0 (got ${o.balance})`);
  positive('gasPrice', o.gasPrice);
  if (!Number.isFinite(o.reserve) || o.reserve < 0) throw new Error(`reserve must be >= 0 (got ${o.reserve})`);
  positive('dripMon', o.dripMon);
  if (!(o.dripShare >= 0 && o.dripShare <= 1)) throw new Error(`dripShare must be between 0 and 1 (got ${o.dripShare})`);
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > 365) throw new Error(`days must be a whole number from 1 to 365 (got ${o.days})`);
  positive('dripGasUnits', o.dripGasUnits);
  positive('relayGasUnits', o.relayGasUnits);

  const spendable = Math.max(0, o.balance - o.reserve);
  const perDay = spendable / o.days;
  const dripGas = o.dripGasUnits * o.gasPrice;
  const dripCost = o.dripMon + dripGas;
  const relayCost = o.relayGasUnits * o.gasPrice;
  const dripCap = Math.floor((perDay * o.dripShare) / dripCost);
  const relayCap = Math.max(0, Math.floor((perDay - dripCap * dripCost) / relayCost));
  const dripPerIp = Math.max(1, Math.floor(dripCap / 2));
  const relayPerIp = Math.max(1, Math.floor(relayCap / 2));
  const worstDay = dripCap * dripCost + relayCap * relayCost;
  const worstHorizon = worstDay * o.days;
  const eps = 1e-12;
  const ceil3 = (x) => (Math.ceil(x * 1000) / 1000).toFixed(3);
  return {
    inputs: o,
    spendable,
    perDay,
    dripGas,
    dripCost,
    relayCost,
    dripCap,
    relayCap,
    dripPerIp,
    relayPerIp,
    worstDay,
    worstHorizon,
    fitsDay: worstDay <= perDay + eps,
    fitsHorizon: worstHorizon <= spendable + eps,
    vars: {
      RELAYER_MIN_MON: String(o.reserve),
      DRIP_GAS_MON: ceil3(dripGas),
      RELAY_COST_MON: ceil3(relayCost),
      DRIP_DAILY_CAP: String(dripCap),
      DRIP_PER_IP_PER_DAY: String(dripPerIp),
      RELAY_DAILY_CAP: String(relayCap),
      RELAY_PER_IP_PER_DAY: String(relayPerIp),
      RELAY_PER_ADDRESS_PER_DAY: String(relayPerIp),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/size-caps.mjs [--days 7] [--address 0x...] [--reserve 0.1] [--drip-mon 0.15] [--drip-share 0.65] [--relay-gas 335000] [--rpc URL] [--api URL]');
    return;
  }
  const RPC = args.rpc ?? 'https://testnet-rpc.monad.xyz';
  const API = args.api ?? 'https://isotherm.pages.dev';
  const num = (k) => (args[k] === undefined ? undefined : Number(args[k]));
  const rpc = async (method, params) => {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };

  let address = args.address;
  if (!address) address = (await (await fetch(`${API}/api/health`)).json()).relayer;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) throw new Error('no relayer address (pass --address)');

  const [balHex, gpHex, head] = await Promise.all([rpc('eth_getBalance', [address, 'latest']), rpc('eth_gasPrice', []), rpc('eth_blockNumber', [])]);
  const balance = Number(BigInt(balHex)) / 1e18;
  const gasPrice = Number(BigInt(gpHex)) / 1e18; // MON per gas
  const s = sizeCaps({
    balance,
    gasPrice,
    reserve: num('reserve'),
    dripMon: num('drip-mon'),
    dripShare: num('drip-share'),
    relayGasUnits: num('relay-gas'),
    days: num('days'),
  });
  const { inputs: o } = s;
  const f = (x, d = 6) => x.toFixed(d);
  const at = new Date().toISOString();

  console.log(`relayer ${address} at block ${BigInt(head)} (${at})`);
  console.log(`balance ${f(balance, 9)} MON, gas price ${f(gasPrice * 1e9, 1)} gwei, reserve ${o.reserve} -> spendable ${f(s.spendable)} MON`);
  console.log(`horizon ${o.days} days -> perDay = ${f(s.spendable)} / ${o.days} = ${f(s.perDay)} MON`);
  console.log(`dripCost  = ${o.dripMon} + ${o.dripGasUnits} gas x price = ${f(s.dripCost)} MON`);
  console.log(`relayCost = ${o.relayGasUnits} gas x price = ${f(s.relayCost)} MON`);
  console.log(`DRIP_DAILY_CAP  = floor(${f(s.perDay)} x ${o.dripShare} / ${f(s.dripCost)}) = ${s.dripCap}`);
  console.log(`RELAY_DAILY_CAP = floor((${f(s.perDay)} - ${s.dripCap} x ${f(s.dripCost)}) / ${f(s.relayCost)}) = ${s.relayCap}`);
  console.log(`worst-case day      = ${f(s.worstDay)} MON <= perDay ${f(s.perDay)} MON: ${s.fitsDay ? 'yes' : 'NO'}`);
  console.log(`worst-case ${String(o.days).padStart(2)} days  = ${f(s.worstHorizon)} MON <= spendable ${f(s.spendable)} MON: ${s.fitsHorizon ? 'yes' : 'NO'}`);
  if (s.dripCap === 0) console.log(`WARNING: ${o.days} days of drips do not fit above the reserve; fund the relayer (docs/OPERATIONS.md), shorten --days, or set DRIP_ENABLED=0.`);
  if (s.relayCap === 0) console.log(`WARNING: no relayed mints fit in a ${o.days}-day horizon; fund the relayer or shorten --days.`);
  console.log(`\n# wrangler.toml [vars] -- sized ${at.slice(0, 16)}Z from balance ${f(balance, 3)} MON at ${f(gasPrice * 1e9, 0)} gwei, reserve ${o.reserve}, horizon ${o.days} days`);
  for (const [k, v] of Object.entries(s.vars)) console.log(`${k} = "${v}"`);
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`size-caps: ${e.message}`);
    process.exit(1);
  });
}
