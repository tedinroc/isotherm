// Isotherm gasless-onboarding relayer core (transport-agnostic, unit-testable).
//
//  - drip(address):  relayer wallet pays gas to (a) mint testnet AUSD to the user via the
//                    Agora faucet and (b) send a small amount of MON so the user can also
//                    transact directly from their Dynamic embedded wallet.
//  - relay(auth):    user signs an EIP-3009 authorization in the PWA (no gas); the relayer
//                    verifies it off-chain against policy, simulates, and submits it with a
//                    tight gas limit (Monad bills the gas LIMIT, not gas used).
//
// The relayer signer is any viem WalletClient: a local key (works today) or a Dynamic
// server wallet (`DynamicEvmWalletClient.getWalletClient`, see signer.ts).
import {
  getAddress,
  isAddress,
  parseAbi,
  hashTypedData,
  recoverAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import {
  AUSD_ADDRESS,
  AUSD_TESTNET_FAUCET,
  ausdAbi,
  authorizationTypedData,
  faucetAbi,
  formatAusd,
  fromWire,
  type AuthorizationWire,
} from '../src/lib/ausd';

export const depositorAbi = parseAbi([
  'function depositWithAuthorization(address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function depositWithPermit(address owner, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function deposits(address) view returns (uint256)',
]);

export interface RelayerConfig {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  signerKind: 'local-key' | 'dynamic-server-wallet';
  chainId: number;
  /** Default destination for gasless deposits (Isotherm vault / series contract). */
  depositTo: Address;
  /** Allowed `to` for TransferWithAuthorization. */
  allowedTransferTo: Address[];
  /** Contracts that call receiveWithAuthorization (to == contract) via depositWithAuthorization. */
  allowedReceivers: Address[];
  maxRelayValue: bigint; // AUSD base units
  maxTtlSeconds: number;
  dripMon: bigint;
  /** AUSD per drip from the relayer float (falls back to the faucet's fixed 10,000 when the float is empty). */
  dripAusd: bigint;
  dripAusdFaucet: boolean;
  dripCooldownMs: number;
  gasMarginPct: number; // e.g. 15 => limit = estimate * 1.15
}

export class PolicyError extends Error {
  status = 400;
}

/** Serialise all sends through one queue so a single relayer EOA never reuses a nonce. */
function makeQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createRelayerCore(cfg: RelayerConfig) {
  const { publicClient, walletClient } = cfg;
  const account = walletClient.account;
  const ausd = AUSD_ADDRESS[cfg.chainId];
  const enqueue = makeQueue();
  const lastDrip = new Map<string, number>();
  const withMargin = (g: bigint) => (g * BigInt(100 + cfg.gasMarginPct) + 99n) / 100n;

  async function info() {
    const [mon, bal] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.readContract({ address: ausd, abi: ausdAbi, functionName: 'balanceOf', args: [account.address] }),
    ]);
    return {
      relayer: account.address,
      chainId: cfg.chainId,
      monBalance: (Number(mon) / 1e18).toFixed(4),
      ausdBalance: formatAusd(bal),
      signer: cfg.signerKind,
      depositTo: cfg.depositTo,
      maxRelayAusd: formatAusd(cfg.maxRelayValue),
    };
  }

  /** The Agora testnet faucet has ONE global cooldown (60 s, shared by every caller on
   *  the testnet) and mints 10,000 AUSD per call. Map its revert to a retryable 429. */
  async function faucetRequest(to: Address, nonce: number) {
    let est: bigint;
    try {
      est = await publicClient.estimateContractGas({
        address: AUSD_TESTNET_FAUCET, abi: faucetAbi, functionName: 'requestFunds', args: [to], account,
      });
    } catch (e) {
      const m = (e as Error).message;
      if (/MaxFrequencyExceeded|0x20e5bc67/.test(m)) {
        const err = new PolicyError('AUSD faucet cooling down (global 60 s limit); retry shortly');
        err.status = 429;
        throw err;
      }
      throw e;
    }
    const hash = await walletClient.writeContract({
      address: AUSD_TESTNET_FAUCET, abi: faucetAbi, functionName: 'requestFunds', args: [to],
      gas: withMargin(est), nonce, chain: walletClient.chain, account,
    });
    return { hash, gasLimit: withMargin(est) };
  }

  /** Top up the relayer's own AUSD float from the faucet (call at most once a minute). */
  async function refill() {
    return enqueue(async () => {
      const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
      const { hash, gasLimit } = await faucetRequest(account.address, nonce);
      const r = await publicClient.waitForTransactionReceipt({ hash });
      return { ok: r.status === 'success', txHash: hash, gasUsed: r.gasUsed.toString(), gasLimit: gasLimit.toString() };
    });
  }

  async function drip(addressRaw: string) {
    if (cfg.chainId !== 10143) throw new PolicyError('drip is testnet-only');
    if (!isAddress(addressRaw)) throw new PolicyError('bad address');
    const user = getAddress(addressRaw);
    const prev = lastDrip.get(user) ?? 0;
    if (Date.now() - prev < cfg.dripCooldownMs) throw new PolicyError('already dripped recently');
    lastDrip.set(user, Date.now());
    const t0 = Date.now();
    return enqueue(async () => {
      const hashes: Hex[] = [];
      const limits: string[] = [];
      let source = 'none';
      let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
      if (cfg.dripAusd > 0n) {
        const float = await publicClient.readContract({
          address: ausd, abi: ausdAbi, functionName: 'balanceOf', args: [account.address],
        });
        if (float >= cfg.dripAusd) {
          // preferred: pay from the relayer's float (no dependency on the shared faucet cooldown)
          const est = await publicClient.estimateContractGas({
            address: ausd, abi: ausdAbi, functionName: 'transfer', args: [user, cfg.dripAusd], account,
          });
          hashes.push(await walletClient.writeContract({
            address: ausd, abi: ausdAbi, functionName: 'transfer', args: [user, cfg.dripAusd],
            gas: withMargin(est), nonce: nonce++, chain: walletClient.chain, account,
          }));
          limits.push(withMargin(est).toString());
          source = 'relayer-float';
        } else if (cfg.dripAusdFaucet) {
          const { hash, gasLimit } = await faucetRequest(user, nonce++);
          hashes.push(hash);
          limits.push(gasLimit.toString());
          source = 'agora-faucet';
        }
      }
      const monBal = await publicClient.getBalance({ address: user });
      if (cfg.dripMon > 0n && monBal < cfg.dripMon) {
        hashes.push(await walletClient.sendTransaction({
          to: user, value: cfg.dripMon - monBal, gas: 21000n, nonce: nonce++, chain: walletClient.chain, account,
        }));
        limits.push('21000');
      }
      const receipts = await Promise.all(hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })));
      const failed = receipts.find((r) => r.status !== 'success');
      if (failed) throw new Error(`drip tx reverted: ${failed.transactionHash}`);
      return {
        ok: true,
        ausdSource: source,
        txHashes: hashes,
        gasUsed: receipts.map((r) => r.gasUsed.toString()).join(','),
        gasLimit: limits.join(','),
        latencyMs: Date.now() - t0,
      };
    }).catch((e) => {
      lastDrip.delete(user); // a failed drip must not lock the user out
      throw e;
    });
  }

  /** Off-chain checks shared by both authorization kinds. Returns the parsed authorization. */
  async function check(wire: AuthorizationWire) {
    if (wire.chainId !== cfg.chainId) throw new PolicyError(`wrong chain ${wire.chainId}`);
    if (wire.kind !== 'transfer' && wire.kind !== 'receive') throw new PolicyError('bad kind');
    for (const k of ['from', 'to'] as const) if (!isAddress(wire[k])) throw new PolicyError(`bad ${k}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(wire.nonce)) throw new PolicyError('bad nonce');
    if (!/^0x[0-9a-fA-F]+$/.test(wire.signature)) throw new PolicyError('bad signature encoding');
    const { kind, auth, signature } = fromWire(wire);
    const to = getAddress(auth.to);
    const allowed = kind === 'transfer' ? cfg.allowedTransferTo : cfg.allowedReceivers;
    if (!allowed.some((a) => getAddress(a) === to)) throw new PolicyError(`destination ${to} not allowlisted for ${kind}`);
    if (auth.value <= 0n || auth.value > cfg.maxRelayValue) throw new PolicyError('value outside relay cap');
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (auth.validAfter > now) throw new PolicyError('not yet valid');
    if (auth.validBefore <= now + 5n) throw new PolicyError('expired / expiring');
    if (auth.validBefore - now > BigInt(cfg.maxTtlSeconds)) throw new PolicyError('ttl too long');

    const digest =
      kind === 'transfer'
        ? hashTypedData(authorizationTypedData('transfer', cfg.chainId, auth))
        : hashTypedData(authorizationTypedData('receive', cfg.chainId, auth));
    // Dynamic embedded wallets are plain secp256k1 EOAs (TSS-MPC) -> ecrecover is enough.
    // Smart-account signers (ERC-1271/6492) fall back to an onchain check.
    const recovered = await recoverAddress({ hash: digest, signature }).catch(() => null);
    if (recovered?.toLowerCase() !== auth.from.toLowerCase()) {
      const ok = await publicClient.verifyHash({ address: auth.from, hash: digest, signature }).catch(() => false);
      if (!ok) throw new PolicyError('signature does not match `from`');
    }
    const used = await publicClient.readContract({
      address: ausd, abi: ausdAbi, functionName: 'authorizationState', args: [auth.from, auth.nonce],
    });
    if (used) throw new PolicyError('authorization nonce already used');
    const bal = await publicClient.readContract({ address: ausd, abi: ausdAbi, functionName: 'balanceOf', args: [auth.from] });
    if (bal < auth.value) throw new PolicyError(`insufficient AUSD (${formatAusd(bal)})`);
    return { kind, auth, signature };
  }

  async function relay(wire: AuthorizationWire) {
    const t0 = Date.now();
    const { kind, auth, signature } = await check(wire);
    return enqueue(async () => {
      const req =
        kind === 'transfer'
          ? ({
              address: ausd,
              abi: ausdAbi,
              functionName: 'transferWithAuthorization',
              args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature],
            } as const)
          : ({
              address: auth.to,
              abi: depositorAbi,
              functionName: 'depositWithAuthorization',
              args: [auth.from, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature],
            } as const);
      // simulate == estimate: reverts here never cost the relayer gas
      const est = await publicClient.estimateContractGas({ ...req, account } as never);
      const gas = withMargin(est);
      const hash = await walletClient.writeContract({ ...req, gas, chain: walletClient.chain, account } as never);
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      if (rcpt.status !== 'success') throw new Error(`relay tx reverted: ${hash}`);
      return {
        ok: true,
        txHash: hash,
        gasUsed: rcpt.gasUsed.toString(),
        gasLimit: gas.toString(),
        estimate: est.toString(),
        latencyMs: Date.now() - t0,
      };
    });
  }

  return { info, drip, refill, relay, check, account, withMargin };
}

export type RelayerCore = ReturnType<typeof createRelayerCore>;
