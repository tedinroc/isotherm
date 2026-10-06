import { useCallback, useEffect, useMemo, useState } from 'react';
import { DynamicWidget, useDynamicContext, useIsLoggedIn } from '@dynamic-labs/sdk-react-core';
import { isEthereumWallet } from '@dynamic-labs/ethereum';
import { createPublicClient, http, parseUnits, type Address, type Hex } from 'viem';
import { CHAIN_ID, DEPOSIT_TO, RELAYER_URL } from './config';
import {
  AUSD_ADDRESS,
  ausdAbi,
  authorizationTypedData,
  formatAusd,
  newAuthorization,
  toWire,
} from './lib/ausd';
import { EXPLORER_TX, RPC_URL, viemChains } from './lib/chains';
import { relayer, type RelayerInfo } from './lib/relayerClient';

type LogLine = { t: string; msg: string; tx?: Hex };

const chain = viemChains[CHAIN_ID as keyof typeof viemChains];
const publicClient = createPublicClient({ chain, transport: http(RPC_URL[CHAIN_ID]) });
const api = relayer(RELAYER_URL);
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

export function App() {
  const { primaryWallet, user, handleLogOut } = useDynamicContext();
  const loggedIn = useIsLoggedIn();
  const [mon, setMon] = useState<bigint | null>(null);
  const [ausd, setAusd] = useState<bigint | null>(null);
  const [network, setNetwork] = useState<number | null>(null);
  const [info, setInfo] = useState<RelayerInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);

  const address = primaryWallet?.address as Address | undefined;
  const push = useCallback((msg: string, tx?: Hex) => {
    setLog((l) => [{ t: new Date().toLocaleTimeString(), msg, tx }, ...l].slice(0, 30));
  }, []);

  const refresh = useCallback(async () => {
    if (!address) return;
    const [m, a] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.readContract({ address: AUSD_ADDRESS[CHAIN_ID], abi: ausdAbi, functionName: 'balanceOf', args: [address] }),
    ]);
    setMon(m);
    setAusd(a);
    if (primaryWallet) setNetwork(Number(await primaryWallet.getNetwork()));
  }, [address, primaryWallet]);

  useEffect(() => {
    refresh().catch(() => undefined);
    const id = setInterval(() => refresh().catch(() => undefined), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    api.info().then(setInfo).catch(() => setInfo(null));
  }, []);

  const depositTo = useMemo(() => DEPOSIT_TO ?? info?.depositTo, [info]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      push(`✗ ${label}: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      setBusy(null);
      refresh().catch(() => undefined);
    }
  }

  const switchToMonad = () =>
    run('switch network', async () => {
      await primaryWallet!.switchNetwork(CHAIN_ID);
      push(`switched to chain ${CHAIN_ID}`);
    });

  // 1) Gasless onboarding: relayer (server wallet) pays gas to drip MON + AUSD.
  const getFunds = () =>
    run('drip', async () => {
      const r = await api.drip(address!);
      push(`drip sent (${r.latencyMs ?? '?'} ms)`, r.txHashes?.[0]);
      r.txHashes?.slice(1).forEach((h) => push('drip tx', h));
    });

  // 2) Gasless AUSD deposit: embedded wallet signs EIP-3009, relayer submits.
  const gaslessDeposit = () =>
    run('gasless deposit', async () => {
      if (!primaryWallet || !isEthereumWallet(primaryWallet)) throw new Error('no EVM wallet');
      if (!depositTo) throw new Error('relayer offline and VITE_DEPOSIT_TO unset');
      const wc = await primaryWallet.getWalletClient(String(CHAIN_ID));
      const auth = newAuthorization({ from: address!, to: depositTo, value: parseUnits('5', 6), ttlSeconds: 600 });
      const typed = authorizationTypedData('transfer', CHAIN_ID, auth);
      const t0 = performance.now();
      const signature = await wc.signTypedData({ account: wc.account, ...typed });
      push(`signed TransferWithAuthorization in ${Math.round(performance.now() - t0)} ms (no gas)`);
      const r = await api.relay(toWire('transfer', CHAIN_ID, auth, signature));
      push(`relayed: gasUsed ${r.gasUsed} / limit ${r.gasLimit}, ${r.latencyMs} ms`, r.txHash);
    });

  // 3) Direct embedded-wallet transaction (user pays MON gas) — proves send on Monad.
  const directTx = () =>
    run('direct tx', async () => {
      if (!primaryWallet || !isEthereumWallet(primaryWallet)) throw new Error('no EVM wallet');
      const wc = await primaryWallet.getWalletClient(String(CHAIN_ID));
      const args = [address!, parseUnits('1', 6)] as const;
      const est = await publicClient.estimateContractGas({
        address: AUSD_ADDRESS[CHAIN_ID], abi: ausdAbi, functionName: 'transfer', args, account: address!,
      });
      // Monad bills the gas LIMIT, so keep the margin tight.
      const gas = (est * 115n) / 100n;
      const hash = await wc.writeContract({
        address: AUSD_ADDRESS[CHAIN_ID], abi: ausdAbi, functionName: 'transfer', args, gas, chain, account: wc.account,
      });
      push(`self-transfer 1 AUSD, gas limit ${gas}`, hash);
    });

  const onMonad = network === CHAIN_ID;

  return (
    <main className="shell">
      <header className="top">
        <span className="brand">Isotherm</span>
        <span className="pill">{CHAIN_ID === 10143 ? 'Monad testnet' : `chain ${CHAIN_ID}`}</span>
      </header>

      <section className="hero">
        <p className="eyebrow">Taipei · RCSS · Tmax ladder</p>
        <h1>Will Taipei hit 33°C tomorrow?</h1>
        <p className="muted">Sign in with email or Google. You get a wallet; no seed phrase, no gas to start.</p>
      </section>

      <section className="card">
        <DynamicWidget />
        {loggedIn && (
          <div className="kv">
            <span>User</span><b>{user?.email ?? user?.userId?.slice(0, 8)}</b>
            <span>Wallet</span><b className="mono">{short(address)}</b>
            <span>Type</span><b>{primaryWallet?.connector?.key ?? '—'}</b>
            <span>Network</span><b>{network ?? '—'} {onMonad ? '✓' : ''}</b>
            <span>MON</span><b>{mon === null ? '—' : (Number(mon) / 1e18).toFixed(4)}</b>
            <span>AUSD</span><b>{ausd === null ? '—' : formatAusd(ausd)}</b>
          </div>
        )}
      </section>

      {loggedIn && (
        <section className="card actions">
          {!onMonad && (
            <button disabled={!!busy} onClick={switchToMonad}>Switch to Monad testnet</button>
          )}
          <button disabled={!!busy} onClick={getFunds}>1 · Get test funds (relayer pays gas)</button>
          <button disabled={!!busy || !ausd} onClick={gaslessDeposit}>2 · Deposit 5 AUSD — gasless (EIP-3009)</button>
          <button className="secondary" disabled={!!busy || !mon} onClick={directTx}>3 · Direct tx from embedded wallet</button>
          {busy && <p className="muted">working: {busy}…</p>}
          <button className="link" onClick={handleLogOut}>Log out</button>
        </section>
      )}

      <section className="card">
        <h3>Relayer</h3>
        {info ? (
          <div className="kv">
            <span>Address</span><b className="mono">{short(info.relayer)}</b>
            <span>Signer</span><b>{info.signer}</b>
            <span>MON</span><b>{info.monBalance}</b>
            <span>Deposit to</span><b className="mono">{short(info.depositTo)}</b>
          </div>
        ) : (
          <p className="muted">offline ({RELAYER_URL})</p>
        )}
        <p className="fine">
          Dynamic's native gas sponsorship does not cover Monad, so Isotherm runs its own relayer.
        </p>
      </section>

      <section className="card log">
        <h3>Activity</h3>
        {log.length === 0 && <p className="muted">nothing yet</p>}
        {log.map((l, i) => (
          <div key={i} className="logline">
            <span className="muted">{l.t}</span> {l.msg}{' '}
            {l.tx && (
              <a href={`${EXPLORER_TX[CHAIN_ID]}${l.tx}`} target="_blank" rel="noreferrer">
                {short(l.tx)}
              </a>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}
