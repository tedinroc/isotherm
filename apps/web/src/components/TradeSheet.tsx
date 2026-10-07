import { useEffect, useMemo, useState } from 'react';
import { parseEventLogs, type Hex } from 'viem';
import { useI18n } from '../i18n';
import { useApp } from '../state';
import { useUi } from '../ui';
import { useWallet } from '../wallet/wallet';
import { zapAbi } from '../lib/abi';
import { buyNo, buyYes, ensureAusdAllowance, relayedMint } from '../lib/actions';
import { fromUnits6, minOut, quoteBuyYes, sizeBuyNoForBudget, toUnits6 } from '../lib/book';
import { chainNow, type LadderView, type StrikeView } from '../lib/data';
import { amt, pct, px } from '../lib/format';
import { formatDate, stationMeta } from '../lib/stations';
import { txUrl } from '../config';
import { IconX } from './icons';

type Side = 'yes' | 'no' | 'pair';
const SLIPPAGES = [0.005, 0.01, 0.02, 0.05];
const QUICK = [5, 10, 25, 50];
const MIN_MON_FOR_TRADE = 0.012e18;

export function TradeSheet({ ladder, strike, onClose }: { ladder: LadderView; strike: StrikeView; onClose: () => void }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const ui = useUi();
  const wallet = useWallet();
  const [side, setSideState] = useState<Side>('yes');
  const setSide = (x: Side) => {
    setSideState(x);
    setDone(null);
    setErr(null);
  };
  const [amount, setAmount] = useState('10');
  const [slip, setSlip] = useState(0.02);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; hash: Hex } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const m = stationMeta(ladder.station);
  const now = chainNow();
  const open = now < strike.closeTime && (!ladder.result || ladder.result.status === 0);
  const bal = app.balances ? fromUnits6(app.balances.ausd) : 0;
  const mon = app.balances ? Number(app.balances.mon) : 0;
  const x = Math.max(0, Number(amount.replace(',', '.')) || 0);
  const relayMode: 'authorization' | 'permit' | null = app.caps?.mintWithAuthorization
    ? 'authorization'
    : app.caps?.mintWithPermit
      ? 'permit'
      : null;
  const relayOk = !!relayMode && !!app.health?.relayEnabled && (app.health?.relayModes ?? []).includes(relayMode);

  const q = useMemo(() => {
    if (side === 'yes') {
      const r = quoteBuyYes(strike.book, x, strike.takerFeeBps);
      return {
        ok: r.out > 0,
        get: r.out,
        avg: r.avgPrice,
        spend: r.spend,
        refund: r.refund,
        ausdIn: toUnits6(x),
        min: minOut(r.out, slip),
        pays: r.out,
      };
    }
    if (side === 'no') {
      const r = sizeBuyNoForBudget(strike.book, x, wallet.address ? bal : x * 50, strike.takerFeeBps);
      const minBack = r.ausdIn - r.netCost * (1 + slip);
      return {
        ok: r.noOut > 0 && strike.book.bids.length > 0,
        get: r.noOut,
        avg: r.avgPrice,
        spend: r.netCost,
        refund: r.ausdBack,
        ausdIn: toUnits6(r.ausdIn),
        min: minBack > 0 ? toUnits6(minBack) : 1n,
        pays: r.noOut,
      };
    }
    return { ok: x > 0, get: x, avg: 1, spend: x, refund: 0, ausdIn: toUnits6(x), min: 0n, pays: x };
  }, [side, x, strike, slip, bal]);

  const needsAusd = fromUnits6(q.ausdIn);
  const insufficient = !!wallet.address && (side === 'no' ? bal + 1e-9 < x : needsAusd > bal + 1e-9);

  async function submit() {
    setErr(null);
    setDone(null);
    if (!wallet.address) {
      ui.openWallet();
      return;
    }
    if (side !== 'pair' && mon < MIN_MON_FOR_TRADE) {
      setErr(t('funds.lowMon'));
      return;
    }
    try {
      const client = await wallet.getClient();
      if (side === 'pair') {
        setBusy(t('trade.sending'));
        const r = await relayedMint(client, strike, q.ausdIn, relayMode!);
        app.log({ label: `Gasless pair ×${amt(x)} ≥${strike.k}°C`, hash: r.txHash, ok: true });
        setDone({ text: `${amt(x)} Yes + ${amt(x)} No`, hash: r.txHash });
      } else {
        const allowance = app.balances?.ausdAllowanceZap ?? 0n;
        if (allowance < q.ausdIn) {
          setBusy(t('trade.approving'));
          const a = await ensureAusdAllowance(client, q.ausdIn, allowance);
          if (a) app.log({ label: 'Approve AUSD → Zap', hash: a.hash, ok: true });
        }
        setBusy(t('trade.sending'));
        if (side === 'yes') {
          const r = await buyYes(client, strike, q.ausdIn, q.min);
          const ev = parseEventLogs({ abi: zapAbi, logs: r.receipt.logs, eventName: 'ZapBuyYes' })[0];
          const got = ev ? fromUnits6(ev.args.yesOut) : q.get;
          const refund = ev ? fromUnits6(ev.args.ausdRefund) : 0;
          app.log({ label: `Buy Yes ≥${strike.k}°C: ${amt(got)} for ${amt(x - refund)} AUSD`, hash: r.hash, ok: true, detail: `${r.ms} ms` });
          setDone({ text: `${amt(got)} Yes · ${amt(x - refund)} AUSD · ${(r.ms / 1000).toFixed(1)} s`, hash: r.hash });
        } else {
          const r = await buyNo(client, strike, q.ausdIn, q.min);
          const ev = parseEventLogs({ abi: zapAbi, logs: r.receipt.logs, eventName: 'ZapBuyNo' })[0];
          const got = ev ? fromUnits6(ev.args.noOut) : q.get;
          const back = ev ? fromUnits6(ev.args.ausdBack) : q.refund;
          const cost = fromUnits6(q.ausdIn) - back;
          app.log({ label: `Buy No ≥${strike.k}°C: ${amt(got)} for ${amt(cost)} AUSD`, hash: r.hash, ok: true, detail: `${r.ms} ms` });
          setDone({ text: `${amt(got)} No · ${amt(cost)} AUSD · ${(r.ms / 1000).toFixed(1)} s`, hash: r.hash });
        }
      }
      app.toast(t('trade.done'), 'ok');
      await Promise.all([app.refreshBalances(), app.refreshBooksNow()]);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setErr(msg);
      app.log({ label: `Trade failed: ${msg}`, ok: false });
    } finally {
      setBusy(null);
    }
  }

  const cmp = side === 'no' ? t('trade.below') : t('trade.atLeast');
  const dateStr = formatDate(ladder.date, lang);
  const sideWord = side === 'yes' ? t('mk.buyYes') : t('mk.buyNo');
  const canTrade = open && strike.market && q.ok && !insufficient && !busy && x > 0;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`${m.city[lang]} ≥${strike.k}°C`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-head">
          <div>
            <div className="eyebrow">
              {m.test ? ladder.station : m.city[lang]} · {dateStr}
            </div>
            <h2>
              {t('mk.question', { city: m.test ? ladder.station : m.city[lang], k: strike.k, date: dateStr })}
            </h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('misc.close')}>
            <IconX />
          </button>
        </header>

        <div className="seg" role="tablist">
          <button className={`seg-btn yes ${side === 'yes' ? 'on' : ''}`} onClick={() => setSide('yes')} role="tab" aria-selected={side === 'yes'}>
            {t('trade.buyYes')} <span className="num">{px(strike.book.bestAsk)}</span>
          </button>
          <button className={`seg-btn no ${side === 'no' ? 'on' : ''}`} onClick={() => setSide('no')} role="tab" aria-selected={side === 'no'}>
            {t('trade.buyNo')} <span className="num">{px(strike.book.bestBid !== null ? 1 - strike.book.bestBid : null)}</span>
          </button>
          {relayOk && (
            <button className={`seg-btn pair ${side === 'pair' ? 'on' : ''}`} onClick={() => setSide('pair')} role="tab" aria-selected={side === 'pair'}>
              {t('trade.pair')}
            </button>
          )}
        </div>

        <label className="amount">
          <span className="amount-label">{side === 'pair' ? t('trade.pairs') : t('trade.spend')}</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
            aria-label={t('trade.spend')}
          />
          <span className="amount-unit">AUSD</span>
        </label>
        <div className="quick">
          {QUICK.map((v) => (
            <button key={v} className={`quick-btn ${x === v ? 'on' : ''}`} onClick={() => setAmount(String(v))}>
              {v}
            </button>
          ))}
          <span className="quick-bal">
            {t('trade.balance')} <b className="num">{wallet.address ? amt(bal) : '—'}</b>
          </span>
        </div>

        {side === 'pair' ? (
          <p className="explain">{t('trade.pairExplain')}</p>
        ) : (
          <div className="quote">
            <div className="quote-main">
              <span>{t('trade.youGet')}</span>
              <b className="num big">{q.ok ? amt(q.get) : '—'}</b>
              <span>
                {sideWord} {t('trade.contracts')}
              </span>
            </div>
            <dl className="quote-rows">
              <div>
                <dt>{t('trade.avg')}</dt>
                <dd className="num">{px(q.avg)}</dd>
              </div>
              <div>
                <dt>{t('trade.maxLoss')}</dt>
                <dd className="num">{amt(q.spend)} AUSD</dd>
              </div>
              {side === 'no' && q.ok && (
                <div>
                  <dt>{t('trade.back')}</dt>
                  <dd className="num">
                    {amt(q.refund)} / {amt(fromUnits6(q.ausdIn))} AUSD
                  </dd>
                </div>
              )}
              <div>
                <dt>{t('trade.slippage')}</dt>
                <dd>
                  <span className="slips">
                    {SLIPPAGES.map((s) => (
                      <button key={s} className={`slip ${slip === s ? 'on' : ''}`} onClick={() => setSlip(s)}>
                        {pct(s, s < 0.01 ? 1 : 0)}
                      </button>
                    ))}
                  </span>
                </dd>
              </div>
            </dl>
            {q.ok && (
              <p className="pays">
                {t('trade.paysIf', { n: amt(q.pays), icao: ladder.station, cmp, k: strike.k, date: dateStr })}
              </p>
            )}
            {!q.ok && x > 0 && <p className="warn">{side === 'no' && !strike.book.bids.length ? t('trade.noBids') : t('trade.noLiquidity')}</p>}
          </div>
        )}

        <BookDepth strike={strike} />

        {insufficient && !busy && <p className="warn">{t('trade.insufficient')}</p>}
        {err && <p className="error">{err}</p>}
        {done && (
          <p className="success">
            ✓ {done.text} ·{' '}
            <a href={txUrl(done.hash)} target="_blank" rel="noreferrer">
              {t('misc.tx')}
            </a>
          </p>
        )}

        {!open ? (
          <button className="btn primary" disabled>
            {t('trade.closed')}
          </button>
        ) : !wallet.address ? (
          <button className="btn primary" onClick={ui.openWallet}>
            {t('trade.signIn')}
          </button>
        ) : side !== 'pair' && mon < MIN_MON_FOR_TRADE ? (
          <button
            className="btn primary"
            onClick={() => {
              onClose();
              ui.setTab('portfolio');
            }}
          >
            {t('trade.needFunds')}
          </button>
        ) : (
          <button className={`btn primary ${side}`} disabled={!canTrade} onClick={submit}>
            {busy ??
              (side === 'pair'
                ? t('trade.pairGo', { n: amt(x, 0) })
                : t('trade.go', { side: sideWord, n: amt(side === 'no' ? q.spend : x) }))}
          </button>
        )}
        {side !== 'pair' && <p className="fine center">{t('trade.feeNote', { mon: side === 'no' ? '0.08' : '0.07' })}</p>}
      </div>
    </div>
  );
}

function BookDepth({ strike }: { strike: StrikeView }) {
  const { t } = useI18n();
  const asks = strike.book.asks.slice(0, 3).reverse();
  const bids = strike.book.bids.slice(0, 3);
  if (!strike.market) return <p className="muted small">{t('mk.noBook')}</p>;
  if (!asks.length && !bids.length) return <p className="muted small">{t('mk.noQuotes')}</p>;
  const maxSize = Math.max(...[...asks, ...bids].map((l) => l.size), 1);
  return (
    <div className="depth" aria-label={t('trade.book')}>
      <div className="depth-head">
        <span>{t('trade.book')}</span>
        <span>{t('trade.size')} (Yes)</span>
      </div>
      {asks.map((l) => (
        <div key={`a${l.price}`} className="depth-row ask">
          <span className="depth-bar" style={{ width: `${(l.size / maxSize) * 100}%` }} />
          <span className="num">
            {t('trade.ask')} {px(l.price)}
          </span>
          <span className="num">{amt(l.size, 1)}</span>
        </div>
      ))}
      {bids.map((l) => (
        <div key={`b${l.price}`} className="depth-row bid">
          <span className="depth-bar" style={{ width: `${(l.size / maxSize) * 100}%` }} />
          <span className="num">
            {t('trade.bid')} {px(l.price)}
          </span>
          <span className="num">{amt(l.size, 1)}</span>
        </div>
      ))}
    </div>
  );
}
