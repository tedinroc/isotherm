// Local test fixture on an ANVIL FORK of Monad testnet (never the live chain): opens a Taipei ladder for tomorrow
// on the configured deployment (deployments/testnet.json, or the feasibility fallback), creates one Kuru YES/AUSD
// book per strike, has the (impersonated) maker mint inventory and quote both sides, and optionally posts a maker
// snapshot to a local API. Uses anvil impersonation only: no private key is read.
//
//   anvil --fork-url https://testnet-rpc.monad.xyz --port 19201
//   FORK_RPC=http://127.0.0.1:19201 API_URL=http://127.0.0.1:8781 SNAPSHOT_TOKEN=… npx tsx scripts/fork-fixture.ts
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { writeFileSync } from 'node:fs';
import { DEPLOYMENTS as D } from '../src/lib/deployments';
import { decodeSeries, station4 } from '../src/lib/abi';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:19201';
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('fork-fixture only runs against a local anvil fork');
const STRIKES = (process.env.STRIKES ?? '27,28,29,30,31,32').split(',').map(Number);
const FAIR: Record<number, number> = { 26: 0.97, 27: 0.93, 28: 0.84, 29: 0.62, 30: 0.33, 31: 0.12, 32: 0.04, 33: 0.01 };
const PM: Record<number, number> = { 26: 0.977, 27: 0.946, 28: 0.895, 29: 0.806, 30: 0.5, 31: 0.139, 32: 0.067, 33: 0.02 };
const MODEL: Record<number, number> = { 26: 0.992, 27: 0.985, 28: 0.965, 29: 0.875, 30: 0.631, 31: 0.269, 32: 0.051, 33: 0.01 };
const MAKER = getAddress(process.env.MAKER ?? '0xd572638F07829D1c3636400FB73CF34Ca6c7448a');

const chain = defineChain({
  id: 10143,
  name: 'Monad Testnet (anvil fork)',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const transport = http(RPC, { timeout: 120_000, retryCount: 2 });
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: 'anvil' });

const ownableAbi = parseAbi(['function owner() view returns (address)', 'function isOperator(address) view returns (bool)']);
const resolverAbi = parseAbi([
  'function stations(bytes4) view returns (int32 utcOffset, bool registered)',
  'function registerStation(bytes4 station, int32 utcOffset)',
  'function dayEnd(bytes4 station, uint32 date) view returns (uint256)',
]);
const vaultAbi = parseAbi([
  'function createLadder(bytes4 station, uint32 date, int16[] strikesC, uint64 closeTime) returns (bytes32[])',
  'function ladderSeries(bytes4 station, uint32 date) view returns (bytes32[])',
  'function getSeries(bytes32) view returns (bytes32)',
  'function mintSet(bytes32 seriesId, uint256 amount)',
]);
const erc20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
]);
const routerAbi = parseAbi([
  'function deployProxy(uint8 _type, address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread) returns (address proxy)',
  'event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)',
]);
const marginAbi = parseAbi(['function deposit(address _user, address _token, uint256 _amount) payable']);
const bookAbi = parseAbi([
  'function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)',
]);
const zapAbi = parseAbi(['function canonicalMarket(bytes32) view returns (address)', 'function setCanonicalMarket(bytes32 seriesId, address market)']);
const faucetAbi = parseAbi(['function requestFunds(address)']);

async function as(from: Address, to: Address, abi: any, functionName: string, args: readonly unknown[]): Promise<Hex> {
  await test.impersonateAccount({ address: from });
  const w = createWalletClient({ chain, transport, account: from });
  const hash = await w.writeContract({ address: to, abi, functionName, args, chain, account: from } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
  await test.stopImpersonatingAccount({ address: from });
  return hash;
}

function taipeiDate(unix: number, plusDays = 0) {
  const d = new Date((unix + 8 * 3600 + plusDays * 86400) * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

async function main() {
  const block = await pub.getBlock();
  const now = Number(block.timestamp);
  const ST = station4('RCSS');
  const date = Number(process.env.DATE ?? taipeiDate(now, 1));
  const owner = (await pub.readContract({ address: D.vault, abi: ownableAbi, functionName: 'owner' })) as Address;
  const resOwner = (await pub.readContract({ address: D.resolver, abi: ownableAbi, functionName: 'owner' })) as Address;
  console.log(`fork block ${block.number} ts ${now}; deployment ${D.source}; vault ${D.vault} owner ${owner}`);
  for (const a of [owner, resOwner, MAKER]) await test.setBalance({ address: a, value: parseEther('100') });

  const st = (await pub.readContract({ address: D.resolver, abi: resolverAbi, functionName: 'stations', args: [ST] })) as readonly [number, boolean];
  if (!st[1]) {
    await as(resOwner, D.resolver, resolverAbi, 'registerStation', [ST, 28800]);
    console.log('registered RCSS +8h');
  }
  const dayEnd = Number(await pub.readContract({ address: D.resolver, abi: resolverAbi, functionName: 'dayEnd', args: [ST, date] }));
  const closeTime = BigInt(dayEnd - 3600);
  let ids = (await pub.readContract({ address: D.vault, abi: vaultAbi, functionName: 'ladderSeries', args: [ST, date] })) as Hex[];
  if (!ids.length) {
    await as(owner, D.vault, vaultAbi, 'createLadder', [ST, date, STRIKES, closeTime]);
    ids = (await pub.readContract({ address: D.vault, abi: vaultAbi, functionName: 'ladderSeries', args: [ST, date] })) as Hex[];
    console.log(`createLadder RCSS ${date} [${STRIKES}] close ${new Date(Number(closeTime) * 1000).toISOString()}`);
  }

  // maker AUSD: top up from the faucet on the fork if needed (time-warp past its global cooldown)
  let ausd = (await pub.readContract({ address: D.ausd, abi: erc20, functionName: 'balanceOf', args: [MAKER] })) as bigint;
  if (ausd < 6_000_000_000n) {
    await test.increaseTime({ seconds: 120 });
    await test.mine({ blocks: 1 });
    await as(MAKER, D.ausdFaucet, faucetAbi, 'requestFunds', [MAKER]);
    ausd = (await pub.readContract({ address: D.ausd, abi: erc20, functionName: 'balanceOf', args: [MAKER] })) as bigint;
  }
  console.log(`maker AUSD ${Number(ausd) / 1e6}`);
  await as(MAKER, D.ausd, erc20, 'approve', [D.vault, maxUint256]);
  await as(MAKER, D.ausd, erc20, 'approve', [D.marginAccount, maxUint256]);

  const zapCode = (await pub.getCode({ address: D.zap })) ?? '0x';
  const registry = zapCode.toLowerCase().includes('63' + encodeFunctionData({ abi: zapAbi, functionName: 'canonicalMarket', args: [ids[0]] }).slice(2, 10));

  const out: { seriesId: Hex; k: number; yes: Address; no: Address; market: Address; marketBlock: number; fair: number }[] = [];
  for (const id of ids) {
    const raw = (await pub.call({ to: D.vault, data: encodeFunctionData({ abi: vaultAbi, functionName: 'getSeries', args: [id] }) })).data!;
    const s = decodeSeries(raw)!;
    let market: Address | null = null;
    if (registry) {
      const m = (await pub.readContract({ address: D.zap, abi: zapAbi, functionName: 'canonicalMarket', args: [id] })) as Address;
      if (!/^0x0{40}$/i.test(m)) market = m;
    }
    let marketBlock = Number(await pub.getBlockNumber());
    if (!market) {
      const hash = await as(MAKER, D.kuruRouter, routerAbi, 'deployProxy', [0, s.yes, D.ausd, 1_000_000n, 10_000, 10, 1_000_000n, 1_000_000_000_000n, 10n, 0n, 100n]);
      const r = await pub.getTransactionReceipt({ hash });
      marketBlock = Number(r.blockNumber);
      for (const l of r.logs) {
        try {
          const ev = decodeEventLog({ abi: routerAbi, data: l.data, topics: l.topics });
          if (ev.eventName === 'MarketRegistered') market = getAddress((ev.args as { market: Address }).market);
        } catch {
          /* other logs */
        }
      }
      if (!market) throw new Error('no MarketRegistered');
      if (registry) await as(owner, D.zap, zapAbi, 'setCanonicalMarket', [id, market]);
    }
    // inventory: 300 sets, 300 YES into the margin account, quotes around the fair value
    await as(MAKER, D.vault, vaultAbi, 'mintSet', [id, 300_000_000n]);
    await as(MAKER, s.yes, erc20, 'approve', [D.marginAccount, maxUint256]);
    await as(MAKER, D.marginAccount, marginAbi, 'deposit', [MAKER, s.yes, 300_000_000n]);
    const fair = FAIR[s.strikeC] ?? 0.5;
    const bid = Math.max(10, Math.floor(Math.round((fair - 0.02) * 1e6) / 1e3) * 10);
    const ask = Math.min(9990, Math.ceil(Math.round((fair + 0.02) * 1e6) / 1e3) * 10);
    await as(MAKER, D.marginAccount, marginAbi, 'deposit', [MAKER, D.ausd, BigInt(Math.ceil((150 * bid) / 10_000 + 1)) * 1_000_000n]);
    await as(MAKER, market, bookAbi, 'batchUpdate', [[bid], [150_000_000n], [ask], [150_000_000n], [], false]);
    out.push({ seriesId: id, k: s.strikeC, yes: s.yes, no: s.no, market, marketBlock, fair });
    console.log(`  >=${s.strikeC}°C series ${id.slice(0, 10)}… market ${market} bid ${bid / 1e4} ask ${ask / 1e4}${registry ? ' (canonical set)' : ''}`);
  }

  const snapshot = {
    generatedAt: new Date(now * 1000).toISOString(),
    source: 'fork-fixture (anvil, NOT live)',
    ladders: [
      {
        station: 'RCSS',
        city: 'Taipei',
        date,
        closeTime: Number(closeTime),
        dayEnd,
        observedMaxC: null,
        forecast: { mu: 29.8 },
        polymarket: { slug: `highest-temperature-in-taipei-on-${monthName(date)}-${date % 100}-${Math.floor(date / 10000)}` },
        strikes: out.map((o) => ({
          k: o.k,
          seriesId: o.seriesId,
          yes: o.yes,
          no: o.no,
          market: o.market,
          marketBlock: o.marketBlock,
          fair: o.fair,
          pmImplied: PM[o.k] ?? o.fair,
          model: MODEL[o.k] ?? o.fair,
        })),
      },
    ],
  };
  const file = process.env.OUT ?? 'fork-fixture.json';
  writeFileSync(file, JSON.stringify({ date, dayEnd, closeTime: Number(closeTime), registry, strikes: out, snapshot }, null, 2));
  console.log(`wrote ${file}`);
  if (process.env.API_URL && process.env.SNAPSHOT_TOKEN) {
    const r = await fetch(`${process.env.API_URL}/api/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SNAPSHOT_TOKEN}` },
      body: JSON.stringify(snapshot),
    });
    console.log(`POST snapshot -> ${r.status} ${await r.text()}`);
  }
}

function monthName(date: number) {
  return ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][Math.floor(date / 100) % 100 - 1];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
