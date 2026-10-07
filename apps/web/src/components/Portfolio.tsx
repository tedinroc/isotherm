import { useState } from 'react';
import { formatEther, parseEventLogs, type Hex } from 'viem';
import { useI18n } from '../i18n';
import { useApp } from '../state';
import { useUi } from '../ui';
import { useWallet } from '../wallet/wallet';
import { vaultAbi, zapAbi } from '../lib/abi';
import { ensureYesAllowance, mergePairs, redeem, sellYes } from '../lib/actions';
import { api, ApiError } from '../lib/api';
import { fromUnits6, quoteSellYes } from '../lib/book';
import { planPortfolioSell, sellLeg, type PortfolioSellPlan } from '../lib/buyNo';
import { clearStranded, rememberStranded, strandedFor } from '../lib/stranded';
import { chainNow, type Holding } from '../lib/data';
import { amt, localTime, pct, px, short } from '../lib/format';
import { formatDate, stationMeta } from '../lib/stations';
import { addrUrl, txUrl } from '../config';
import { phaseOf, useNow } from './Markets';
import { IconDrop, IconExternal } from './icons';

export function Portfolio() {
  const { t } = useI18n();
  const wallet = useWallet();
  const app = useApp();
  const ui = useUi();
  if (!wallet.address) {
    return (
      <div className="screen">
        <div className="card center">
          <p>{t('pf.signin')}</p>
          <button className="btn primary" onClick={ui.openWallet}>
            {t('wallet.signin')}
          </button>
        </div>
      </div>
    );
  }
  const holdings = app.balances?.holdings ?? [];
  return (
    <div className="screen">
      <FundsCard />
      <section className="card">
        <h2 className="card-title">{t('pf.positions')}</h2>
        {holdings.length === 0 ? <p className="muted">{t('pf.empty')}</p> : holdings.map((h) => <Position key={h.strike.seriesId} h={h} />)}
      </section>
      <Activity />
    </div>
  );
}

export function FundsCard() {
  const { t } = useI18n();
  const wallet = useWallet();
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' | 'info'; hashes?: Hex[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const b = app.balances;

  async function drip() {
    if (!wallet.address) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.drip(wallet.address);
      if (r.alreadyFunded) setMsg({ text: t('funds.already'), kind: 'info' });
      else if (r.ausdPending) setMsg({ text: t('funds.pending'), kind: 'info', hashes: r.txHashes });
      else setMsg({ text: `${t('funds.got')} · ${r.monSent ?? '0'} MON + ${r.ausdSent ?? '0'} AUSD · ${(r.latencyMs / 1000).toFixed(1)} s`, kind: 'ok', hashes: r.txHashes });
      r.txHashes.forEach((h, i) => app.log({ label: i === 0 ? 'Test funds (drip)' : 'Test funds (drip, AUSD)', hash: h, ok: true }));
      await app.refreshBalances();
    } catch (e) {
      const ae = e as ApiError;
      const wait = ae.retryAfterSec ? ` (${Math.ceil(ae.retryAfterSec / 60)} min)` : '';
      setMsg({ text: `${ae.message}${wait}`, kind: 'err' });
    } finally {
      setBusy(false);
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section className="card funds">
      <div className="funds-head">
        <h2 className="card-title">{t('funds.title')}</h2>
        <span className={`wallet-kind ${wallet.kind}`}>{wallet.kind === 'dev' ? t('wallet.devLabel') : wallet.email ?? t('wallet.dynamicLabel')}</span>
      </div>
      <div className="balances">
        <div className="bal">
          <span className="bal-label">{t('funds.ausd')}</span>
          <span className="bal-value num">{b ? amt(fromUnits6(b.ausd)) : '—'}</span>
        </div>
        <div className="bal">
          <span className="bal-label">{t('funds.mon')}</span>
          <span className="bal-value num">{b ? Number(formatEther(b.mon)).toFixed(4) : '—'}</span>
        </div>
      </div>
      <div className="addr-row">
        <a href={addrUrl(wallet.address!)} target="_blank" rel="noreferrer" className="mono">
          {short(wallet.address)} <IconExternal size={12} />
        </a>
        <button className="link-btn" onClick={copy}>
          {copied ? t('wallet.copied') : t('wallet.copy')}
        </button>
      </div>
      <button className="btn primary" onClick={drip} disabled={busy}>
        <IconDrop size={16} /> {busy ? t('funds.getting') : t('funds.get')}
      </button>
      <p className="fine">{t('funds.explain')}</p>
      {msg && (
        <p className={msg.kind === 'err' ? 'error' : msg.kind === 'ok' ? 'success' : 'notice'}>
          {msg.text}
          {msg.hashes?.map((h) => (
            <a key={h} href={txUrl(h)} target="_blank" rel="noreferrer" className="txlink">
              {' '}
              {short(h)}
            </a>
          ))}
        </p>
      )}
    </section>
  );
}

function Position({ h }: { h: Holding }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const wallet = useWallet();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const m = stationMeta(h.ladder.station);
  const ph = phaseOf(h.ladder, now);
  const yes = fromUnits6(h.yes);
  const no = fromUnits6(h.no);
  const r = h.ladder.result;
  const s = h.strike;
  let status = t('pf.open');
  let payout: number | null = null;
  let final = false;
  if (r && r.status === 1) {
    const yesWins = r.tmaxC >= s.k;
    payout = yesWins ? yes : no;
    status = yesWins ? t('pf.won', { t: r.tmaxC }) : t('pf.lost', { t: r.tmaxC });
    final = chainNow() >= r.finalAt;
  } else if (r && r.status === 2) {
    payout = (yes + no) / 2;
    status = t('pf.void');
    final = chainNow() >= r.finalAt;
  } else if (ph === 'awaiting' || ph === 'closed') {
    status = t('pf.awaiting');
  }
  const value =
    payout ??
    yes * (s.book.bestBid ?? 0) * (1 - s.takerFeeBps / 10_000) + no * (s.book.bestAsk !== null ? 1 - s.book.bestAsk : 0);
  const pairs = h.yes < h.no ? h.yes : h.no;
  const canSell = ph === 'open' && h.yes > 0n && s.market && s.book.bids.length > 0;
  // YES left by a Buy No whose step 2 did not go through: a sale keeps that plan's per-unit limit (lib/stranded.ts).
  const rec = strandedFor(wallet.address, s.seriesId);
  const stranded = rec && pairs > 0n ? { origin: rec.origin, pairs: rec.pairs < pairs ? rec.pairs : pairs } : null;
  const quoteFn = (y: number) => quoteSellYes(s.book, y, s.takerFeeBps);
  const live = canSell ? planPortfolioSell(quoteFn, h.yes, SELL_SLIPPAGE, stranded) : null;
  // The plan the user is asked to confirm is frozen when the confirmation opens: that minimum is what gets sent.
  const [confirm, setConfirm] = useState<PortfolioSellPlan | null>(null);

  async function run(label: string, fn: () => Promise<{ hash: Hex; ms: number }>) {
    setErr(null);
    setBusy(label);
    try {
      const r2 = await fn();
      app.log({ label, hash: r2.hash, ok: true, detail: `${r2.ms} ms` });
      app.toast(label, 'ok', r2.hash);
      await Promise.all([app.refreshBalances(), app.refreshBooksNow()]);
    } catch (e) {
      setErr((e as Error).message);
      app.log({ label: `${label} failed`, ok: false, detail: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const doRedeem = () =>
    run(t('pf.redeemed'), async () => {
      const c = await wallet.getClient();
      const res = await redeem(c, s.seriesId, h.yes, h.no);
      const ev = parseEventLogs({ abi: vaultAbi, logs: res.receipt.logs, eventName: 'Redeemed' })[0];
      if (ev) app.log({ label: `Redeemed ≥${s.k}°C: ${amt(fromUnits6(ev.args.payout))} AUSD`, ok: true });
      return res;
    });
  const doMerge = () =>
    run(`Merge ${amt(fromUnits6(pairs))} pairs`, async () => {
      const res = await mergePairs(await wallet.getClient(), s.seriesId, pairs);
      clearStranded(wallet.address, s.seriesId); // every pair is merged, the stranded ones included
      return res;
    });
  const doSell = (plan: PortfolioSellPlan) =>
    run(`Sell Yes ≥${s.k}°C`, async () => {
      if (plan.blocked || plan.sellUnits <= 0n || plan.minAusdOut <= 0n) throw new Error(t('pf.sellNone'));
      const c = await wallet.getClient();
      const a = await ensureYesAllowance(c, s, plan.sellUnits, app.balances?.yesAllowanceZap[s.seriesId] ?? 0n);
      if (a) app.log({ label: `Approve Yes ≥${s.k}°C → Zap`, hash: a.hash, ok: true });
      if (plan.kind === 'retry' && rec) {
        // Same as the trade sheet's retry: sell with the original limit, merge any unsold Yes back with No.
        const t0 = performance.now();
        const r = await sellLeg(c, s, plan.sellUnits, plan.minAusdOut, null, () => undefined);
        const left = rec.pairs - plan.sellUnits + (r.mergeHash ? 0n : r.yesUnsold);
        rememberStranded(wallet.address!, s.seriesId, rec.origin, left > 0n ? left : 0n, 'set');
        app.log({ label: `Sold ${amt(fromUnits6(plan.sellUnits - r.yesUnsold))} Yes for ${amt(fromUnits6(r.ausdOut))} AUSD (min ${amt(fromUnits6(plan.minAusdOut))})`, ok: true });
        if (r.mergeHash) app.log({ label: `Merged ${amt(fromUnits6(r.yesUnsold))} unsold Yes back`, hash: r.mergeHash, ok: true });
        return { hash: r.sellHash, ms: Math.round(performance.now() - t0) };
      }
      const res = await sellYes(c, s, plan.sellUnits, plan.minAusdOut);
      const ev = parseEventLogs({ abi: zapAbi, logs: res.receipt.logs, eventName: 'ZapSellYes' })[0];
      if (ev)
        app.log({
          label: `Sold ${amt(fromUnits6(ev.args.yesIn - ev.args.yesRefund))} Yes for ${amt(fromUnits6(ev.args.ausdOut))} AUSD (min ${amt(fromUnits6(plan.minAusdOut))})`,
          ok: true,
        });
      return res;
    });

  return (
    <div className="position">
      <div className="pos-head">
        <div>
          <div className="pos-title">
            {m.test ? `${t('mk.test')} ${h.ladder.station}` : m.city[lang]} ≥ {s.k}°C
          </div>
          <div className="pos-sub">
            {formatDate(h.ladder.date, lang)} · {status}
          </div>
        </div>
        <div className="pos-value">
          <span className="fact-label">{payout !== null ? t('pf.payout') : t('pf.value')}</span>
          <b className="num">{amt(value)}</b>
        </div>
      </div>
      <div className="pos-legs">
        {h.yes > 0n && (
          <span className="pill yes">
            {t('mk.buyYes')} <b className="num">{amt(yes)}</b>
          </span>
        )}
        {h.no > 0n && (
          <span className="pill no">
            {t('mk.buyNo')} <b className="num">{amt(no)}</b>
          </span>
        )}
      </div>
      {r && r.status !== 0 && !final && (
        <p className="notice small">{t('pf.challenge', { t: localTime(r.finalAt, lang) })}</p>
      )}
      <div className="pos-actions">
        {r && r.status !== 0 && (
          <button className="btn primary small" disabled={!final || !!busy} onClick={doRedeem}>
            {busy ?? t('pf.redeem', { n: amt(payout ?? 0) })}
          </button>
        )}
        {canSell && !confirm && (
          <button className="btn small" disabled={!!busy || !live} onClick={() => live && setConfirm(live)}>
            {live && !live.blocked
              ? t('pf.sellYesAt', { avg: px(live.avgPrice), got: amt(fromUnits6(live.expectedOut)) })
              : t('pf.sellYes')}
          </button>
        )}
        {pairs > 0n && (!r || r.status === 0) && (
          <button className="btn small" disabled={!!busy} onClick={doMerge}>
            {t('pf.merge', { n: amt(fromUnits6(pairs)) })}
          </button>
        )}
      </div>
      {confirm && canSell && (
        <SellConfirm
          plan={confirm}
          busy={!!busy}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const p = confirm;
            setConfirm(null);
            await doSell(p);
          }}
        />
      )}
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

const SELL_SLIPPAGE = 0.02;

/** The quote, the average price and the exact minimum that will be sent; nothing is sent until the user confirms. */
function SellConfirm({ plan, busy, onCancel, onConfirm }: { plan: PortfolioSellPlan; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useI18n();
  const n = amt(fromUnits6(plan.sellUnits));
  const min = amt(fromUnits6(plan.minAusdOut));
  return (
    <div className="sell-confirm" role="alertdialog" aria-label={t('pf.sellYes')} data-testid="sell-confirm">
      {plan.kind === 'retry' ? (
        <>
          <p>{t('pf.sellRetry', { n })}</p>
          {plan.blocked ? (
            <p className="warn small">
              {t('trade.retryBlocked', { got: amt(fromUnits6(plan.expectedOut)), n, now: px(plan.noPriceNow), worst: px(plan.noPriceWorst) })}
            </p>
          ) : (
            <p className="fine">{t('trade.retryNote', { worst: px(plan.noPriceWorst) })}</p>
          )}
        </>
      ) : (
        <>
          <p>{t('pf.sellQuote', { n, avg: px(plan.avgPrice), got: amt(fromUnits6(plan.expectedOut)), min, slip: pct(SELL_SLIPPAGE) })}</p>
          {plan.sellUnits < plan.heldUnits && (
            <p className="fine">{t('pf.sellPartial', { n, held: amt(fromUnits6(plan.heldUnits)) })}</p>
          )}
        </>
      )}
      <div className="sell-confirm-actions">
        <button className="btn small primary" disabled={busy || plan.blocked} onClick={onConfirm}>
          {t('pf.sellConfirm', { n, min })}
        </button>
        <button className="btn small" disabled={busy} onClick={onCancel}>
          {t('pf.cancel')}
        </button>
      </div>
    </div>
  );
}

function Activity() {
  const { t } = useI18n();
  const { activity } = useApp();
  if (!activity.length) return null;
  return (
    <section className="card">
      <h2 className="card-title">{t('pf.activity')}</h2>
      <ul className="activity">
        {activity.map((a, i) => (
          <li key={i} className={a.ok ? '' : 'bad'}>
            <span className="muted num">{new Date(a.t).toLocaleTimeString('en-GB', { hour12: false })}</span> {a.label}
            {a.detail && <span className="muted"> · {a.detail}</span>}
            {a.hash && (
              <a className="txlink" href={txUrl(a.hash)} target="_blank" rel="noreferrer">
                {' '}
                {short(a.hash)}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
