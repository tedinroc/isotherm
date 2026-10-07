import { useEffect, useMemo, useState } from 'react';
import { parseEventLogs, type Hex } from 'viem';
import { useI18n } from '../i18n';
import { useApp } from '../state';
import { useUi } from '../ui';
import { useWallet } from '../wallet/wallet';
import { zapAbi } from '../lib/abi';
import { buyYes, ensureAusdAllowance, mergePairs, relayedMint } from '../lib/actions';
import { fromUnits6, minOut, quoteBuyNoViaSell, quoteBuyYes, quoteSellYes, toUnits6 } from '../lib/book';
import { planBuyNo, planRetrySell, runBuyNo, sellLeg, SellLegFailed, type BuyNoPlan, type StepEvent, type StepId, type StepStatus } from '../lib/buyNo';
import { chainNow, type LadderView, type StrikeView } from '../lib/data';
import { amt, pct, px } from '../lib/format';
import { formatDate, stationMeta } from '../lib/stations';
import { txUrl } from '../config';
import { IconX } from './icons';

type Side = 'yes' | 'no' | 'pair';
const BUSY: Record<StepId, 'trade.busyApprove' | 'trade.busyMint' | 'trade.busySell' | 'trade.busyMerge'> = {
  approve: 'trade.busyApprove',
  mint: 'trade.busyMint',
  sell: 'trade.busySell',
  merge: 'trade.busyMerge',
};
const SLIPPAGES = [0.005, 0.01, 0.02, 0.05];
const QUICK = [5, 10, 25, 50];
// Monad bills the gas LIMIT (estimate × 1.10). MON per transaction at the live 102 gwei, from gas measured on an anvil
// fork of testnet (evidence/fix-round/fork-buyno-sandwich-*.json): approve ≈ 0.008, mintSet ≈ 0.026, sellYes ≈ 0.053,
// buyYes ≈ 0.052. A trade needs its whole flow's MON up front, so a Buy No never stops between its two transactions
// for lack of gas.
const TX_MON = { approve: 0.008, mint: 0.026, sell: 0.054, buyYes: 0.053 } as const;
type Steps = Partial<Record<StepId, { status: StepStatus; hash?: Hex }>>;

export function TradeSheet({ ladder, strike, onClose }: { ladder: LadderView; strike: StrikeView; onClose: () => void }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const ui = useUi();
  const wallet = useWallet();
  const [side, setSideState] = useState<Side>('yes');
  const setSide = (x: Side) => {
    if (busy) return;
    setSideState(x);
    setDone(null);
    setErr(null);
    setRun(null);
  };
  const [amount, setAmount] = useState('10');
  const [slip, setSlip] = useState(0.02);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; hash: Hex } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Buy No progress: the plan frozen at tap time, per-step status, and pairs left over if step 2 did not go through.
  const [run, setRun] = useState<{ plan: BuyNoPlan; steps: Steps } | null>(null);
  // `origin` is the plan the user accepted at tap time: a retry of step 2 never goes below its per-unit minimum.
  const [stranded, setStranded] = useState<{ pairs: bigint; mintHash: Hex | null; origin: BuyNoPlan } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A finished Buy No keeps its ticked steps on screen until the user changes the order.
  useEffect(() => {
    if (!busy && !stranded) setRun(null);
  }, [amount, slip]); // eslint-disable-line react-hooks/exhaustive-deps

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
        plan: null,
        depthLimited: false,
      };
    }
    if (side === 'no') {
      // mint `r.mint` sets, sell the YES leg with a hard minAusdOut (see lib/buyNo.ts; never Zap.buyNo)
      const r = quoteBuyNoViaSell(strike.book, x, wallet.address ? bal : x * 50, strike.takerFeeBps);
      const plan = planBuyNo(r, slip, {
        ausdVault: app.balances?.ausdAllowanceVault ?? 0n,
        yesZap: app.balances?.yesAllowanceZap[strike.seriesId] ?? 0n,
      });
      return {
        ok: !!plan && strike.book.bids.length > 0,
        get: r.mint,
        avg: r.avgPrice,
        spend: r.netCost,
        refund: r.proceeds,
        ausdIn: toUnits6(r.mint),
        min: plan?.minAusdOut ?? 0n,
        pays: r.mint,
        plan,
        depthLimited: r.depthLimited,
      };
    }
    return { ok: x > 0, get: x, avg: 1, spend: x, refund: 0, ausdIn: toUnits6(x), min: 0n, pays: x, plan: null, depthLimited: false };
  }, [side, x, strike, slip, bal, wallet.address, app.balances]);

  const needsAusd = fromUnits6(q.ausdIn);
  const insufficient = !!wallet.address && (side === 'no' ? bal + 1e-9 < x : needsAusd > bal + 1e-9);

  const minMon =
    1e18 *
    (side === 'no'
      ? TX_MON.mint + TX_MON.sell + TX_MON.approve * (Number(!!q.plan?.approveAusd) + Number(!!q.plan?.approveYes))
      : TX_MON.buyYes + ((app.balances?.ausdAllowanceZap ?? 0n) < q.ausdIn ? TX_MON.approve : 0));

  /** Step callback for Buy No: drives the progress list, the button label and the session log. */
  const onStep = (plan: BuyNoPlan) => (e: StepEvent) => {
    setRun((r) => (r ? { ...r, steps: { ...r.steps, [e.id]: { status: e.status, hash: e.hash ?? r.steps[e.id]?.hash } } } : r));
    if (e.status === 'active') setBusy(t(BUSY[e.id]));
    if (e.hash) {
      const n = amt(fromUnits6(plan.mint));
      const label =
        e.id === 'approve'
          ? e.what === 'yes-zap'
            ? `Approve Yes ≥${strike.k}°C → Zap (one time)`
            : 'Approve AUSD → vault (one time)'
          : e.id === 'mint'
            ? `Buy No step 1: minted ${n} pairs ≥${strike.k}°C`
            : e.id === 'sell'
              ? `Buy No step 2: sold the Yes leg ≥${strike.k}°C`
              : `Merged unsold Yes back ≥${strike.k}°C`;
      app.log({ label, hash: e.hash, ok: true });
    }
  };

  function finishNo(r: { noOut: bigint; cost: bigint; sellHash: Hex }, ms: number | null) {
    const got = fromUnits6(r.noOut);
    const cost = fromUnits6(r.cost);
    app.log({ label: `Buy No ≥${strike.k}°C: ${amt(got)} No for ${amt(cost)} AUSD`, hash: r.sellHash, ok: true, detail: ms ? `${ms} ms` : undefined });
    setDone({ text: `${amt(got)} No · ${amt(cost)} AUSD${ms ? ` · ${(ms / 1000).toFixed(1)} s` : ''}`, hash: r.sellHash });
    setStranded(null);
  }

  function failNo(e: unknown, origin: BuyNoPlan) {
    const msg = (e as Error).message ?? String(e);
    if (e instanceof SellLegFailed) {
      // Step 1 minted; step 2 reverted (price moved past the limit) or was not sent. The user holds complete pairs.
      setStranded({ pairs: e.pairs, mintHash: e.mintHash, origin });
      app.log({ label: `Buy No step 2 not filled (${amt(fromUnits6(e.pairs))} pairs kept): ${msg}`, ok: false });
    } else {
      app.log({ label: `Trade failed: ${msg}`, ok: false });
    }
    setErr(msg);
  }

  async function submit() {
    setErr(null);
    setDone(null);
    if (!wallet.address) {
      ui.openWallet();
      return;
    }
    if (side !== 'pair' && mon < minMon) {
      setErr(t('funds.lowMon'));
      return;
    }
    setBusy(
      side === 'no' ? t(q.plan && (q.plan.approveAusd || q.plan.approveYes) ? 'trade.busyApprove' : 'trade.busyMint') : t('trade.sending'),
    );
    try {
      const client = await wallet.getClient();
      if (side === 'pair') {
        setBusy(t('trade.sending'));
        const r = await relayedMint(client, strike, q.ausdIn, relayMode!);
        app.log({ label: `Gasless pair ×${amt(x)} ≥${strike.k}°C`, hash: r.txHash, ok: true });
        setDone({ text: `${amt(x)} Yes + ${amt(x)} No`, hash: r.txHash });
      } else if (side === 'yes') {
        const allowance = app.balances?.ausdAllowanceZap ?? 0n;
        if (allowance < q.ausdIn) {
          setBusy(t('trade.approving'));
          const a = await ensureAusdAllowance(client, q.ausdIn, allowance);
          if (a) app.log({ label: 'Approve AUSD → Zap', hash: a.hash, ok: true });
        }
        setBusy(t('trade.sending'));
        const r = await buyYes(client, strike, q.ausdIn, q.min);
        const ev = parseEventLogs({ abi: zapAbi, logs: r.receipt.logs, eventName: 'ZapBuyYes' })[0];
        const got = ev ? fromUnits6(ev.args.yesOut) : q.get;
        const refund = ev ? fromUnits6(ev.args.ausdRefund) : 0;
        app.log({ label: `Buy Yes ≥${strike.k}°C: ${amt(got)} for ${amt(x - refund)} AUSD`, hash: r.hash, ok: true, detail: `${r.ms} ms` });
        setDone({ text: `${amt(got)} Yes · ${amt(x - refund)} AUSD · ${(r.ms / 1000).toFixed(1)} s`, hash: r.hash });
      } else {
        const plan = q.plan;
        if (!plan) return;
        setRun({ plan, steps: {} });
        try {
          const r = await runBuyNo(client, strike, plan, onStep(plan));
          finishNo(r, r.ms);
        } catch (e) {
          failNo(e, plan);
          return;
        }
      }
      app.toast(t('trade.done'), 'ok');
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setErr(msg);
      app.log({ label: `Trade failed: ${msg}`, ok: false });
    } finally {
      setBusy(null);
      await Promise.all([app.refreshBalances(), app.refreshBooksNow()]).catch(() => undefined);
    }
  }

  /**
   * Recovery after step 2 did not go through: sell the YES leg again, quoted on today's book but never below the
   * original plan's per-unit minimum (lib/buyNoPlan.ts planRetrySell). A sandwich that left a dust bid therefore
   * cannot fill the retry at ~0.999 per No; when the bids cannot pay that floor, the sale is not offered at all…
   */
  const retryQuote = stranded ? quoteSellYes(strike.book, fromUnits6(stranded.pairs), strike.takerFeeBps) : null;
  const retry = stranded && retryQuote ? planRetrySell(stranded.origin, stranded.pairs, retryQuote.proceeds, slip) : null;
  async function retrySell() {
    if (!stranded || !retry || retry.blocked) return;
    setErr(null);
    const origin = stranded.origin;
    setRun({ plan: { ...origin, minAusdOut: retry.minAusdOut }, steps: { ...(run?.steps ?? {}), sell: { status: 'todo' } } });
    try {
      const client = await wallet.getClient();
      const r = await sellLeg(client, strike, stranded.pairs, retry.minAusdOut, stranded.mintHash, onStep(origin));
      finishNo(r, null);
      app.toast(t('trade.done'), 'ok');
    } catch (e) {
      failNo(e, origin);
    } finally {
      setBusy(null);
      await Promise.all([app.refreshBalances(), app.refreshBooksNow()]).catch(() => undefined);
    }
  }
  /** …or merge the pairs back into AUSD (vault.redeemSet, 1:1, no price risk). */
  async function mergeBack() {
    if (!stranded) return;
    setErr(null);
    setBusy(t('trade.busyMerge'));
    try {
      const client = await wallet.getClient();
      const r = await mergePairs(client, strike.seriesId, stranded.pairs);
      app.log({ label: `Merged ${amt(fromUnits6(stranded.pairs))} pairs back into AUSD`, hash: r.hash, ok: true });
      setDone({ text: t('trade.mergedBack', { n: amt(fromUnits6(stranded.pairs)) }), hash: r.hash });
      setStranded(null);
      setRun(null);
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setBusy(null);
      await Promise.all([app.refreshBalances(), app.refreshBooksNow()]).catch(() => undefined);
    }
  }

  const cmp = side === 'no' ? t('trade.below') : t('trade.atLeast');
  const dateStr = formatDate(ladder.date, lang);
  const sideWord = side === 'yes' ? t('mk.buyYes') : t('mk.buyNo');
  const canTrade = open && strike.market && q.ok && !insufficient && !busy && x > 0 && !stranded;
  const shownPlan = run?.plan ?? q.plan;

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
                <dd className="num">
                  {amt(q.spend)} AUSD
                  {side === 'no' && q.plan && <span className="muted small"> · ≤ {amt(fromUnits6(q.plan.worstCost))}</span>}
                </dd>
              </div>
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
            {side === 'no' && q.ok && q.depthLimited && x > q.spend + 0.005 && <p className="fine">{t('trade.depthLimited')}</p>}
          </div>
        )}

        {side === 'no' && shownPlan && (q.ok || run) && <NoSteps plan={shownPlan} steps={run?.steps ?? {}} />}

        {stranded && (
          <div className="stranded" role="alert">
            <p>
              <b>{t('trade.strandedTitle')}</b> {t('trade.stranded', { n: amt(fromUnits6(stranded.pairs)) })}
            </p>
            {err && <p className="fine">{err}</p>}
            <div className="stranded-actions">
              <button className="btn small primary" disabled={!!busy} onClick={mergeBack}>
                {t('trade.mergeBack', { n: amt(fromUnits6(stranded.pairs)) })}
              </button>
              <button className="btn small" disabled={!!busy || !open || !retry || retry.blocked} onClick={retrySell}>
                {t('trade.retrySell', { n: amt(fromUnits6(stranded.pairs)), min: amt(fromUnits6(retry?.minAusdOut ?? 0n)) })}
              </button>
            </div>
            {retry &&
              (retry.blocked ? (
                <p className="warn small" data-testid="retry-blocked">
                  {t('trade.retryBlocked', {
                    got: amt(fromUnits6(retry.expectedOut)),
                    n: amt(fromUnits6(stranded.pairs)),
                    now: px(retry.noPriceNow),
                    worst: px(retry.noPriceWorst),
                  })}
                </p>
              ) : (
                <p className="fine">{t('trade.retryNote', { worst: px(retry.noPriceWorst) })}</p>
              ))}
          </div>
        )}

        <BookDepth strike={strike} />

        {insufficient && !busy && !stranded && <p className="warn">{t('trade.insufficient')}</p>}
        {err && !stranded && <p className="error">{err}</p>}
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
        ) : side !== 'pair' && mon < minMon && !busy && !stranded ? (
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
        {side === 'yes' && <p className="fine center">{t('trade.feeNote', { mon: '0.05' })}</p>}
        {side === 'no' && <p className="fine center">{t('trade.feeNoteNo', { mon: '0.08' })}</p>}
      </div>
    </div>
  );
}

/** The two transactions behind one "Buy No" tap, with live status (and the one-time approvals when needed). */
function NoSteps({ plan, steps }: { plan: BuyNoPlan; steps: Steps }) {
  const { t } = useI18n();
  const n = amt(fromUnits6(plan.mint));
  const rows: { id: StepId; mark: string; text: string }[] = [];
  if (plan.approveAusd || plan.approveYes || steps.approve) rows.push({ id: 'approve', mark: '·', text: t('trade.stepApprove') });
  rows.push({ id: 'mint', mark: '1', text: t('trade.stepMint', { n }) });
  rows.push({ id: 'sell', mark: '2', text: t('trade.stepSell', { n, min: amt(fromUnits6(plan.minAusdOut)) }) });
  if (steps.merge) rows.push({ id: 'merge', mark: '·', text: t('trade.stepMerge') });
  return (
    <div className="nosteps" aria-label={t('trade.noHow')}>
      <div className="nosteps-head">{t('trade.noHow')}</div>
      <ol>
        {rows.map((r) => {
          const st = steps[r.id]?.status ?? 'todo';
          const hash = steps[r.id]?.hash;
          return (
            <li key={r.id} className={`step ${st}`} aria-current={st === 'active' ? 'step' : undefined}>
              <span className="step-mark" aria-hidden="true">
                {st === 'done' ? '✓' : st === 'failed' ? '✕' : st === 'active' ? <span className="spinner" /> : r.mark}
              </span>
              <span className="step-text">{r.text}</span>
              {hash && (
                <a className="txlink" href={txUrl(hash)} target="_blank" rel="noreferrer">
                  {t('misc.tx')}
                </a>
              )}
            </li>
          );
        })}
      </ol>
      <p className="fine">{t('trade.noGuard')}</p>
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
