// Read-only readiness check for `make testnet-e2e` (sends nothing).
// Compares live balances with what one MODE=live run needs (logs/live-requirements.json, written by the fork run)
// and prints the funding plan. Exit 0 = ready (the e2e tops up maker/takers from the deployer itself), 2 = not ready.
import { formatEther, type Address } from "viem";
import { join } from "node:path";
import { A, CHAIN_ID, HERE, ROLES, erc20Abi, fmt6, loadAccount, makeClients, readJsonIf, type Role } from "./lib.ts";

const RPC = process.env.RPC ?? "https://testnet-rpc.monad.xyz";
const TRANSFER_MON = 0.0025; // 21k gas x 102 gwei, rounded up

(async () => {
  const { pub } = makeClients(RPC);
  const cid = await pub.getChainId();
  if (cid !== CHAIN_ID) throw new Error(`refusing: chain ${cid} is not Monad testnet ${CHAIN_ID}`);
  const req = readJsonIf<{ perRole: Record<Role, number>; total: number; generatedFrom: string }>(join(HERE, "../logs/live-requirements.json"));
  if (!req) throw new Error("logs/live-requirements.json missing: run `make fork-e2e` first");
  const code = async (a: Address) => ((await pub.getCode({ address: a })) ?? "0x").length > 2;
  const deps = { AUSD: A.ausd, faucet: A.faucet, MockKeystoneForwarder: A.mockForwarder, KuruRouter: A.kuruRouter, KuruMarginAccount: A.marginAccount };
  for (const [n, a] of Object.entries(deps)) if (!(await code(a))) throw new Error(`${n} ${a} has no code on ${RPC}`);
  console.log(`chain ${cid} block ${await pub.getBlockNumber()} via ${RPC}; dependencies have code: ${Object.keys(deps).join(", ")}`);
  console.log(`requirement per run (from ${req.generatedFrom.split("/").slice(-1)[0]}): ${ROLES.map((r) => `${r} ${req.perRole[r]}`).join(", ")} = ${req.total} MON\n`);

  let deficit = 0;
  const have: Record<string, number> = {};
  for (const r of ROLES) {
    const a = loadAccount(r).address;
    have[r] = Number(formatEther(await pub.getBalance({ address: a })));
    const ausd = (await pub.readContract({ address: A.ausd, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as bigint;
    const short = Math.max(0, req.perRole[r] - have[r]);
    if (r !== "deployer" && short > 0) deficit += short + TRANSFER_MON;
    console.log(`${r.padEnd(8)} ${a}  ${have[r].toFixed(4).padStart(9)} MON  need ${req.perRole[r].toFixed(2).padStart(5)}  ${r !== "deployer" && short > 0 ? `top-up ${short.toFixed(4)} from deployer` : ""}  (${fmt6(ausd)} AUSD)`);
  }
  const deployerNeeds = req.perRole.deployer + deficit;
  const ok = have.deployer >= deployerNeeds;
  console.log(`\ndeployer needs ${deployerNeeds.toFixed(4)} MON (own ${req.perRole.deployer} + top-ups ${deficit.toFixed(4)}), has ${have.deployer.toFixed(4)} -> ${ok ? "READY" : `SHORT by ${(deployerNeeds - have.deployer).toFixed(4)} MON`}`);
  if (!ok) {
    console.log(`\nHuman action: claim testnet MON at https://faucet.monad.xyz for the deployer ${loadAccount("deployer").address}, then re-run.`);
    process.exit(2);
  }
  console.log("Make sure no other process is sending from these wallets during the run (nonce races).");
})().catch((e) => {
  console.error(`preflight failed: ${e?.message ?? e}`);
  process.exit(1);
});
