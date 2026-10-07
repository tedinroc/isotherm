// TEST HARNESS ONLY (anvil fork). Settles one ladder so `mm weather redeem` can run:
//   1. impersonates the resolver owner and points `attester` at a throwaway key generated in memory
//   2. moves the fork clock past the station-local day end
//   3. delivers an EIP-712-attested report through the real CRE MockKeystoneForwarder bytecode (same raw-report
//      layout as `cre workflow simulate --broadcast`, see spikes/e2e/ts/lib.ts) and checks ReportProcessed.result
// This is NOT the production settlement path (that is the CRE workflow); it only produces a settled ladder on a fork.
// Usage: node harness/settle-fork.mjs <deployments.json> <STATION> <yyyymmdd> <tmaxC>
import { concat, createPublicClient, createTestClient, createWalletClient, decodeEventLog, encodeAbiParameters, getAddress, http, keccak256, parseAbi, stringToHex, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS, loadAbi, normalizeDeployment } from "../dist/lib/config.js";

const RPC = process.env.ANVIL_RPC || "http://127.0.0.1:19251";
const [file, station, dateStr, tmaxStr] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, "utf8"));
const dep = normalizeDeployment(raw, file, "settle", join(ASSETS, "abi"));
const RESOLVER = dep.resolver;
const resolverJson = loadAbi("Resolver", dep);
const V1 = resolverJson.some((x) => x.type === "function" && x.name === "challengeWindow");
const FORWARDER = "0xB9F79d863261869B234c481D1f9A7af84AeAd192";
const date = Number(dateStr), tmax = Number(tmaxStr);
const chain = { id: 10143, name: "fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const transport = http(RPC);
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });
const resolverAbi = parseAbi([
  "function owner() view returns (address)",
  "function setAttester(address)",
  "function dayEnd(bytes4, uint32) view returns (uint256)",
  ...(V1 ? ["function challengeWindow() view returns (uint256)"] : []),
]);
const fwdAbi = parseAbi([
  "function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)",
  "event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)",
]);

const s4 = stringToHex(station, { size: 4 });
const owner = await pub.readContract({ address: RESOLVER, abi: resolverAbi, functionName: "owner" });
await test.impersonateAccount({ address: owner });
await test.setBalance({ address: owner, value: 10n ** 20n });
const attester = privateKeyToAccount(generatePrivateKey()); // throwaway, never written anywhere
const w = createWalletClient({ chain, transport, account: owner });
let h = await w.writeContract({ address: RESOLVER, abi: resolverAbi, functionName: "setAttester", args: [attester.address], chain });
await pub.waitForTransactionReceipt({ hash: h });
console.log(`resolver.setAttester(<throwaway harness key ${attester.address}>) ${h}`);

const dayEnd = Number(await pub.readContract({ address: RESOLVER, abi: resolverAbi, functionName: "dayEnd", args: [s4, date] }));
const now = Number((await pub.getBlock()).timestamp);
if (now < dayEnd + 60) {
  await test.setNextBlockTimestamp({ timestamp: BigInt(dayEnd + 120) });
  await test.mine({ blocks: 1 });
  console.log(`fork clock moved from ${new Date(now * 1000).toISOString()} to ${new Date((dayEnd + 120) * 1000).toISOString()} (day end + 2 min)`);
}

const sourcesHash = keccak256(stringToHex(`harness:${station}:${date}:tmax=${tmax}:fork-only`));
const validUntil = BigInt(Number((await pub.getBlock()).timestamp) + 3600);
const fields = [{ name: "station", type: "bytes4" }, { name: "date", type: "uint32" }, { name: "tmaxC", type: "int16" }, { name: "isVoid", type: "bool" }, { name: "sourcesHash", type: "bytes32" }, ...(V1 ? [{ name: "validUntil", type: "uint64" }] : [])];
const sig = await attester.signTypedData({
  domain: { name: "Isotherm Resolver", version: "1", chainId: 10143, verifyingContract: RESOLVER },
  types: { Settlement: fields },
  primaryType: "Settlement",
  message: { station: s4, date, tmaxC: tmax, isVoid: false, sourcesHash, ...(V1 ? { validUntil } : {}) },
});
const payload = V1
  ? encodeAbiParameters([{ type: "bytes4" }, { type: "uint32" }, { type: "int16" }, { type: "bool" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [s4, date, tmax, false, sourcesHash, validUntil, sig])
  : encodeAbiParameters([{ type: "bytes4" }, { type: "uint32" }, { type: "int16" }, { type: "bool" }, { type: "bytes32" }, { type: "bytes" }], [s4, date, tmax, false, sourcesHash, sig]);
const execId = keccak256(stringToHex(`harness-exec-${station}-${date}-${Date.now()}`));
const rawReport = concat(["0x01", execId, toHex(100, { size: 4 }), toHex(1, { size: 4 }), toHex(1, { size: 4 }), `0x${"11".repeat(32)}`, stringToHex("7721568293", { size: 10 }), "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0x0001", payload]);
const anyone = privateKeyToAccount(generatePrivateKey());
await test.setBalance({ address: anyone.address, value: 10n ** 20n });
h = await createWalletClient({ chain, transport, account: anyone }).writeContract({
  address: FORWARDER,
  abi: fwdAbi,
  functionName: "report",
  args: [RESOLVER, rawReport, toHex(new Uint8Array(96)), Array.from({ length: 4 }, () => toHex(new Uint8Array(65)))],
  gas: 250_000n,
  chain,
});
const r = await pub.waitForTransactionReceipt({ hash: h });
let result = null;
for (const log of r.logs) {
  try {
    const ev = decodeEventLog({ abi: fwdAbi, data: log.data, topics: log.topics });
    if (ev.eventName === "ReportProcessed") result = ev.args.result;
  } catch {}
}
const res = await pub.readContract({ address: RESOLVER, abi: resolverJson, functionName: "resultOf", args: [s4, date] });
console.log(`MockKeystoneForwarder.report ${h} status=${r.status} ReportProcessed.result=${result} resultOf=(status ${res.status}, tmaxC ${res.tmaxC}${V1 ? `, finalAt ${new Date(Number(res.finalAt) * 1000).toISOString()}` : ""})`);
if (result !== true) process.exit(1);
if (V1 && process.env.SKIP_CHALLENGE !== "1") {
  // v1: redemption opens at finalAt = resolvedAt + challengeWindow; move the fork clock past it
  await test.setNextBlockTimestamp({ timestamp: BigInt(Number(res.finalAt) + 5) });
  await test.mine({ blocks: 1 });
  console.log(`fork clock moved past the ${await pub.readContract({ address: RESOLVER, abi: resolverAbi, functionName: "challengeWindow" })} s challenge window`);
}
