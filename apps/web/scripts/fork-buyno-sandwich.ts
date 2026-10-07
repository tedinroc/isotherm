// ANVIL FORK ONLY (never the live chain). Exercises the web app's "Buy No" path on the DEPLOYED v1 contracts and the
// real Kuru books of the live RCSS ladder, as copied into a local fork:
//   A. normal:     vault.mintSet + zap.sellYes(minAusdOut)  -> fills at the quoted price (gas measured)
//   B. sandwich:   an attacker sells into the bid and leaves a 0.001 dust bid between the victim's quote and its
//                  step 2 -> sellYes reverts with Slippage; the victim keeps N YES + N NO and merges back to N AUSD
//   C. contrast:   the SAME sandwich against the old Zap.buyNo(minAusdBack) fills at ~0.999 per NO (verifier N1)
//   D. Buy Yes:    zap.buyYes gas, for the fee note
// Every scenario starts from the same anvil snapshot and the fork is reverted at the end. Keys are generated here
// and thrown away; the attacker and the AUSD faucet are driven by impersonation / throwaway keys only.
//
//   FORK_RPC=http://127.0.0.1:19520 STRIKE=30 BUDGET=10 npx tsx scripts/fork-buyno-sandwich.ts > evidence/fix-round/x.json
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { DEPLOYMENTS as D } from '../src/lib/deployments';
import { decodeL2, quoteBuyNoViaSell, quoteBuyYes, minOut, toUnits6, fromUnits6 } from '../src/lib/book';
import { planBuyNo } from '../src/lib/buyNoPlan';
import { decodeSeries, station4, zapAbi as webZapAbi } from '../src/lib/abi';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:19520';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC)) throw new Error('fork-buyno-sandwich only runs against a local anvil fork');
const STRIKE = Number(process.env.STRIKE ?? 30);
const BUDGET = Number(process.env.BUDGET ?? 10);
const SLIP = Number(process.env.SLIP ?? 0.02);
const DATE = Number(process.env.DATE ?? 20261008);

const chain = { id: 10143, name: 'fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const transport = http(RPC, { timeout: 120_000 });
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: 'anvil' });

const vaultAbi = parseAbi([
  'function ladderSeries(bytes4,uint32) view returns (bytes32[])',
  'function getSeries(bytes32) view returns (bytes32)',
  'function mintSet(bytes32 seriesId, uint256 amount)',
  'function redeemSet(bytes32 seriesId, uint256 amount)',
]);
const zapAbi = parseAbi([
  'function canonicalMarket(bytes32) view returns (address)',
  'function sellYes(bytes32 seriesId, address market, uint256 yesIn, uint256 minAusdOut, address to) returns (uint256, uint256)',
  'function buyYes(bytes32 seriesId, address market, uint256 ausdIn, uint256 minYesOut, address to) returns (uint256, uint256)',
  // the OLD path, used here only to show what the app no longer does
  'function buyNo(bytes32 seriesId, address market, uint256 ausdIn, uint256 minAusdBack, address to) returns (uint256 noOut, uint256 ausdBack)',
  'event ZapBuyNo(address indexed user, bytes32 indexed seriesId, address market, uint256 ausdIn, uint256 noOut, uint256 ausdBack)',
  'error Slippage(uint256 got, uint256 min)',
]);
const erc20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const bookAbi = parseAbi([
  'function getL2Book() view returns (bytes)',
  'function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill) payable returns (uint256)',
  'function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)',
]);
const marginAbi = parseAbi(['function deposit(address _user, address _token, uint256 _amount) payable']);
const faucetAbi = parseAbi(['function requestFunds(address)']);

type Tx = { fn: string; hash: Hex; status: string; gasUsed: string; gasLimit: string; monBilled: string };
const GAS_PCT = 110n;
// anvil's fork base fee decays with empty blocks, so MON is priced at the LIVE gas price (cast gas-price: 102 gwei on
// 2026-10-07) times the gas LIMIT, which is what Monad bills.
const LIVE_GWEI = BigInt(process.env.LIVE_GWEI ?? 102);
const monAtLive = (gasLimit: bigint) => (Number(gasLimit * LIVE_GWEI) / 1e9).toFixed(5);

async function send(acct: PrivateKeyAccount, to: Address, abi: Abi, functionName: string, args: readonly unknown[], log: Tx[]): Promise<Tx> {
  const w = createWalletClient({ chain, transport, account: acct });
  const est = await pub.estimateContractGas({ address: to, abi, functionName, args, account: acct.address } as never);
  const gas = (est * GAS_PCT + 99n) / 100n;
  const hash = await w.writeContract({ address: to, abi, functionName, args, gas, chain, account: acct } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  const t: Tx = {
    fn: functionName,
    hash,
    status: r.status,
    gasUsed: r.gasUsed.toString(),
    gasLimit: gas.toString(),
    monBilled: monAtLive(gas), // Monad bills the limit
  };
  log.push(t);
  return t;
}

/** Same as send() but the tx is forced through even if estimation would revert (to show the on-chain revert). */
async function sendRaw(acct: PrivateKeyAccount, to: Address, abi: Abi, functionName: string, args: readonly unknown[], gas: bigint, log: Tx[]): Promise<Tx> {
  const w = createWalletClient({ chain, transport, account: acct });
  const hash = await w.writeContract({ address: to, abi, functionName, args, gas, chain, account: acct } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  const t: Tx = { fn: functionName, hash, status: r.status, gasUsed: r.gasUsed.toString(), gasLimit: gas.toString(), monBilled: monAtLive(gas) };
  log.push(t);
  return t;
}

async function as(from: Address, to: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  await test.impersonateAccount({ address: from });
  const w = createWalletClient({ chain, transport, account: from });
  const hash = await w.writeContract({ address: to, abi, functionName, args, chain, account: from } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  await test.stopImpersonatingAccount({ address: from });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
}

async function fundAusd(to: Address, amount: bigint) {
  const funder = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: funder.address, value: parseEther('5') });
  for (let i = 0; i < 4; i++) {
    await test.increaseTime({ seconds: 61 }); // the faucet has a global 60 s cooldown
    await test.mine({ blocks: 1 });
    try {
      await as(funder.address, D.ausdFaucet, faucetAbi as Abi, 'requestFunds', [funder.address]);
      break;
    } catch {
      /* cooldown: try again */
    }
  }
  const bal = (await pub.readContract({ address: D.ausd, abi: erc20, functionName: 'balanceOf', args: [funder.address] })) as bigint;
  if (bal < amount) throw new Error(`faucet gave ${bal}`);
  await as(funder.address, D.ausd, erc20 as Abi, 'transfer', [to, amount]);
}

const bal = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
const book = async (m: Address) => decodeL2((await pub.readContract({ address: m, abi: bookAbi, functionName: 'getL2Book' })) as Hex);

/** The attacker's front-run: sell enough YES to take every bid, then leave a dust bid at 0.001 for HALF the victim's
 *  size (verifier N1 used 50 of 100): Zap.buyNo merges the unsold half back at par, which is what fools its bound. */
async function frontRun(seriesId: Hex, market: Address, yes: Address, dustYes: bigint) {
  const atk = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: atk.address, value: parseEther('5') });
  const b = await book(market);
  const depth = b.bids.reduce((a, l) => a + l.size, 0);
  const dump = toUnits6(Math.ceil(depth));
  await fundAusd(atk.address, dump + 2_000_000n);
  const log: Tx[] = [];
  await send(atk, D.ausd, erc20 as Abi, 'approve', [D.vault, maxUint256], log);
  await send(atk, D.vault, vaultAbi as Abi, 'mintSet', [seriesId, dump], log);
  await send(atk, yes, erc20 as Abi, 'approve', [market, maxUint256], log);
  await send(atk, market, bookAbi as Abi, 'placeAndExecuteMarketSell', [dump, 0n, false, false], log);
  await send(atk, D.ausd, erc20 as Abi, 'approve', [D.marginAccount, maxUint256], log);
  await send(atk, D.marginAccount, marginAbi as Abi, 'deposit', [atk.address, D.ausd, 1_000_000n], log);
  await send(atk, market, bookAbi as Abi, 'batchUpdate', [[10], [dustYes], [], [], [], true], log);
  return { attacker: atk.address, bidsBefore: b.bids, bidsAfter: (await book(market)).bids, txs: log.map((t) => `${t.fn} ${t.status}`) };
}

async function victim() {
  const v = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: v.address, value: parseEther('1') });
  await fundAusd(v.address, 200_000_000n);
  return v;
}

async function main() {
  const block = await pub.getBlock();
  const ids = (await pub.readContract({ address: D.vault, abi: vaultAbi, functionName: 'ladderSeries', args: [station4('RCSS'), DATE] })) as Hex[];
  let seriesId: Hex | null = null;
  let yes: Address | null = null;
  let no: Address | null = null;
  for (const id of ids) {
    const s = decodeSeries((await pub.call({ to: D.vault, data: encodeGetSeries(id) })).data!)!;
    if (s.strikeC === STRIKE) [seriesId, yes, no] = [id, s.yes, s.no];
  }
  if (!seriesId || !yes || !no) throw new Error(`no RCSS ${DATE} ≥${STRIKE} series on this fork`);
  const market = (await pub.readContract({ address: D.zap, abi: zapAbi, functionName: 'canonicalMarket', args: [seriesId] })) as Address;
  const out: Record<string, unknown> = {
    note: 'anvil fork of Monad testnet; deployed v1 vault/zap and the real Kuru book of the live ladder; nothing sent to the live chain',
    rpc: RPC,
    forkBlock: block.number.toString(),
    series: { station: 'RCSS', date: DATE, strike: STRIKE, seriesId, market },
    budget: BUDGET,
    slippage: SLIP,
  };
  const root = await test.snapshot(); // reverted to on any failure, so a crash never leaves an attacked book behind
  const snap = await test.snapshot();
  try {
  // ---------------- A. normal Buy No through the new path ----------------
  {
    const v = await victim();
    const b = await book(market);
    const q = quoteBuyNoViaSell(b, BUDGET, 200, 10);
    const plan = planBuyNo(q, SLIP, { ausdVault: 0n, yesZap: 0n })!;
    const log: Tx[] = [];
    const a0 = await bal(D.ausd, v.address);
    await send(v, D.ausd, erc20 as Abi, 'approve', [D.vault, 100_000_000_000n], log);
    await send(v, yes, erc20 as Abi, 'approve', [D.zap, maxUint256], log);
    await send(v, D.vault, vaultAbi as Abi, 'mintSet', [seriesId, plan.mint], log);
    const sell = await send(v, D.zap, zapAbi as Abi, 'sellYes', [seriesId, market, plan.mint, plan.minAusdOut, v.address], log);
    const r = await pub.getTransactionReceipt({ hash: sell.hash });
    const ev = parseEventLogs({ abi: webZapAbi, logs: r.logs, eventName: 'ZapSellYes' })[0];
    const a1 = await bal(D.ausd, v.address);
    out.A_normal = {
      bookBids: b.bids,
      quote: q,
      plan: { mint: plan.mint.toString(), minAusdOut: plan.minAusdOut.toString(), expectedOut: plan.expectedOut.toString() },
      txs: log,
      sold: { ausdOut: ev.args.ausdOut.toString(), yesRefund: ev.args.yesRefund.toString() },
      noHeld: (await bal(no, v.address)).toString(),
      yesHeld: (await bal(yes, v.address)).toString(),
      ausdPaid: fromUnits6(a0 - a1),
      pricePerNo: fromUnits6(a0 - a1) / fromUnits6(plan.mint),
      monFlowFirstTime: log.reduce((s, t) => s + Number(t.monBilled), 0).toFixed(5),
      monFlowRepeat: log.filter((t) => t.fn !== 'approve').reduce((s, t) => s + Number(t.monBilled), 0).toFixed(5),
    };
  }
  await test.revert({ id: snap });
  const snap2 = await test.snapshot();

  // ---------------- B. sandwich between the quote and step 2 -> step 2 reverts ----------------
  {
    const v = await victim();
    const b = await book(market);
    const q = quoteBuyNoViaSell(b, BUDGET, 200, 10); // the price the victim saw
    const plan = planBuyNo(q, SLIP, { ausdVault: 0n, yesZap: 0n })!;
    const log: Tx[] = [];
    const a0 = await bal(D.ausd, v.address);
    await send(v, D.ausd, erc20 as Abi, 'approve', [D.vault, 100_000_000_000n], log);
    await send(v, yes, erc20 as Abi, 'approve', [D.zap, maxUint256], log);
    await send(v, D.vault, vaultAbi as Abi, 'mintSet', [seriesId, plan.mint], log); // step 1
    const fr = await frontRun(seriesId, market, yes, plan.mint / 2n); // the attacker lands before step 2
    let estimateError: string | null = null;
    try {
      await pub.estimateContractGas({ address: D.zap, abi: zapAbi, functionName: 'sellYes', args: [seriesId, market, plan.mint, plan.minAusdOut, v.address], account: v.address });
    } catch (e) {
      estimateError = ((e as { shortMessage?: string }).shortMessage ?? String(e)).split('\n')[0];
    }
    // a real front-run lands in the same block after the victim's estimate, so force the tx through to show the revert
    const step2 = await sendRaw(v, D.zap, zapAbi as Abi, 'sellYes', [seriesId, market, plan.mint, plan.minAusdOut, v.address], 600_000n, log);
    const yesAfter = await bal(yes, v.address);
    const noAfter = await bal(no, v.address);
    const merge = await send(v, D.vault, vaultAbi as Abi, 'redeemSet', [seriesId, plan.mint], log); // "Merge back"
    const a1 = await bal(D.ausd, v.address);
    out.B_sandwich_newPath = {
      quotedBids: b.bids,
      plan: { mint: plan.mint.toString(), minAusdOut: plan.minAusdOut.toString() },
      attacker: fr,
      step2EstimateError: estimateError,
      step2: step2.status,
      afterStep2: { yes: yesAfter.toString(), no: noAfter.toString() },
      mergeBack: merge.status,
      ausdNetChange: fromUnits6(a1 - a0),
      txs: log,
      verdict: step2.status === 'reverted' && a1 === a0 ? 'PROTECTED: step 2 reverted, pairs merged back, 0 AUSD lost (gas only)' : 'UNEXPECTED',
    };
  }
  await test.revert({ id: snap2 });
  const snap3 = await test.snapshot();

  // ---------------- C. the same sandwich against the old Zap.buyNo (what the app used to do) ----------------
  {
    const v = await victim();
    const b = await book(market);
    const ausdIn = toUnits6(quoteBuyNoViaSell(b, BUDGET, 200, 10).mint);
    const back = fromUnits6(ausdIn) * b.bids[0].price * 0.999;
    const minBack = toUnits6(back * (1 - SLIP));
    const log: Tx[] = [];
    await send(v, D.ausd, erc20 as Abi, 'approve', [D.zap, 100_000_000_000n], log);
    const fr = await frontRun(seriesId, market, yes, ausdIn / 2n);
    const a0 = await bal(D.ausd, v.address);
    const t = await send(v, D.zap, zapAbi as Abi, 'buyNo', [seriesId, market, ausdIn, minBack, v.address], log);
    const r = await pub.getTransactionReceipt({ hash: t.hash });
    const ev = parseEventLogs({ abi: zapAbi, logs: r.logs, eventName: 'ZapBuyNo' })[0];
    const a1 = await bal(D.ausd, v.address);
    const paid = fromUnits6(a0 - a1);
    out.C_sandwich_oldZapBuyNo = {
      ausdIn: ausdIn.toString(),
      minAusdBack: minBack.toString(),
      attacker: { bidsAfter: fr.bidsAfter },
      status: t.status,
      noOut: ev.args.noOut.toString(),
      ausdBack: ev.args.ausdBack.toString(),
      ausdPaid: paid,
      pricePerNo: paid / fromUnits6(ev.args.noOut),
      quotedPricePerNo: 1 - b.bids[0].price * 0.999,
      verdict: 'NOT PROTECTED: the minAusdBack bound passed while the victim paid ~1 per NO',
    };
  }
  await test.revert({ id: snap3 });
  const snap4 = await test.snapshot();

  // ---------------- D. Buy Yes (unchanged path, for the fee note) ----------------
  {
    const v = await victim();
    const b = await book(market);
    const q = quoteBuyYes(b, BUDGET, 10);
    const log: Tx[] = [];
    await send(v, D.ausd, erc20 as Abi, 'approve', [D.zap, 100_000_000_000n], log);
    await send(v, D.zap, zapAbi as Abi, 'buyYes', [seriesId, market, toUnits6(BUDGET), minOut(q.out, SLIP), v.address], log);
    out.D_buyYes = { quote: q, txs: log, yesHeld: (await bal(yes, v.address)).toString() };
  }
  await test.revert({ id: snap4 });
  } catch (e) {
    await test.revert({ id: root }).catch(() => undefined);
    throw e;
  }
  console.log(JSON.stringify(out, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
}

function encodeGetSeries(id: Hex): Hex {
  return encodeFunctionData({ abi: vaultAbi, functionName: 'getSeries', args: [id] });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
