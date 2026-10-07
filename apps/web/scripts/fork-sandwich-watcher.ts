// ANVIL FORK ONLY. A mempool sandwich against the web app's "Buy No" step 2, for the in-browser test:
//   1. stages an attacker (throwaway key) with YES inventory, approvals and a little AUSD margin on the strike's book;
//   2. switches the fork to manual mining and watches the txpool;
//   3. when the victim's zap.sellYes appears, it slips two attacker txs in front of it IN THE SAME BLOCK (higher
//      priority fee): a market sell that takes every bid, then a dust bid at 0.001 for half the victim's size;
//   4. mines that block, prints the block order and the victim's receipt status, and restores interval mining.
// The victim's sellYes was estimated before the attack (so the wallet sent it) and must revert with Slippage.
//
//   FORK_RPC=http://127.0.0.1:19520 VICTIM=0x… STRIKE=30 npx tsx scripts/fork-sandwich-watcher.ts > evidence/fix-round/x.json
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseGwei,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DEPLOYMENTS as D } from '../src/lib/deployments';
import { decodeL2, toUnits6 } from '../src/lib/book';
import { decodeSeries, station4 } from '../src/lib/abi';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:19520';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC)) throw new Error('fork-sandwich-watcher only runs against a local anvil fork');
const VICTIM = getAddress(process.env.VICTIM ?? '0x0000000000000000000000000000000000000000');
const STRIKE = Number(process.env.STRIKE ?? 30);
const DATE = Number(process.env.DATE ?? 20261008);
const RESTORE_INTERVAL = Number(process.env.RESTORE_INTERVAL ?? 3);
const TIMEOUT_S = Number(process.env.TIMEOUT_S ?? 600);

const chain = { id: 10143, name: 'fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const transport = http(RPC, { timeout: 60_000 });
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: 'anvil' });

const vaultAbi = parseAbi(['function ladderSeries(bytes4,uint32) view returns (bytes32[])', 'function getSeries(bytes32) view returns (bytes32)', 'function mintSet(bytes32,uint256)']);
const zapAbi = parseAbi([
  'function canonicalMarket(bytes32) view returns (address)',
  'function sellYes(bytes32 seriesId, address market, uint256 yesIn, uint256 minAusdOut, address to) returns (uint256, uint256)',
]);
const erc20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const bookAbi = parseAbi([
  'function getL2Book() view returns (bytes)',
  'function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill) payable returns (uint256)',
  'function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)',
]);
const marginAbi = parseAbi(['function deposit(address _user, address _token, uint256 _amount) payable']);
const faucetAbi = parseAbi(['function requestFunds(address)']);
const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 23), ...a);

async function as(from: Address, to: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  await test.impersonateAccount({ address: from });
  const w = createWalletClient({ chain, transport, account: from });
  const hash = await w.writeContract({ address: to, abi, functionName, args, chain, account: from } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  await test.stopImpersonatingAccount({ address: from });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
}

async function main() {
  const ids = (await pub.readContract({ address: D.vault, abi: vaultAbi, functionName: 'ladderSeries', args: [station4('RCSS'), DATE] })) as Hex[];
  let seriesId: Hex | null = null;
  let yes: Address | null = null;
  for (const id of ids) {
    const s = decodeSeries((await pub.call({ to: D.vault, data: encodeFunctionData({ abi: vaultAbi, functionName: 'getSeries', args: [id] }) })).data!)!;
    if (s.strikeC === STRIKE) [seriesId, yes] = [id, s.yes];
  }
  if (!seriesId || !yes) throw new Error(`no ≥${STRIKE} series`);
  const market = (await pub.readContract({ address: D.zap, abi: zapAbi, functionName: 'canonicalMarket', args: [seriesId] })) as Address;
  const book = decodeL2((await pub.readContract({ address: market, abi: bookAbi, functionName: 'getL2Book' })) as Hex);
  const dump = toUnits6(Math.ceil(book.bids.reduce((a, l) => a + l.size, 0)) + 1);

  // 1. stage the attacker (interval mining is on, so these confirm within a few seconds)
  const atk = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: atk.address, value: parseEther('5') });
  const funder = privateKeyToAccount(generatePrivateKey()).address;
  await test.setBalance({ address: funder, value: parseEther('5') });
  for (let i = 0; i < 4; i++) {
    await test.increaseTime({ seconds: 61 });
    try {
      await as(funder, D.ausdFaucet, faucetAbi as Abi, 'requestFunds', [funder]);
      break;
    } catch {
      /* global faucet cooldown */
    }
  }
  await as(funder, D.ausd, erc20 as Abi, 'transfer', [atk.address, dump + 2_000_000n]);
  const w = createWalletClient({ chain, transport, account: atk });
  const wait = async (h: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error(`staging tx reverted ${h}`);
  };
  await wait(await w.writeContract({ address: D.ausd, abi: erc20, functionName: 'approve', args: [D.vault, maxUint256], chain, account: atk }));
  await wait(await w.writeContract({ address: D.vault, abi: vaultAbi, functionName: 'mintSet', args: [seriesId, dump], chain, account: atk }));
  await wait(await w.writeContract({ address: yes, abi: erc20, functionName: 'approve', args: [market, maxUint256], chain, account: atk }));
  await wait(await w.writeContract({ address: D.ausd, abi: erc20, functionName: 'approve', args: [D.marginAccount, maxUint256], chain, account: atk }));
  await wait(await w.writeContract({ address: D.marginAccount, abi: marginAbi, functionName: 'deposit', args: [atk.address, D.ausd, 1_000_000n], chain, account: atk }));
  log(`attacker ${atk.address} staged: ${Number(dump) / 1e6} YES ready to dump into bids ${JSON.stringify(book.bids)}`);

  // 2. manual mining + txpool watch
  await test.setIntervalMining({ interval: 0 });
  await test.setAutomine(false);
  const sellSel = encodeFunctionData({ abi: zapAbi, functionName: 'sellYes', args: [seriesId, market, 0n, 0n, VICTIM] }).slice(0, 10);
  log(`manual mining; watching for ${VICTIM} → zap.sellYes (${sellSel})`);
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < TIMEOUT_S * 1000) {
      const pool = (await pub.request({ method: 'txpool_content' as never, params: [] as never })) as {
        pending: Record<string, Record<string, { hash: Hex; from: Address; to: Address | null; input: Hex; maxPriorityFeePerGas?: Hex; gasPrice?: Hex }>>;
      };
      const pending = Object.values(pool.pending ?? {}).flatMap((byNonce) => Object.values(byNonce));
      const victimSell = pending.find(
        (tx) => getAddress(tx.from) === VICTIM && tx.to && getAddress(tx.to) === getAddress(D.zap) && tx.input.startsWith(sellSel),
      );
      if (victimSell) {
        const args = decodeFunctionData({ abi: zapAbi, data: victimSell.input }).args as readonly [Hex, Address, bigint, bigint, Address];
        const [, , yesIn, minAusdOut] = args;
        log(`victim sellYes in mempool ${victimSell.hash}: yesIn ${Number(yesIn) / 1e6}, minAusdOut ${Number(minAusdOut) / 1e6}`);
        const nonce = await pub.getTransactionCount({ address: atk.address, blockTag: 'latest' });
        const fees = { maxFeePerGas: parseGwei('500'), maxPriorityFeePerGas: parseGwei('200') };
        const h1 = await w.writeContract({ address: market, abi: bookAbi, functionName: 'placeAndExecuteMarketSell', args: [dump, 0n, false, false], gas: 3_000_000n, nonce, ...fees, chain, account: atk });
        const h2 = await w.writeContract({ address: market, abi: bookAbi, functionName: 'batchUpdate', args: [[10], [yesIn / 2n], [], [], [], true], gas: 1_500_000n, nonce: nonce + 1, ...fees, chain, account: atk });
        await test.mine({ blocks: 1 });
        const block = await pub.getBlock({ blockTag: 'latest', includeTransactions: true });
        const order = block.transactions.map((tx) => ({ hash: tx.hash, from: tx.from, role: tx.hash === victimSell.hash ? 'victim sellYes' : tx.hash === h1 ? 'attacker market sell' : tx.hash === h2 ? 'attacker dust bid 0.001' : 'other' }));
        const rv = await pub.getTransactionReceipt({ hash: victimSell.hash });
        const r1 = await pub.getTransactionReceipt({ hash: h1 });
        const r2 = await pub.getTransactionReceipt({ hash: h2 });
        const after = decodeL2((await pub.readContract({ address: market, abi: bookAbi, functionName: 'getL2Book' })) as Hex);
        console.log(
          JSON.stringify(
            {
              note: 'anvil fork; deployed v1 contracts + real Kuru book; in-browser dev wallet is the victim',
              series: { station: 'RCSS', date: DATE, strike: STRIKE, seriesId, market },
              bidsBefore: book.bids,
              victim: { address: VICTIM, sellYes: victimSell.hash, yesIn: yesIn.toString(), minAusdOut: minAusdOut.toString(), status: rv.status, gasUsed: rv.gasUsed.toString() },
              attacker: { address: atk.address, marketSell: { hash: h1, status: r1.status }, dustBid: { hash: h2, status: r2.status, size: (yesIn / 2n).toString(), price: 0.001 } },
              block: { number: block.number.toString(), order },
              bidsAfter: after.bids,
              verdict: rv.status === 'reverted' ? 'PROTECTED: the sandwiched step 2 reverted (Slippage); the victim keeps complete pairs' : 'UNEXPECTED: victim sell did not revert',
            },
            null,
            2,
          ),
        );
        return;
      }
      if (pending.length) await test.mine({ blocks: 1 }); // keep the victim's other txs (approvals, mintSet) flowing
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timed out waiting for the victim sellYes');
  } finally {
    await test.setAutomine(false).catch(() => undefined);
    await test.setIntervalMining({ interval: RESTORE_INTERVAL }).catch(() => undefined);
    log(`restored interval mining ${RESTORE_INTERVAL}s`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
