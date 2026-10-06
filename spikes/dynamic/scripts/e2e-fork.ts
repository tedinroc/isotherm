// End-to-end proof of Isotherm's gasless onboarding on an anvil fork of Monad testnet.
//
//   anvil --fork-url https://testnet-rpc.monad.xyz --fork-block-number <N> --network monad \
//         --chain-id 10143 --port 18645
//   FORK_RPC=http://127.0.0.1:18645 npx tsx scripts/e2e-fork.ts
//
// The "embedded wallet" is simulated by a fresh local secp256k1 key: a Dynamic TSS-MPC
// embedded wallet is a plain EOA whose signTypedData output is a standard 65-byte ECDSA
// signature, and the PWA calls the exact same `authorizationTypedData()` builder.
// The relayer runs the real HTTP server (relayer/server.ts) and is called with the same
// fetch client the PWA uses (src/lib/relayerClient.ts).
//
// Set LIVE=1 with FORK_RPC=https://testnet-rpc.monad.xyz to run against the real testnet
// (needs a funded relayer key; no anvil cheatcodes are used in that mode).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseSignature,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import {
  AUSD_ADDRESS,
  ausdAbi,
  authorizationTypedData,
  formatAusd,
  newAuthorization,
  permitTypedData,
  toWire,
} from '../src/lib/ausd';
import { relayer as relayerClient } from '../src/lib/relayerClient';
import { createRelayerCore, depositorAbi } from '../relayer/core';
import { startServer } from '../relayer/server';
import { readKeyFile } from '../relayer/signer';

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:18645';
const LIVE = process.env.LIVE === '1';
const CHAIN_ID = 10143;
const AUSD = AUSD_ADDRESS[CHAIN_ID];
const RELAYER_KEY_FILE = process.env.RELAYER_KEY_FILE ?? '~/.config/isotherm/deployer.key';
const VAULT_STANDIN: Address = '0x029049a9dA77231dd86A90E52Fd6Db542424e727'; // taker2 = stand-in for the Isotherm vault
const PORT = Number(process.env.E2E_PORT ?? 18791);

const chain = { ...monadTestnet, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC) });
const relayerAccount = privateKeyToAccount(readKeyFile(RELAYER_KEY_FILE));
const relayerWallet = createWalletClient({ account: relayerAccount, chain, transport: http(RPC) });

// Simulated brand-new Dynamic embedded wallet (or a fixed key in LIVE mode, so it can be inspected).
const userKey = LIVE && process.env.USER_KEY_FILE ? readKeyFile(process.env.USER_KEY_FILE) : generatePrivateKey();
const user = privateKeyToAccount(userKey);
const userWallet = createWalletClient({ account: user, chain, transport: http(RPC) });

const results: Record<string, unknown> = { rpc: RPC, live: LIVE, relayer: relayerAccount.address, user: user.address };
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
}
const bal = (a: Address) => pub.readContract({ address: AUSD, abi: ausdAbi, functionName: 'balanceOf', args: [a] });
const mon = (a: Address) => pub.getBalance({ address: a });
async function expectError(name: string, p: Promise<unknown>, needle: RegExp) {
  try {
    await p;
    check(name, false, 'did not throw');
  } catch (e) {
    const m = (e as Error).message.split('\n')[0];
    check(name, needle.test(m), m.slice(0, 140));
  }
}

async function main() {
  // Fork mode: every run starts from the same pinned state and leaves no residue.
  const snap = LIVE ? undefined : await test.snapshot();
  try {
    await body();
  } finally {
    if (snap) await test.revert({ id: snap });
  }
  finish();
}

function finish() {
  results.summary = { pass, fail };
  const outDir = join(here, '../evidence');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `e2e-${LIVE ? 'live' : 'fork'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`\n${pass} passed, ${fail} failed -> ${out}`);
  process.exit(fail ? 1 : 0);
}

async function body() {
  const block = await pub.getBlockNumber();
  results.forkBlock = block.toString();
  console.log(`chain ${await pub.getChainId()} block ${block} relayer ${relayerAccount.address} user ${user.address}`);

  if (!LIVE) await test.setBalance({ address: relayerAccount.address, value: parseEther('10') });
  check('user (fresh embedded wallet) starts with 0 MON', (await mon(user.address)) === 0n);

  // Deploy the receiveWithAuthorization consumer (stand-in for the Isotherm series contract).
  const art = JSON.parse(readFileSync(join(here, '../contracts/out/GaslessDepositor.sol/GaslessDepositor.json'), 'utf8'));
  const deployHash = await relayerWallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object as Hex, args: [AUSD] });
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const depositor = deployRcpt.contractAddress!;
  results.depositor = { address: depositor, gasUsed: deployRcpt.gasUsed.toString(), tx: deployHash };
  check('GaslessDepositor deployed', deployRcpt.status === 'success', { depositor, gasUsed: deployRcpt.gasUsed.toString() });

  const base = {
    publicClient: pub,
    walletClient: relayerWallet,
    signerKind: 'local-key' as const,
    chainId: CHAIN_ID,
    depositTo: VAULT_STANDIN,
    allowedTransferTo: [VAULT_STANDIN],
    allowedReceivers: [depositor],
    maxRelayValue: parseUnits('1000', 6),
    maxTtlSeconds: 3600,
    dripAusd: parseUnits('1000', 6),
    dripAusdFaucet: true,
    dripCooldownMs: 0,
    gasMarginPct: 15,
  };
  // Phase 1 relayer: AUSD faucet only, so we can prove the user relays with 0 MON.
  const core = createRelayerCore({ ...base, dripMon: 0n });
  const server = await startServer(core, PORT);
  const api = relayerClient(`http://127.0.0.1:${PORT}`);

  // A. Drip: relayer pays gas, user receives 10,000 testnet AUSD from the Agora faucet.
  const info = await api.info();
  check('GET /info', info.relayer === relayerAccount.address, info);
  const a0 = await bal(user.address);
  const drip = await api.drip(user.address);
  const a1 = await bal(user.address);
  results.drip = drip;
  check('POST /drip minted AUSD to user via faucet (relayer float empty, relayer paid gas)',
    a1 - a0 === parseUnits('10000', 6) && drip.ausdSource === 'agora-faucet', {
    ausd: formatAusd(a1), source: drip.ausdSource, gasUsed: drip.gasUsed, gasLimit: drip.gasLimit, latencyMs: drip.latencyMs,
  });
  // A2. The faucet has ONE global 60 s cooldown: a second drip right away must fail cleanly (429).
  const user2 = privateKeyToAccount(generatePrivateKey());
  if (!LIVE) {
    await expectError('second drip within 60 s -> clean 429 (faucet global cooldown)', api.drip(user2.address), /cooling down/);
    await test.increaseTime({ seconds: 61 });
    await test.mine({ blocks: 1 });
    const refill = await core.refill();
    results.refill = refill;
    check('relayer refill() pulled 10,000 AUSD float from faucet', refill.ok, refill);
    const d2 = await api.drip(user2.address);
    results.dripFromFloat = d2;
    check('drip #2 paid 1,000 AUSD from relayer float (no faucet dependency)',
      d2.ausdSource === 'relayer-float' && (await bal(user2.address)) === parseUnits('1000', 6), {
      gasUsed: d2.gasUsed, gasLimit: d2.gasLimit, latencyMs: d2.latencyMs,
    });
  }
  check('user still has 0 MON after drip', (await mon(user.address)) === 0n);

  // B. Gasless deposit: user signs TransferWithAuthorization (exact PWA code path), relayer submits.
  const value = parseUnits('25', 6);
  const auth = newAuthorization({ from: user.address, to: VAULT_STANDIN, value, ttlSeconds: 600 });
  const t0 = performance.now();
  const sig = await userWallet.signTypedData({ account: user, ...authorizationTypedData('transfer', CHAIN_ID, auth) });
  const signMs = performance.now() - t0;
  const wire = toWire('transfer', CHAIN_ID, auth, sig);
  const v0 = await bal(VAULT_STANDIN);
  const r = await api.relay(wire);
  const v1 = await bal(VAULT_STANDIN);
  const u2 = await bal(user.address);
  results.transferWithAuthorization = { ...r, signMs: Math.round(signMs) };
  check('relayed transferWithAuthorization moved 25 AUSD user -> vault', v1 - v0 === value && a1 - u2 === value, {
    tx: r.txHash, gasUsed: r.gasUsed, gasLimit: r.gasLimit, latencyMs: r.latencyMs,
  });
  check('user paid 0 MON for the deposit', (await mon(user.address)) === 0n);
  check('authorizationState(user, nonce) == true',
    await pub.readContract({ address: AUSD, abi: ausdAbi, functionName: 'authorizationState', args: [user.address, auth.nonce] }));

  // C. Replay: relayer policy rejects; onchain also rejects.
  await expectError('replay rejected by relayer policy', api.relay(wire), /already used/);
  await expectError('replay rejected onchain (AUSD)', pub.simulateContract({
    account: relayerAccount, address: AUSD, abi: ausdAbi, functionName: 'transferWithAuthorization',
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig],
  }), /revert|reverted|Error/i);

  // D. Tampered amount: same signature, bigger value.
  const auth2 = newAuthorization({ from: user.address, to: VAULT_STANDIN, value, ttlSeconds: 600 });
  const sig2 = await userWallet.signTypedData({ account: user, ...authorizationTypedData('transfer', CHAIN_ID, auth2) });
  const tampered = { ...toWire('transfer', CHAIN_ID, auth2, sig2), value: parseUnits('26', 6).toString() };
  await expectError('tampered value rejected by relayer (sig mismatch)', api.relay(tampered), /signature/);
  await expectError('tampered value rejected onchain (AUSD)', pub.simulateContract({
    account: relayerAccount, address: AUSD, abi: ausdAbi, functionName: 'transferWithAuthorization',
    args: [auth2.from, auth2.to, parseUnits('26', 6), auth2.validAfter, auth2.validBefore, auth2.nonce, sig2],
  }), /revert|reverted|Error/i);

  // E. Destination outside allowlist.
  const rogue = newAuthorization({ from: user.address, to: '0x000000000000000000000000000000000000dEaD', value, ttlSeconds: 600 });
  const rogueSig = await userWallet.signTypedData({ account: user, ...authorizationTypedData('transfer', CHAIN_ID, rogue) });
  await expectError('non-allowlisted destination rejected', api.relay(toWire('transfer', CHAIN_ID, rogue, rogueSig)), /not allowlisted/);

  // F. receiveWithAuthorization through a contract (front-run-safe deposit).
  const rv = parseUnits('40', 6);
  const rAuth = newAuthorization({ from: user.address, to: depositor, value: rv, ttlSeconds: 600 });
  const rSig = await userWallet.signTypedData({ account: user, ...authorizationTypedData('receive', CHAIN_ID, rAuth) });
  // front-run attempt: anyone other than `to` calling receiveWithAuthorization must revert
  await expectError('receiveWithAuthorization by non-payee reverts (front-run safe)', pub.simulateContract({
    account: relayerAccount, address: AUSD, abi: ausdAbi, functionName: 'receiveWithAuthorization',
    args: [rAuth.from, rAuth.to, rAuth.value, rAuth.validAfter, rAuth.validBefore, rAuth.nonce, rSig],
  }), /revert|reverted|Error/i);
  const rr = await api.relay(toWire('receive', CHAIN_ID, rAuth, rSig));
  const dep = await pub.readContract({ address: depositor, abi: depositorAbi, functionName: 'deposits', args: [user.address] });
  results.receiveWithAuthorization = rr;
  check('relayed depositWithAuthorization (receiveWithAuthorization) credited 40 AUSD', dep === rv && (await bal(depositor)) === rv, {
    tx: rr.txHash, gasUsed: rr.gasUsed, gasLimit: rr.gasLimit,
  });

  // G. EIP-2612 permit -> depositWithPermit (relayer pays gas).
  const pv = parseUnits('15', 6);
  const pNonce = await pub.readContract({ address: AUSD, abi: ausdAbi, functionName: 'nonces', args: [user.address] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const pSig = await userWallet.signTypedData({
    account: user, ...permitTypedData(CHAIN_ID, { owner: user.address, spender: depositor, value: pv, nonce: pNonce, deadline }),
  });
  const { v, r: pr, s: ps } = parseSignature(pSig);
  const pEst = await pub.estimateContractGas({
    account: relayerAccount, address: depositor, abi: depositorAbi, functionName: 'depositWithPermit',
    args: [user.address, pv, deadline, Number(v), pr, ps],
  });
  const pHash = await relayerWallet.writeContract({
    address: depositor, abi: depositorAbi, functionName: 'depositWithPermit',
    args: [user.address, pv, deadline, Number(v), pr, ps], gas: core.withMargin(pEst),
  });
  const pRc = await pub.waitForTransactionReceipt({ hash: pHash });
  const dep2 = await pub.readContract({ address: depositor, abi: depositorAbi, functionName: 'deposits', args: [user.address] });
  results.permit = { tx: pHash, gasUsed: pRc.gasUsed.toString(), gasLimit: core.withMargin(pEst).toString() };
  check('permit + depositWithPermit credited 15 AUSD', pRc.status === 'success' && dep2 === rv + pv, results.permit);
  check('user still has 0 MON after 3 gasless AUSD movements', (await mon(user.address)) === 0n);
  server.close();

  // H. Phase 2 relayer: MON drip, then the embedded wallet sends its own tx (user pays gas).
  const core2 = createRelayerCore({ ...base, dripMon: parseEther('0.05'), dripAusd: 0n, dripAusdFaucet: false });
  const drip2 = await core2.drip(user.address);
  const m1 = await mon(user.address);
  check('MON drip delivered 0.05 MON', m1 === parseEther('0.05'), { tx: drip2.txHashes, latencyMs: drip2.latencyMs });

  const est = await pub.estimateContractGas({
    account: user, address: AUSD, abi: ausdAbi, functionName: 'transfer', args: [user.address, parseUnits('1', 6)],
  });
  const gasLimit = (est * 115n) / 100n;
  const gasPrice = await pub.getGasPrice();
  const dHash = await userWallet.writeContract({
    address: AUSD, abi: ausdAbi, functionName: 'transfer', args: [user.address, parseUnits('1', 6)], gas: gasLimit,
  });
  const dRc = await pub.waitForTransactionReceipt({ hash: dHash });
  const m2 = await mon(user.address);
  const paid = m1 - m2;
  const eff = dRc.effectiveGasPrice;
  results.directTx = {
    tx: dHash, gasUsed: dRc.gasUsed.toString(), gasLimit: gasLimit.toString(), effectiveGasPrice: eff.toString(),
    paidWei: paid.toString(), paidMON: formatEther(paid),
    billedOn: paid === gasLimit * eff ? 'gas LIMIT (Monad rule)' : paid === dRc.gasUsed * eff ? 'gas USED' : 'other',
    nodeGasPrice: gasPrice.toString(),
  };
  check('direct embedded-wallet tx (AUSD self-transfer) succeeded with user-paid MON', dRc.status === 'success', results.directTx);
}

main().catch((e) => {
  console.error('E2E crashed:', (e as Error).message);
  process.exit(2);
});
