import { useCallback, useEffect, useMemo, useState } from 'react';
import { I18nContext, initialLang, translate, type Lang } from './i18n';
import { AppStateProvider, useApp } from './state';
import { UiContext, useUi, type Tab } from './ui';
import { WalletProvider, useWallet, type DynamicModule } from './wallet/wallet';
import { Markets } from './components/Markets';
import { Portfolio } from './components/Portfolio';
import { History } from './components/History';
import { HowItWorks } from './components/HowItWorks';
import { WalletSheet } from './components/WalletSheet';
import { IconHistory, IconInfo, IconMarkets, IconMoon, IconSun, IconWallet, Logo } from './components/icons';
import { ENV_LABEL, txUrl } from './config';
import { short } from './lib/format';
import { useI18n } from './i18n';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  try {
    const s = localStorage.getItem('isotherm.theme');
    if (s === 'light' || s === 'dark') return s;
  } catch {
    /* ignore */
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const TABS: Tab[] = ['markets', 'portfolio', 'history', 'how'];

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#', '') as Tab;
  return TABS.includes(h) ? h : 'markets';
}

export function App({ dynamic }: { dynamic: DynamicModule | null }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [walletOpen, setWalletOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('isotherm.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-Hant-TW' : 'en';
  }, [lang]);
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('isotherm.lang', l);
    } catch {
      /* ignore */
    }
  }, []);
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    if (window.location.hash !== `#${t}`) history.replaceState(null, '', `#${t}`);
    window.scrollTo({ top: 0 });
  }, []);

  const i18n = useMemo(() => ({ lang, setLang, t: (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(lang, k, v) }), [lang, setLang]);
  const ui = useMemo(() => ({ tab, setTab, openWallet: () => setWalletOpen(true) }), [tab, setTab]);

  return (
    <I18nContext.Provider value={i18n}>
      <UiContext.Provider value={ui}>
        <WalletProvider dynamic={dynamic}>
          <AppStateProvider>
            <Shell theme={theme} setTheme={setTheme} />
            {walletOpen && <WalletSheet onClose={() => setWalletOpen(false)} />}
          </AppStateProvider>
        </WalletProvider>
      </UiContext.Provider>
    </I18nContext.Provider>
  );
}

function Shell({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const { t, lang, setLang } = useI18n();
  const wallet = useWallet();
  const app = useApp();
  const { tab, setTab } = useUi();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span className="brand-name">Isotherm</span>
          <span className="pill testnet">{t('app.testnet')}</span>
        </div>
        <div className="top-actions">
          <button className="icon-btn text" onClick={() => setLang(lang === 'en' ? 'zh' : 'en')} aria-label="Language">
            {lang === 'en' ? '中' : 'EN'}
          </button>
          <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Theme">
            {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
          </button>
          <WalletButton />
        </div>
      </header>
      {ENV_LABEL && <div className="envbar">{ENV_LABEL}</div>}
      <StatsStrip />
      <main>
        {tab === 'markets' && <Markets />}
        {tab === 'portfolio' && <Portfolio />}
        {tab === 'history' && <History />}
        {tab === 'how' && <HowItWorks />}
      </main>
      <nav className="tabbar" aria-label="Sections">
        {(
          [
            ['markets', t('nav.markets'), <IconMarkets key="m" />],
            ['portfolio', t('nav.portfolio'), <IconWallet key="p" />],
            ['history', t('nav.history'), <IconHistory key="h" />],
            ['how', t('nav.how'), <IconInfo key="i" />],
          ] as const
        ).map(([k, label, icon]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)} aria-current={tab === k ? 'page' : undefined}>
            {icon}
            <span>{label}</span>
            {k === 'portfolio' && wallet.address && (app.balances?.holdings.length ?? 0) > 0 && <span className="tab-dot" />}
          </button>
        ))}
      </nav>
      <Toasts />
    </div>
  );
}

function WalletButton() {
  const { t } = useI18n();
  const w = useWallet();
  const ui = useUi();
  return (
    <button className={`wallet-btn ${w.address ? 'on' : ''}`} onClick={ui.openWallet}>
      {w.address ? (
        <>
          <span className={`kind-dot ${w.kind}`} aria-hidden="true" />
          <span className="addr-head">{w.address.slice(0, 6)}</span>…{w.address.slice(-4)}
        </>
      ) : (
        t('wallet.signin')
      )}
    </button>
  );
}

function StatsStrip() {
  const { t } = useI18n();
  const { stats, statsError } = useApp();
  if (statsError && !stats) return <div className="stats muted">{t('stats.offline')}</div>;
  if (!stats || stats.empty) return <div className="stats muted">{t('stats.note')}</div>;
  return (
    <div className="stats" title={t('stats.note')}>
      <span>
        <b className="num">{stats.nonMakerWallets ?? 0}</b> {t(stats.nonMakerWallets === 1 ? 'stats.trader' : 'stats.traders')}
      </span>
      <span>
        <b className="num">{stats.nonMakerFills ?? 0}</b> {t(stats.nonMakerFills === 1 ? 'stats.fill' : 'stats.fills')}
      </span>
      <span>
        <b className="num">{stats.settledCityDays ?? 0}</b> {t(stats.settledCityDays === 1 ? 'stats.settledOne' : 'stats.settled')}
      </span>
      <span className="stats-note">{t('stats.note')}</span>
    </div>
  );
}

function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`} onClick={() => dismiss(x.id)}>
          {x.text}
          {x.hash && (
            <a href={txUrl(x.hash)} target="_blank" rel="noreferrer">
              {' '}
              {short(x.hash)}
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
