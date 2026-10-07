// Local test helper on an ANVIL FORK (never live): time-travels past the ladder's day end and delivers an attested
// CRE-shaped report through the real MockKeystoneForwarder bytecode, exactly as the workflow would.
// On the fork only, the Resolver owner (impersonated) points `attester` at a throwaway key generated here.
//
//   FORK_RPC=http://127.0.0.1:19201 TMAX=30 npx tsx scripts/fork-settle.ts [fork-fixture.json]
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseEther,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { DEPLOYMENTS as D } from '../src/lib/deployments';
import { decodeResult, station4 } from '../src/lib/abi';

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:19201';
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('fork-settle only runs against a local anvil fork');
const fx = JSON.parse(readFileSync(process.argv[2] ?? 'fork-fixture.json', 'utf8')) as { date: number; dayEnd: number };
const TMAX = Number(process.env.TMAX ?? 30);
const VOID = process.env.VOID === '1';

const chain = defineChain({ id: 10143, name: 'fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const transport = http(RPC, { timeout: 120_000 });
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: 'anvil' });

const resolverAbi = parseAbi([
  'function owner() view returns (address)',
  'function setAttester(address)',
  'function attester() view returns (address)',
  'function SETTLEMENT_TYPEHASH() view returns (bytes32)',
  'function resultOf(bytes4,uint32) view returns (bytes32)',
  'function challengeWindow() view returns (uint256)',
  'event LadderResolved(bytes4 indexed station, uint32 indexed date, uint8 status, int16 tmaxC, bytes32 sourcesHash, address caller)',
]);
const forwarderAbi = parseAbi([
  'function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)',
  'event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)',
]);
const V1_TYPE = 'Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash,uint64 validUntil)';

async function main() {
  const ST = station4('RCSS');
  const head = await pub.getBlock();
  const target = fx.dayEnd + 600;
  if (Number(head.timestamp) < target) {
    await test.setNextBlockTimestamp({ timestamp: BigInt(target) });
    await test.mine({ blocks: 1 });
  }
  const owner = (await pub.readContract({ address: D.resolver, abi: resolverAbi, functionName: 'owner' })) as Address;
  const key = generatePrivateKey();
  const att = privateKeyToAccount(key);
  await test.setBalance({ address: owner, value: parseEther('10') });
  await test.impersonateAccount({ address: owner });
  const ow = createWalletClient({ chain, transport, account: owner });
  await pub.waitForTransactionReceipt({ hash: await ow.writeContract({ address: D.resolver, abi: resolverAbi, functionName: 'setAttester', args: [att.address], chain, account: owner }) });
  await test.stopImpersonatingAccount({ address: owner });

  let v1 = false;
  try {
    v1 = (await pub.readContract({ address: D.resolver, abi: resolverAbi, functionName: 'SETTLEMENT_TYPEHASH' })) === keccak256(stringToHex(V1_TYPE));
  } catch {
    v1 = false;
  }
  const sourcesHash = keccak256(stringToHex(`IEM:${TMAX}:48|AWC:${TMAX}:48`));
  const block = await pub.getBlock();
  const validUntil = block.timestamp + 3600n;
  const domain = { name: 'Isotherm Resolver', version: '1', chainId: 10143, verifyingContract: D.resolver } as const;
  const fields = [
    { name: 'station', type: 'bytes4' },
    { name: 'date', type: 'uint32' },
    { name: 'tmaxC', type: 'int16' },
    { name: 'isVoid', type: 'bool' },
    { name: 'sourcesHash', type: 'bytes32' },
    ...(v1 ? [{ name: 'validUntil', type: 'uint64' }] : []),
  ];
  const message: Record<string, unknown> = { station: ST, date: fx.date, tmaxC: VOID ? 0 : TMAX, isVoid: VOID, sourcesHash };
  if (v1) message.validUntil = validUntil;
  const sig = await att.signTypedData({ domain, types: { Settlement: fields }, primaryType: 'Settlement', message } as never);
  const payload = v1
    ? encodeAbiParameters(
        [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'bool' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes' }],
        [ST, fx.date, VOID ? 0 : TMAX, VOID, sourcesHash, validUntil, sig],
      )
    : encodeAbiParameters(
        [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'bool' }, { type: 'bytes32' }, { type: 'bytes' }],
        [ST, fx.date, VOID ? 0 : TMAX, VOID, sourcesHash, sig],
      );
  const execId = keccak256(stringToHex(`fork-settle-${fx.date}-${Date.now()}`));
  const raw = concat([
    '0x01',
    execId,
    toHex(100, { size: 4 }),
    toHex(1, { size: 4 }),
    toHex(1, { size: 4 }),
    `0x${'11'.repeat(32)}` as Hex,
    stringToHex('7721568293', { size: 10 }),
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '0x0001',
    payload,
  ]);
  const sender = '0x00000000000000000000000000000000000c0ffe' as Address;
  await test.setBalance({ address: sender, value: parseEther('1') });
  await test.impersonateAccount({ address: sender });
  const sw = createWalletClient({ chain, transport, account: sender });
  const hash = await sw.writeContract({
    address: D.mockForwarder,
    abi: forwarderAbi,
    functionName: 'report',
    args: [D.resolver, raw, toHex(new Uint8Array(96)), Array.from({ length: 4 }, () => toHex(new Uint8Array(65)))],
    gas: 400_000n,
    chain,
    account: sender,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  let processed: boolean | null = null;
  for (const l of r.logs) {
    try {
      const ev = decodeEventLog({ abi: forwarderAbi, data: l.data, topics: l.topics });
      if (ev.eventName === 'ReportProcessed') processed = (ev.args as { result: boolean }).result;
    } catch {
      /* other */
    }
  }
  const res = decodeResult(
    (await pub.call({ to: D.resolver, data: (await import('viem')).encodeFunctionData({ abi: resolverAbi, functionName: 'resultOf', args: [ST, fx.date] }) })).data!,
  );
  console.log(`report tx ${hash} block ${r.blockNumber} ReportProcessed.result=${processed} (${v1 ? 'v1' : 'feasibility'} attestation)`);
  console.log(`resultOf(RCSS, ${fx.date}) = ${JSON.stringify(res)}`);
  if (process.env.WARP_FINAL === '1' && res && res.finalAt > Number((await pub.getBlock()).timestamp)) {
    await test.setNextBlockTimestamp({ timestamp: BigInt(res.finalAt + 5) });
    await test.mine({ blocks: 1 });
    console.log(`warped past finalAt ${res.finalAt}`);
  }
  console.log(JSON.stringify({ hash, block: r.blockNumber.toString(), processed, result: res }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
