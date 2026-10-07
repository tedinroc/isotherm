// Relayer core: testnet drip (MON + AUSD) and gasless relayed mints. Transport-agnostic and unit-testable:
// the Durable Object wires it to its storage, tests wire it to an anvil fork and an in-memory store.
//
// Every send goes through one queue, so a single relayer EOA never reuses a nonce. Monad specifics:
//   - gas is billed on the LIMIT -> limit = estimate * GAS_MULTIPLIER_PCT / 100 (default 1.08)
//   - reserve balance: an account under 10 MON may only send VALUE in an "emptying" tx (no other tx from it in the
//     previous 3 blocks), so MON drips wait for 4 blocks after the relayer's last tx when it is under that line.
//   - the AUSD faucet has ONE global 60 s cooldown (MaxFrequencyExceeded 0x20e5bc67): drips come from the relayer's
//     own AUSD float; the faucet is only a fallback and a cron refills the float.
import {
  decodeErrorResult,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  hexToSignature,
  isAddress,
  isHex,
  keccak256,
  encodeAbiParameters,
  parseEther,
  recoverTypedDataAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { ABI_BUNDLE, RECEIVE_TYPES, SELECTORS, ausdAbi, decodeSeries, faucetAbi, vaultFragments, vaultV1Abi } from './abi';
import { withMargin, type Pub, type Wallet } from './chain';
import type { Deployments } from './deployments';
import type { Config } from './env';
import { checkDrip, checkRelay, recordDrip, recordRelay, type DripRecord, type Store } from './limits';
import { HttpError, errorMessage } from './util';

const RESERVE_LINE = parseEther('10');

function makeQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export interface RelayMintWire {
  mode: 'permit' | 'authorization';
  chainId: number;
  seriesId: Hex;
  amount: string; // AUSD base units (6 dp)
  holder: Address;
  signature: Hex;
  // permit
  deadline?: string;
  // authorization (EIP-3009 ReceiveWithAuthorization, to = vault)
  validAfter?: string;
  validBefore?: string;
  nonce?: Hex;
  salt?: Hex;
}

export function createRelayer(opts: { cfg: Config; dep: Deployments; pub: Pub; wallet: Wallet | null; store: Store }) {
  const { cfg, dep, pub, wallet, store } = opts;
  const enqueue = makeQueue();
  let lastSendBlock: bigint | null = null;
  const errorAbis: Abi[] = [vaultFragments as Abi, vaultV1Abi as Abi, faucetAbi as Abi, ...Object.values(ABI_BUNDLE)];

  const explain = (e: unknown): string => {
    const seen = new Set<unknown>();
    const find = (x: any): Hex | undefined => {
      if (!x || typeof x !== 'object' || seen.has(x)) return;
      seen.add(x);
      if (typeof x.data === 'string' && x.data.startsWith('0x') && x.data.length >= 10) return x.data as Hex;
      if (typeof x.data === 'object' && typeof x.data?.data === 'string') return x.data.data as Hex;
      return find(x.cause) ?? find(x.error);
    };
    const data = find(e);
    if (data) {
      for (const abi of errorAbis) {
        try {
          const d = decodeErrorResult({ abi, data });
          return `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`;
        } catch {
          /* next */
        }
      }
      if (data.startsWith('0x20e5bc67')) return 'MaxFrequencyExceeded()';
      return `revert ${data.slice(0, 10)}`;
    }
    return errorMessage(e);
  };

  async function relayerLastBlock(): Promise<bigint | null> {
    if (lastSendBlock !== null) return lastSendBlock;
    const s = await store.get<string>('relayer:lastBlock');
    lastSendBlock = s ? BigInt(s) : null;
    return lastSendBlock;
  }
  async function noteSendBlock(b: bigint) {
    if (lastSendBlock === null || b > lastSendBlock) {
      lastSendBlock = b;
      await store.put('relayer:lastBlock', b.toString());
    }
  }

  /** Monad reserve-balance rule: wait until the relayer's previous tx is ≥4 blocks old before a value transfer. */
  async function emptyingWindow(relayerMon: bigint, value: bigint) {
    if (relayerMon >= RESERVE_LINE + value) return;
    const last = await relayerLastBlock();
    if (last === null) return;
    for (let i = 0; i < 40; i++) {
      const head = await pub.getBlockNumber({ cacheTime: 0 });
      if (head >= last + 4n) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // /api/health is public and uncached at the edge; each uncached call costs 3 RPC reads against the public Monad
  // endpoint (about 25 rps per client IP, shared by the drip, relay and scanner). Memoise for a few seconds so a
  // flood of health checks cannot rate-limit the relayer's own RPC traffic (security review v1).
  let infoCache: { at: number; value: ReturnType<typeof infoUncached> } | null = null;
  async function info() {
    if (infoCache && Date.now() - infoCache.at < 5_000) return infoCache.value; // also dedupes in-flight calls
    const entry = { at: Date.now(), value: infoUncached() };
    infoCache = entry;
    entry.value.catch(() => {
      if (infoCache === entry) infoCache = null;
    });
    return entry.value;
  }

  async function infoUncached() {
    const relayer = wallet?.account.address ?? null;
    let mon: bigint | null = null;
    let ausd: bigint | null = null;
    let head: bigint | null = null;
    try {
      head = await pub.getBlockNumber();
      if (relayer) {
        [mon, ausd] = await Promise.all([
          pub.getBalance({ address: relayer }),
          pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: 'balanceOf', args: [relayer] }),
        ]);
      }
    } catch {
      /* RPC trouble: report what we have */
    }
    return {
      relayer,
      chainId: cfg.chainId,
      head: head?.toString() ?? null,
      monBalance: mon === null ? null : formatEther(mon),
      ausdFloat: ausd === null ? null : formatUnits(ausd, 6),
      dripEnabled: cfg.dripEnabled && !!wallet,
      dripReady: !!wallet && mon !== null && mon >= cfg.dripMon + cfg.relayerMinMon,
      dripMon: formatEther(cfg.dripMon),
      dripAusd: formatUnits(cfg.dripAusd, 6),
      relayEnabled: cfg.relayEnabled && !!wallet,
      relayModes: await relayModes().catch(() => []),
      relayMaxAusd: formatUnits(cfg.relayMaxAusd, 6),
      deployments: dep.source,
      vault: dep.vault,
      zap: dep.zap,
      resolver: dep.resolver,
      dripsTotal: (await store.get<number>('drip:total')) ?? 0,
      relayedTotal: (await store.get<number>('relay:total')) ?? 0,
    };
  }

  /** Which relay paths the deployed vault supports, detected from its bytecode (dispatcher PUSH4 selectors), so the
   *  API stays correct whether it points at the feasibility vault (permit only) or v1 (EIP-3009 + permit). */
  let modesCache: { at: number; modes: string[] } | null = null;
  async function relayModes(): Promise<string[]> {
    if (modesCache && Date.now() - modesCache.at < 600_000) return modesCache.modes;
    const code = (await pub.getCode({ address: dep.vault }).catch(() => undefined)) ?? '0x';
    const has = (sel: string) => bytecodeHasSelector(code, sel);
    const modes: string[] = [];
    if (has(SELECTORS.mintSetWithAuthorization)) modes.push('authorization');
    if (has(SELECTORS.mintSetWithPermit)) modes.push('permit');
    modesCache = { at: Date.now(), modes };
    return modes;
  }

  // ------------------------------------------------------------------------------------------- drip
  async function drip(addressRaw: string, ip: string) {
    if (cfg.chainId !== 10143) throw new HttpError(400, 'drip is testnet-only');
    if (typeof addressRaw !== 'string' || !isAddress(addressRaw)) throw new HttpError(400, 'bad address');
    const user = getAddress(addressRaw);
    if (BigInt(user) < 0x10000n) throw new HttpError(400, 'bad address (zero / precompile range)');
    if (!cfg.dripEnabled) throw new HttpError(503, 'drip is paused');
    if (!wallet) throw new HttpError(503, 'relayer not configured');
    const relayer = wallet.account.address;
    if (user === relayer) throw new HttpError(400, 'bad address');

    return enqueue(async () => {
      const t0 = Date.now();
      const decision = await checkDrip(store, {
        dailyCap: cfg.dripDailyCap,
        perIpPerDay: cfg.dripPerIpPerDay,
        addressCooldownMs: cfg.dripAddressCooldownMs,
      }, user, ip);
      if (!decision.ok) throw new HttpError(decision.status, decision.reason, { retryAfterSec: decision.retryAfterSec });

      const code = await pub.getCode({ address: user });
      if (code && code !== '0x') throw new HttpError(400, 'contracts (and delegated accounts) cannot receive drips');

      const [userMon, userAusd, relMon, relAusd] = await Promise.all([
        pub.getBalance({ address: user }),
        pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: 'balanceOf', args: [user] }),
        pub.getBalance({ address: relayer }),
        pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: 'balanceOf', args: [relayer] }),
      ]);
      const monToSend = !decision.retryOfPending && userMon < cfg.dripMon ? cfg.dripMon - userMon : 0n;
      const wantAusd = userAusd < cfg.dripAusd;
      if (monToSend === 0n && !wantAusd) {
        if (decision.retryOfPending && decision.record) {
          await recordDrip(store, user, ip, { ...decision.record, ausdPending: false }, false);
        }
        return { ok: true, alreadyFunded: true, txHashes: [] as Hex[], latencyMs: Date.now() - t0 };
      }
      if (relMon < monToSend + cfg.relayerMinMon) {
        throw new HttpError(503, 'The faucet relayer is out of test MON right now; please try again later.', { relayer });
      }

      const hashes: Hex[] = [];
      let monTx: Hex | undefined;
      let ausdTx: Hex | undefined;
      let ausdSource: 'relayer-float' | 'agora-faucet' | 'none' = 'none';
      let ausdPending = false;
      let retryAfterSec: number | undefined;

      // 1) MON first: it may need the "emptying transaction" window.
      if (monToSend > 0n) await emptyingWindow(relMon, monToSend);
      // Nonces are counted locally inside this queued job. Monad's RPC does not include a just-submitted tx in
      // eth_getTransactionCount('pending') (checked live 2026-10-07: still n right after sending nonce n), so
      // re-reading it for the AUSD leg reused the MON tx's nonce and the AUSD transfer was rejected
      // ("Missing or invalid parameters"). Read once, then increment.
      let nonce = await pub.getTransactionCount({ address: relayer, blockTag: 'pending' });
      if (monToSend > 0n) {
        monTx = await wallet.sendTransaction({ to: user, value: monToSend, gas: 21_000n, nonce, account: wallet.account, chain: wallet.chain });
        hashes.push(monTx);
        nonce += 1;
      }
      // 2) AUSD: relayer float, else the faucet (straight to the user).
      if (wantAusd) {
        try {
          if (relAusd >= cfg.dripAusd) {
            const req = { address: dep.ausd, abi: ausdAbi, functionName: 'transfer', args: [user, cfg.dripAusd] } as const;
            const est = await pub.estimateContractGas({ ...req, account: wallet.account });
            ausdTx = await wallet.writeContract({ ...req, gas: withMargin(est, cfg.gasMultiplierPct), nonce, account: wallet.account, chain: wallet.chain });
            ausdSource = 'relayer-float';
          } else {
            const req = { address: dep.ausdFaucet, abi: faucetAbi, functionName: 'requestFunds', args: [user] } as const;
            try {
              const est = await pub.estimateContractGas({ ...req, account: wallet.account });
              ausdTx = await wallet.writeContract({ ...req, gas: withMargin(est, cfg.gasMultiplierPct), nonce, account: wallet.account, chain: wallet.chain });
              ausdSource = 'agora-faucet';
            } catch (e) {
              const why = explain(e);
              if (!/MaxFrequencyExceeded/.test(why)) throw new HttpError(502, `AUSD faucet failed: ${why}`);
              ausdPending = true;
              retryAfterSec = 60;
            }
          }
        } catch (e) {
          // If MON already went out, never lose that fact: record the drip as AUSD-pending so a retry sends only the
          // AUSD leg (checkDrip -> retryOfPending -> monToSend = 0). Otherwise a failed AUSD leg left no record and
          // every retry sent MON again.
          if (!monTx) throw e;
          ausdPending = true;
          retryAfterSec = 30;
        }
        if (ausdTx) hashes.push(ausdTx);
      }

      const receipts = await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 45_000 })));
      for (const r of receipts) await noteSendBlock(r.blockNumber);
      const failed = receipts.find((r) => r.status !== 'success');
      if (failed) throw new HttpError(502, `drip transaction reverted: ${failed.transactionHash}`);

      if (monTx || ausdTx || ausdPending) {
        const rec: DripRecord = {
          at: decision.ok && decision.record ? decision.record.at : Date.now(),
          monTx: monTx ?? decision.record?.monTx,
          ausdTx,
          ausdPending,
        };
        await recordDrip(store, user, ip, rec, !decision.retryOfPending);
      }
      return {
        ok: true,
        address: user,
        monSent: formatEther(monToSend),
        ausdSent: ausdTx ? (ausdSource === 'agora-faucet' ? '10000' : formatUnits(cfg.dripAusd, 6)) : '0',
        ausdSource,
        ausdPending,
        retryAfterSec,
        txHashes: hashes,
        gasUsed: receipts.map((r) => r.gasUsed.toString()),
        latencyMs: Date.now() - t0,
      };
    });
  }

  /** Cron: keep an AUSD float so drips do not hit the faucet's global cooldown. At most one faucet call. */
  async function refill() {
    if (!wallet) return { ok: false, reason: 'no relayer key' };
    return enqueue(async () => {
      const relayer = wallet.account.address;
      const [mon, bal] = await Promise.all([
        pub.getBalance({ address: relayer }),
        pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: 'balanceOf', args: [relayer] }),
      ]);
      if (bal >= cfg.ausdFloatTarget) return { ok: true, skipped: 'float full', float: formatUnits(bal, 6) };
      if (mon < cfg.relayerMinMon) return { ok: false, skipped: 'relayer MON below minimum', float: formatUnits(bal, 6) };
      const req = { address: dep.ausdFaucet, abi: faucetAbi, functionName: 'requestFunds', args: [relayer] } as const;
      let est: bigint;
      try {
        est = await pub.estimateContractGas({ ...req, account: wallet.account });
      } catch (e) {
        return { ok: false, skipped: explain(e), float: formatUnits(bal, 6) };
      }
      const nonce = await pub.getTransactionCount({ address: relayer, blockTag: 'pending' });
      const hash = await wallet.writeContract({ ...req, gas: withMargin(est, cfg.gasMultiplierPct), nonce, account: wallet.account, chain: wallet.chain });
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 45_000 });
      await noteSendBlock(r.blockNumber);
      return { ok: r.status === 'success', txHash: hash, float: formatUnits(bal + 10_000_000_000n, 6) };
    });
  }

  // ------------------------------------------------------------------------------------------- relayed mint
  async function readSeries(seriesId: Hex) {
    const data = await pub.call({
      to: dep.vault,
      data: encodeFunctionData({ abi: vaultFragments, functionName: 'getSeries', args: [seriesId] }),
    });
    return data.data ? decodeSeries(data.data) : null;
  }

  function ausdDomain() {
    return { name: 'Agora Dollar', version: '1', chainId: cfg.chainId, verifyingContract: dep.ausd } as const;
  }

  async function relayMint(w: RelayMintWire) {
    if (!cfg.relayEnabled) throw new HttpError(503, 'relayed mint is paused');
    if (!wallet) throw new HttpError(503, 'relayer not configured');
    if (!w || typeof w !== 'object') throw new HttpError(400, 'bad body');
    if (Number(w.chainId) !== cfg.chainId) throw new HttpError(400, `wrong chain ${w.chainId}`);
    if (!isHex(w.seriesId) || w.seriesId.length !== 66) throw new HttpError(400, 'bad seriesId');
    if (!isAddress(w.holder)) throw new HttpError(400, 'bad holder');
    if (!isHex(w.signature) || (w.signature.length !== 132 && w.signature.length !== 130)) throw new HttpError(400, 'bad signature');
    let amount: bigint;
    try {
      amount = BigInt(w.amount);
    } catch {
      throw new HttpError(400, 'bad amount');
    }
    if (amount <= 0n || amount > cfg.relayMaxAusd) throw new HttpError(400, `amount must be between 0 and ${formatUnits(cfg.relayMaxAusd, 6)} AUSD`);
    const holder = getAddress(w.holder);
    const now = BigInt(Math.floor(Date.now() / 1000));

    const series = await readSeries(w.seriesId);
    if (!series) throw new HttpError(400, 'unknown series');
    if (BigInt(series.closeTime) <= now + 15n) throw new HttpError(400, 'this strike is closed for new positions');
    if (series.gated) throw new HttpError(400, 'this series is gated (allowlist only)');
    const lim = await checkRelay(store, { perAddressPerDay: cfg.relayPerAddressPerDay, dailyCap: cfg.relayDailyCap }, holder);
    if (!lim.ok) throw new HttpError(429, lim.reason);
    const bal = await pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: 'balanceOf', args: [holder] });
    if (bal < amount) throw new HttpError(400, `insufficient AUSD (${formatUnits(bal, 6)})`);

    let call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };
    if (w.mode === 'permit') {
      if (!(await relayModes()).includes('permit')) throw new HttpError(400, 'permit mode not supported by this vault');
      const deadline = BigInt(w.deadline ?? '0');
      if (deadline <= now + 15n || deadline > now + 3600n) throw new HttpError(400, 'permit deadline must be within the next hour');
      const nonce = await pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: 'nonces', args: [holder] });
      const signer = await recoverTypedDataAddress({
        domain: ausdDomain(),
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: { owner: holder, spender: dep.vault, value: amount, nonce, deadline },
        signature: w.signature,
      }).catch(() => null);
      if (signer !== holder) throw new HttpError(400, 'signature does not match holder');
      const sig = hexToSignature(w.signature);
      const v = Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0)));
      call = {
        address: dep.vault,
        abi: vaultFragments as Abi,
        functionName: 'mintSetWithPermit',
        args: [w.seriesId, amount, holder, deadline, v, sig.r, sig.s],
      };
    } else if (w.mode === 'authorization') {
      if (!(await relayModes()).includes('authorization')) throw new HttpError(400, 'authorization mode not supported by this vault');
      const validAfter = BigInt(w.validAfter ?? '0');
      const validBefore = BigInt(w.validBefore ?? '0');
      if (validAfter > now) throw new HttpError(400, 'authorization not yet valid');
      if (validBefore <= now + 15n || validBefore > now + 3600n) throw new HttpError(400, 'authorization must expire within the next hour');
      if (!w.salt || !isHex(w.salt) || w.salt.length !== 66) throw new HttpError(400, 'bad salt');
      const nonce = authorizationNonce(w.seriesId, amount, w.salt);
      const used = await pub.readContract({ address: dep.ausd, abi: ausdAbi, functionName: 'authorizationState', args: [holder, nonce] });
      if (used) throw new HttpError(400, 'authorization already used');
      const signer = await recoverTypedDataAddress({
        domain: ausdDomain(),
        types: RECEIVE_TYPES,
        primaryType: 'ReceiveWithAuthorization',
        message: { from: holder, to: dep.vault, value: amount, validAfter, validBefore, nonce },
        signature: w.signature,
      }).catch(() => null);
      if (signer !== holder) throw new HttpError(400, 'signature does not match holder');
      const sig = hexToSignature(w.signature);
      const v = Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0)));
      call = {
        address: dep.vault,
        abi: vaultV1Abi as Abi,
        functionName: 'mintSetWithAuthorization',
        args: [w.seriesId, amount, holder, validAfter, validBefore, w.salt, v, sig.r, sig.s],
      };
    } else {
      throw new HttpError(400, 'mode must be "authorization" or "permit"');
    }

    return enqueue(async () => {
      const t0 = Date.now();
      // Re-check the caps inside the single-sender queue (security review v1). The check above runs before several
      // RPC awaits, so concurrent requests all passed it before any recordRelay() ran: 8 parallel requests for one
      // holder were all broadcast against a per-address cap of 2, and the daily cap could be overrun the same way.
      // Jobs run one at a time and recordRelay() happens before the next job starts, so this check is exact.
      const capNow = await checkRelay(store, { perAddressPerDay: cfg.relayPerAddressPerDay, dailyCap: cfg.relayDailyCap }, holder);
      if (!capNow.ok) throw new HttpError(429, capNow.reason);
      const relayer = wallet.account.address;
      const mon = await pub.getBalance({ address: relayer });
      if (mon < cfg.relayerMinMon / 2n) throw new HttpError(503, 'The relayer is out of test MON right now.');
      let est: bigint;
      try {
        est = await pub.estimateContractGas({ ...call, account: wallet.account } as never);
      } catch (e) {
        throw new HttpError(400, `mint would fail: ${explain(e)}`);
      }
      const gas = withMargin(est, cfg.gasMultiplierPct);
      const nonce = await pub.getTransactionCount({ address: relayer, blockTag: 'pending' });
      const hash = await wallet.writeContract({ ...call, gas, nonce, account: wallet.account, chain: wallet.chain } as never);
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 45_000 });
      await noteSendBlock(r.blockNumber);
      if (r.status !== 'success') throw new HttpError(502, `relayed mint reverted: ${hash}`);
      await recordRelay(store, holder);
      return {
        ok: true,
        mode: w.mode,
        txHash: hash,
        gasUsed: r.gasUsed.toString(),
        gasLimit: gas.toString(),
        estimate: est.toString(),
        latencyMs: Date.now() - t0,
      };
    });
  }

  return { info, drip, refill, relayMint, relayModes, explain };
}

/** EIP-3009 nonce for CollateralVault.mintSetWithAuthorization: keccak256(abi.encode(seriesId, amount, salt)), the
 *  same as the vault's mintAuthorizationNonce(). The vault recomputes it, so a front-runner cannot re-target the
 *  authorization to another series or amount. */
export function authorizationNonce(seriesId: Hex, amount: bigint, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }], [seriesId, amount, salt]));
}

/** True when runtime bytecode contains the dispatcher push of `selector` (PUSH4, or PUSH3 for a leading 00 byte). */
export function bytecodeHasSelector(code: string, selector: string): boolean {
  const c = code.toLowerCase();
  const sel = selector.slice(2).toLowerCase();
  if (c.includes(`63${sel}`)) return true;
  return sel.startsWith('00') && c.includes(`62${sel.slice(2)}`);
}

export type Relayer = ReturnType<typeof createRelayer>;
