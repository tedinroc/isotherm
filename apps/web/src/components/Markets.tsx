import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { useApp } from '../state';
import { chainNow, type LadderView, type StrikeView } from '../lib/data';
import { countdown, pct, px } from '../lib/format';
import { fairTag, type FairTag } from '../lib/fairSource';
import { formatDate, localDateOf, stationMeta, weekday } from '../lib/stations';
import { IconExternal, IconThermo } from './icons';
import { TradeSheet } from './TradeSheet';
import { useWallet } from '../wallet/wallet';
import { useUi } from '../ui';

export function useNow(ms = 1000) {
  const [now, setNow] = useState(chainNow());
  useEffect(() => {
    const id = setInterval(() => setNow(chainNow()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const FAIR_TAG_KEY: Record<FairTag, 'mk.srcObserved' | 'mk.srcModel' | 'mk.srcIntraday' | 'mk.srcUnknown'> = {
  observed: 'mk.srcObserved',
  model: 'mk.srcModel',
  intraday: 'mk.srcIntraday',
  unknown: 'mk.srcUnknown',
};

export type LadderPhase = 'open' | 'closed' | 'awaiting' | 'settled' | 'void';
export function phaseOf(l: LadderView, now: number): LadderPhase {
  if (l.result && l.result.status === 1) return 'settled';
  if (l.result && l.result.status === 2) return 'void';
  if (now >= l.dayEnd) return 'awaiting';
  if (now >= l.closeTime) return 'closed';
  return 'open';
}

export function Markets() {
  const { t, lang } = useI18n();
  const { ladders, laddersError, booksAt } = useApp();
  const now = useNow();
  const [sel, setSel] = useState<string | null>(null);
  const [trade, setTrade] = useState<{ ladder: LadderView; strike: StrikeView } | null>(null);

  const groups = useMemo(() => {
    const all = (ladders ?? []).filter((l) => l.strikes.length);
    const live = all
      .filter((l) => ['open', 'closed', 'awaiting'].includes(phaseOf(l, now)))
      .sort((a, b) => Number(a.test) - Number(b.test) || a.date - b.date || a.station.localeCompare(b.station));
    const past = all
      .filter((l) => ['settled', 'void'].includes(phaseOf(l, now)))
      .sort((a, b) => Number(a.test) - Number(b.test) || b.date - a.date)
      .slice(0, 6);
    return { live, past };
  }, [ladders, now]);

  const current = useMemo(() => {
    const all = [...groups.live, ...groups.past];
    return all.find((l) => l.key === sel) ?? groups.live.find((l) => phaseOf(l, now) === 'open') ?? all[0] ?? null;
  }, [groups, sel, now]);

  // keep the open sheet's strike fresh as books refresh
  const tradeStrike = trade ? current?.strikes.find((s) => s.seriesId === trade.strike.seriesId) ?? trade.strike : null;

  if (!ladders) {
    return (
      <div className="screen">
        <div className="card skeleton">
          <p className="muted">{laddersError ? `${t('misc.error')}: ${laddersError}` : t('mk.loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="chips" role="tablist">
        {groups.live.map((l) => (
          <LadderChip key={l.key} l={l} active={current?.key === l.key} onClick={() => setSel(l.key)} now={now} />
        ))}
        {groups.past.length > 0 && <span className="chip-sep">{t('mk.past')}</span>}
        {groups.past.map((l) => (
          <LadderChip key={l.key} l={l} active={current?.key === l.key} onClick={() => setSel(l.key)} now={now} />
        ))}
      </div>

      <Onboarding />

      {!groups.live.some((l) => phaseOf(l, now) === 'open') && (
        <div className="notice">{t('mk.none')}</div>
      )}

      {current && (
        <LadderCard
          l={current}
          now={now}
          booksAt={booksAt}
          lang={lang}
          onPick={(s) => setTrade({ ladder: current, strike: s })}
        />
      )}

      <p className="fine">{t('mk.legend')}</p>

      {trade && tradeStrike && current && (
        <TradeSheet ladder={current} strike={tradeStrike} onClose={() => setTrade(null)} />
      )}
    </div>
  );
}

function Onboarding() {
  const { t } = useI18n();
  const wallet = useWallet();
  const { balances } = useApp();
  const ui = useUi();
  if (wallet.address && (!balances || balances.ausd > 0n)) return null;
  return (
    <div className="onboard">
      <div className="onboard-steps">
        <span className={wallet.address ? 'done' : ''}>1 · {t('onb.signin')}</span>
        <span>2 · {t('onb.funds')}</span>
        <span>3 · {t('onb.trade')}</span>
      </div>
      {!wallet.address ? (
        <button className="btn primary small" onClick={ui.openWallet}>
          {t('wallet.signin')}
        </button>
      ) : (
        <button className="btn primary small" onClick={() => ui.setTab('portfolio')}>
          {t('funds.get')}
        </button>
      )}
    </div>
  );
}

function LadderChip({ l, active, onClick, now }: { l: LadderView; active: boolean; onClick: () => void; now: number }) {
  const { lang, t } = useI18n();
  const m = stationMeta(l.station);
  const ph = phaseOf(l, now);
  return (
    <button className={`chip ${active ? 'active' : ''} ${m.test ? 'test' : ''}`} onClick={onClick} role="tab" aria-selected={active}>
      <span className="chip-city">{m.test ? `${t('mk.test')} ${l.station}` : m.city[lang]}</span>
      <span className="chip-date">
        {weekday(l.date, lang)} {formatDate(l.date, lang)}
      </span>
      <span className={`dot ${ph}`} aria-hidden="true" />
    </button>
  );
}

function LadderCard({ l, now, booksAt, lang, onPick }: { l: LadderView; now: number; booksAt: number | null; lang: 'en' | 'zh'; onPick: (s: StrikeView) => void }) {
  const { t } = useI18n();
  const m = stationMeta(l.station);
  const ph = phaseOf(l, now);
  const today = localDateOf(now * 1000, m.utcOffsetMin) === l.date;
  const obs = l.snap?.observedMaxC ?? null;
  return (
    <section className="card ladder">
      <header className="ladder-head">
        <div>
          <div className="eyebrow">
            <IconThermo size={14} /> {t('mk.station', { airport: m.airport, icao: l.station })}
          </div>
          <h1 className="ladder-title">
            {m.test ? `${t('mk.test')} ${l.station}` : m.city[lang]} · {weekday(l.date, lang)} {formatDate(l.date, lang)}
          </h1>
        </div>
        <PhaseBadge l={l} ph={ph} now={now} />
      </header>

      <div className="facts">
        {today && obs !== null && (
          <div className="fact">
            <span className="fact-label">{t('mk.maxSoFar')}</span>
            <span className="fact-value">
              {obs}°C{l.snap?.observedAt ? <small> · {l.snap.observedAt}</small> : null}
            </span>
          </div>
        )}
        {ph === 'open' && (
          <div className="fact">
            <span className="fact-label">{t('mk.closesIn')}</span>
            <span className="fact-value num">{countdown(l.closeTime - now, lang)}</span>
          </div>
        )}
        {l.snap?.polymarketUrl && (
          <a className="fact link" href={l.snap.polymarketUrl} target="_blank" rel="noreferrer">
            <span className="fact-label">{t('mk.pmLink')}</span>
            <span className="fact-value">
              Polymarket <IconExternal size={13} />
            </span>
          </a>
        )}
      </div>

      <div className="ladder-cols" aria-hidden="true">
        <span>Tmax</span>
        <span>{t('mk.buyYes')}</span>
        <span>{t('mk.buyNo')}</span>
      </div>
      <ul className="strikes">
        {l.strikes.map((s) => (
          <StrikeRow key={s.seriesId} l={l} s={s} ph={ph} obsReached={today && obs !== null && obs >= s.k} onPick={() => onPick(s)} />
        ))}
      </ul>
      {booksAt && ph === 'open' && (
        <p className="fine right">
          {t('mk.updated')} {new Date(booksAt).toLocaleTimeString(lang === 'zh' ? 'zh-TW' : 'en-US', { hour12: false })}
        </p>
      )}
    </section>
  );
}

function PhaseBadge({ l, ph, now }: { l: LadderView; ph: LadderPhase; now: number }) {
  const { t, lang } = useI18n();
  if (ph === 'settled') return <span className="badge settled">{t('mk.settledAt', { t: l.result!.tmaxC })}</span>;
  if (ph === 'void') return <span className="badge void">{t('mk.void')}</span>;
  if (ph === 'awaiting') return <span className="badge wait">{t('mk.awaiting')}</span>;
  if (ph === 'closed') return <span className="badge wait">{t('mk.closed')}</span>;
  void now;
  void lang;
  return <span className="badge open">{t('pf.open')}</span>;
}

function StrikeRow({ l, s, ph, obsReached, onPick }: { l: LadderView; s: StrikeView; ph: LadderPhase; obsReached: boolean; onPick: () => void }) {
  const { t } = useI18n();
  const yesAsk = s.book.bestAsk;
  const noAsk = s.book.bestBid !== null ? 1 - s.book.bestBid : null;
  const fair = s.fair;
  const tag = fairTag(fair, s.fairSource);
  const resolved = ph === 'settled' || ph === 'void';
  const yesWon = l.result?.status === 1 ? l.result.tmaxC >= s.k : null;
  const flagged =
    s.flags.some((f) => /guard|diverg|disagree/.test(f)) ||
    (s.divergence ?? 0) > 0.15 ||
    (s.model !== null && s.pmImplied !== null && Math.abs(s.model - s.pmImplied) > 0.15);
  const certain = s.makerMode === 'certain' || s.flags.includes('observed-max>=k');
  const barP = fair ?? s.pmImplied ?? (yesAsk !== null && noAsk !== null ? (yesAsk + 1 - noAsk) / 2 : null);
  const disabled = ph !== 'open' || !s.market;
  return (
    <li>
      <button className={`strike ${disabled ? 'static' : ''}`} onClick={resolved ? undefined : onPick} aria-disabled={resolved}>
        <div className="strike-k">
          <span className="ge">≥</span>
          <span className="k num">{s.k}°</span>
        </div>
        {resolved ? (
          <div className="strike-result">
            {yesWon === null ? (
              <span className="pill void">0.5 / 0.5</span>
            ) : yesWon ? (
              <span className="pill yes">{t('mk.buyYes')} ✓</span>
            ) : (
              <span className="pill no">{t('mk.buyNo')} ✓</span>
            )}
          </div>
        ) : (
          <>
            <div className={`price yes ${yesAsk === null ? 'empty' : ''}`}>
              <span className="num">{s.market ? px(yesAsk) : '—'}</span>
            </div>
            <div className={`price no ${noAsk === null ? 'empty' : ''}`}>
              <span className="num">{s.market ? px(noAsk) : '—'}</span>
            </div>
          </>
        )}
        <div className="strike-meta">
          {!s.market && !resolved && <span className="muted">{t('mk.noBook')}</span>}
          {s.market && !resolved && (
            <>
              <span>
                {t('mk.fair')} <b className="num">{pct(fair)}</b>
                {tag && (
                  <span className="src-tag" title={t('mk.srcNote')} data-testid="fair-source">
                    {t(FAIR_TAG_KEY[tag])}
                  </span>
                )}
              </span>
              <span>
                {t('mk.pm')} <b className="num">{pct(s.pmImplied)}</b>
              </span>
              <span className="dim">
                {t('mk.model')} <b className="num">{pct(s.model)}</b>
                {flagged && (
                  <span className="flag" title={t('mk.flag')}>
                    {' '}
                    ⚑
                  </span>
                )}
              </span>
            </>
          )}
          {(obsReached || certain) && !resolved && <span className="pill yes small">{t('mk.reached')}</span>}
        </div>
        {!resolved && barP !== null && (
          <div className="bar" aria-hidden="true">
            <div className="bar-fill" style={{ width: `${Math.max(1, Math.min(99, barP * 100))}%` }} />
            {s.pmImplied !== null && <div className="bar-tick" style={{ left: `${s.pmImplied * 100}%` }} />}
          </div>
        )}
      </button>
    </li>
  );
}
