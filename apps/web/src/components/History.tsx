import { useMemo, useState } from 'react';
import type { Hex } from 'viem';
import { useI18n } from '../i18n';
import { useApp } from '../state';
import { checkSettlementTx, type AttestationCheck } from '../lib/settlement';
import { localTime, short } from '../lib/format';
import { formatDate, stationMeta, weekday } from '../lib/stations';
import { addrUrl, txUrl } from '../config';
import { phaseOf, useNow } from './Markets';
import { IconCheck, IconExternal, IconX } from './icons';
import type { LadderView } from '../lib/data';

interface Row {
  key: string;
  station: string;
  date: number;
  status: 'settled' | 'void' | 'awaiting';
  tmaxC: number | null;
  tx: Hex | null;
  finalAt: number | null;
  ladder: LadderView | null;
}

export function History() {
  const { t, lang } = useI18n();
  const { ladders, settlements } = useApp();
  const now = useNow(5000);

  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    for (const l of ladders ?? []) {
      const ph = phaseOf(l, now);
      if (ph !== 'settled' && ph !== 'void' && ph !== 'awaiting') continue;
      map.set(l.key, {
        key: l.key,
        station: l.station,
        date: l.date,
        status: ph === 'settled' ? 'settled' : ph === 'void' ? 'void' : 'awaiting',
        tmaxC: l.result && l.result.status === 1 ? l.result.tmaxC : null,
        tx: null,
        finalAt: l.result && l.result.status !== 0 ? l.result.finalAt : null,
        ladder: l,
      });
    }
    for (const s of settlements ?? []) {
      const key = `${s.station}-${s.date}`;
      const prev = map.get(key);
      map.set(key, {
        key,
        station: s.station,
        date: s.date,
        status: s.status === 1 ? 'settled' : 'void',
        tmaxC: s.status === 1 ? s.tmaxC : null,
        tx: s.tx,
        finalAt: s.finalAt ?? prev?.finalAt ?? null,
        ladder: prev?.ladder ?? null,
      });
    }
    return [...map.values()].sort((a, b) => Number(!!stationMeta(a.station).test) - Number(!!stationMeta(b.station).test) || b.date - a.date);
  }, [ladders, settlements, now]);

  return (
    <div className="screen">
      <section className="card">
        <h2 className="card-title">{t('hist.title')}</h2>
        {rows.length === 0 && <p className="muted">{ladders ? t('hist.empty') : t('misc.loading')}</p>}
        <ul className="hist">
          {rows.map((r) => (
            <HistRow key={r.key} r={r} lang={lang} />
          ))}
        </ul>
        <p className="fine">{t('hist.testNote')}</p>
      </section>
    </div>
  );
}

function HistRow({ r, lang }: { r: Row; lang: 'en' | 'zh' }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<AttestationCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = stationMeta(r.station);
  const strikes = r.ladder?.strikes ?? [];

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && r.tx && !check) {
      setLoading(true);
      try {
        setCheck(await checkSettlementTx(r.tx));
      } catch (e) {
        setErr((e as Error).message.split('\n')[0]);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <li className="hist-row">
      <div className="hist-main">
        <div>
          <div className="hist-title">
            {m.test ? `${t('mk.test')} ${r.station}` : m.city[lang]} · {weekday(r.date, lang)} {formatDate(r.date, lang)}
          </div>
          <div className="hist-sub">
            {r.status === 'settled' && (
              <span className="badge settled">
                {t('hist.tmax')} <b className="num">{r.tmaxC}°C</b>
              </span>
            )}
            {r.status === 'void' && <span className="badge void">{t('hist.void')}</span>}
            {r.status === 'awaiting' && <span className="badge wait">{t('hist.pending')}</span>}
          </div>
        </div>
        {r.tx && (
          <a className="txlink" href={txUrl(r.tx)} target="_blank" rel="noreferrer" aria-label={t('hist.report')}>
            {short(r.tx)} <IconExternal size={12} />
          </a>
        )}
      </div>
      {strikes.length > 0 && r.status !== 'awaiting' && (
        <div className="hist-strikes">
          {strikes.map((s) => {
            const yes = r.status === 'settled' && r.tmaxC !== null ? r.tmaxC >= s.k : null;
            return (
              <span key={s.seriesId} className={`pill ${yes === null ? 'void' : yes ? 'yes' : 'no'} small`}>
                ≥{s.k}° {yes === null ? '½' : yes ? '✓' : '✗'}
              </span>
            );
          })}
        </div>
      )}
      {r.tx && (
        <button className="link-btn" onClick={toggle}>
          {open ? t('hist.hide') : t('hist.details')}
        </button>
      )}
      {open && (
        <div className="attest">
          {loading && <p className="muted">{t('misc.loading')}</p>}
          {err && <p className="error small">{err}</p>}
          {check && check.kind === 'stale-void' && <p>{t('hist.staleVoid')}</p>}
          {check && check.kind === 'report' && (
            <dl className="kv">
              <dt>{t('hist.forwarder')}</dt>
              <dd>
                {check.forwarderKind === 'mock' ? t('hist.mock') : check.forwarderKind === 'keystone' ? t('hist.keystone') : short(check.to)}
              </dd>
              {check.workflowName && (
                <>
                  <dt>{t('hist.workflow')}</dt>
                  <dd className="mono small">
                    {check.workflowName} · id {short(check.workflowId)} · owner {short(check.workflowOwner)}
                  </dd>
                </>
              )}
              <dt>{t('hist.tmax')}</dt>
              <dd className="num">{check.isVoid ? t('hist.void') : `${check.tmaxC}°C`}</dd>
              <dt>{t('hist.attester')}</dt>
              <dd>
                {check.signer ? (
                  <a href={addrUrl(check.signer)} target="_blank" rel="noreferrer" className="mono">
                    {short(check.signer)}
                  </a>
                ) : (
                  '—'
                )}{' '}
                {check.matches ? (
                  <span className="ok-inline">
                    <IconCheck size={14} /> {t('hist.attOk')}
                  </span>
                ) : (
                  <span className="bad-inline">
                    <IconX size={14} /> {t('hist.attBad')}
                  </span>
                )}
              </dd>
              <dt>{t('hist.sources')}</dt>
              <dd className="mono small">{short(check.sourcesHash)}</dd>
              {r.finalAt ? (
                <>
                  <dt>{t('hist.finalAt')}</dt>
                  <dd>{localTime(r.finalAt, lang)}</dd>
                </>
              ) : null}
            </dl>
          )}
          {check && check.kind === 'other' && <p className="muted small">{short(check.to)}</p>}
        </div>
      )}
    </li>
  );
}
