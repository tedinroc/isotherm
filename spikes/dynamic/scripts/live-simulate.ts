// Read-only proof against the LIVE Monad testnet (no transaction is broadcast, no MON spent):
// eth_simulateV1 runs [faucet.requestFunds(user), AUSD.transferWithAuthorization(user->vault)]
// in one simulated block on top of the current chain head, with the signature produced by a
// fresh local key (= a brand-new Dynamic embedded wallet holding 0 MON).
//
//   npx tsx scripts/live-simulate.ts
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseUnits, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { AUSD_ADDRESS, AUSD_TESTNET_FAUCET, ausdAbi, authorizationTypedData, faucetAbi, newAuthorization } from '../src/lib/ausd';

const RPC = process.env.LIVE_RPC ?? 'https://testnet-rpc.monad.xyz';
const RELAYER: Address = '0xb855f2bCA7C12Db2aA9D70740c6cF40808325c11'; // deployer address; no key needed for a simulation
const VAULT: Address = '0x029049a9dA77231dd86A90E52Fd6Db542424e727';
const AUSD = AUSD_ADDRESS[10143];

const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC) });
const user = privateKeyToAccount(generatePrivateKey());
const value = parseUnits('25', 6);
const auth = newAuthorization({ from: user.address, to: VAULT, value, ttlSeconds: 600 });
const signature = await user.signTypedData(authorizationTypedData('transfer', 10143, auth));

const head = await pub.getBlockNumber();
const [block] = await pub.simulateBlocks({
  blocks: [
    {
      calls: [
        { account: RELAYER, to: AUSD_TESTNET_FAUCET, data: encodeFunctionData({ abi: faucetAbi, functionName: 'requestFunds', args: [user.address] }) },
        {
          account: RELAYER,
          to: AUSD,
          data: encodeFunctionData({
            abi: ausdAbi,
            functionName: 'transferWithAuthorization',
            args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature],
          }),
        },
        { account: RELAYER, to: AUSD, data: encodeFunctionData({ abi: ausdAbi, functionName: 'balanceOf', args: [user.address] }) },
        { account: RELAYER, to: AUSD, data: encodeFunctionData({ abi: ausdAbi, functionName: 'authorizationState', args: [user.address, auth.nonce] }) },
      ],
    },
  ],
});

const [faucet, relay, balCall, stateCall] = block.calls;
const userBal = decodeFunctionResult({ abi: ausdAbi, functionName: 'balanceOf', data: balCall.data });
const used = decodeFunctionResult({ abi: ausdAbi, functionName: 'authorizationState', data: stateCall.data });
const out = {
  rpc: RPC,
  simulatedOnTopOfBlock: head.toString(),
  user: user.address,
  userMON: (await pub.getBalance({ address: user.address })).toString(),
  faucet: { status: faucet.status, gasUsed: faucet.gasUsed.toString(), error: faucet.error?.message.split('\n')[0] },
  transferWithAuthorization: { status: relay.status, gasUsed: relay.gasUsed.toString(), error: relay.error?.message.split('\n')[0] },
  userAusdAfter: userBal.toString(),
  authorizationUsed: used,
};
console.log(JSON.stringify(out, null, 2));
const ok = faucet.status === 'success' && relay.status === 'success' && userBal === parseUnits('10000', 6) - value && used === true;
console.log(ok ? 'LIVE SIMULATION PASS' : 'LIVE SIMULATION FAIL');
process.exit(ok ? 0 : 1);
