// App data: ladders (chain), snapshot + stats (API), balances (chain), a session activity log and toasts.
// Polling is gentle on the shared public RPC: one multicall for all books every 5 s while the page is visible.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { api, type Health, type SettlementRow, type Snapshot, type Stats } from './lib/api';
import { capabilities, loadBalances, loadLadders, refreshBooks, type Balances, type Capabilities, type LadderView } from './lib/data';
import { useWallet } from './wallet/wallet';
import { RPC_URL } from './config';

export interface Activity {
  t: number;
  label: string;
  hash?: Hex;
  ok: boolean;
  detail?: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'err' | 'info';
  hash?: Hex;
}

interface AppState {
  ladders: LadderView[] | null;
  laddersError: string | null;
  snapshot: Snapshot | null;
  stats: Stats | null;
  statsError: boolean;
  health: Health | null;
  settlements: SettlementRow[] | null;
  caps: Capabilities | null;
  balances: Balances | null;
  booksAt: number | null;
  activity: Activity[];
  toasts: Toast[];
  refreshAll: () => Promise<void>;
  refreshBalances: () => Promise<void>;
  refreshBooksNow: () => Promise<void>;
  log: (a: Omit<Activity, 't'>) => void;
  toast: (text: string, kind?: Toast['kind'], hash?: Hex) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<AppState | null>(null);

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

export function AppStateProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const [ladders, setLadders] = useState<LadderView[] | null>(null);
  const [laddersError, setLaddersError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [settlements, setSettlements] = useState<SettlementRow[] | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [booksAt, setBooksAt] = useState<number | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const laddersRef = useRef<LadderView[] | null>(null);
  const snapRef = useRef<Snapshot | null>(null);
  const toastId = useRef(1);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info', hash?: Hex) => {
    const id = toastId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, kind, hash }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 9000 : 6000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const log = useCallback((a: Omit<Activity, 't'>) => setActivity((l) => [{ ...a, t: Date.now() }, ...l].slice(0, 30)), []);

  const refreshLadders = useCallback(async () => {
    // Cached once every capability read has succeeded; until then each refresh asks the chain again (and loadLadders
    // below shares this in-flight read rather than starting its own).
    capabilities()
      .then(setCaps)
      .catch(() => undefined);
    try {
      const v = await loadLadders(snapRef.current);
      laddersRef.current = v;
      setLadders(v);
      setBooksAt(Date.now());
      setLaddersError(null);
    } catch (e) {
      setLaddersError((e as Error).message?.split('\n')[0] ?? 'failed');
    }
  }, []);

  const refreshSnapshot = useCallback(async () => {
    try {
      let s = await api.snapshot();
      // A snapshot produced against a local fork must never decorate the live chain (and vice versa).
      const forkSnap = !!s.rpcKind && /fork|anvil/i.test(s.rpcKind);
      const forkApp = /127\.0\.0\.1|localhost/.test(RPC_URL);
      if (forkSnap !== forkApp && s.rpcKind) s = { ladders: [], empty: true };
      snapRef.current = s;
      setSnapshot(s);
    } catch {
      /* API down: chain-only view still works */
    }
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await api.stats());
      setStatsError(false);
    } catch {
      setStatsError(true);
    }
    api.settlements().then((r) => setSettlements(r.settlements ?? [])).catch(() => undefined);
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const refreshBooksNow = useCallback(async () => {
    const v = laddersRef.current;
    if (!v) return;
    const open = v.filter((l) => !l.result || l.result.status === 0);
    try {
      await refreshBooks(open);
      setLadders([...v]);
      setBooksAt(Date.now());
    } catch {
      /* transient RPC failure */
    }
  }, []);

  const address = wallet.address;
  const refreshBalances = useCallback(async () => {
    const v = laddersRef.current;
    if (!address || !v) {
      setBalances(null);
      return;
    }
    try {
      setBalances(await loadBalances(address, v));
    } catch {
      /* keep last */
    }
  }, [address]);

  const refreshAll = useCallback(async () => {
    await refreshSnapshot();
    await refreshLadders();
    await refreshBalances();
  }, [refreshSnapshot, refreshLadders, refreshBalances]);

  useEffect(() => {
    capabilities().then(setCaps).catch(() => undefined);
    (async () => {
      await refreshSnapshot();
      await refreshLadders();
    })();
    refreshStats();
    const books = setInterval(() => visible() && refreshBooksNow(), 5000);
    const structure = setInterval(() => visible() && refreshLadders(), 60_000);
    const snap = setInterval(() => visible() && refreshSnapshot().then(() => undefined), 30_000);
    const st = setInterval(() => visible() && refreshStats(), 60_000);
    return () => {
      clearInterval(books);
      clearInterval(structure);
      clearInterval(snap);
      clearInterval(st);
    };
  }, [refreshSnapshot, refreshLadders, refreshStats, refreshBooksNow]);

  useEffect(() => {
    if (!ladders) return;
    refreshBalances();
    const id = setInterval(() => visible() && refreshBalances(), 8000);
    return () => clearInterval(id);
  }, [refreshBalances, ladders === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const value: AppState = {
    ladders,
    laddersError,
    snapshot,
    stats,
    statsError,
    health,
    settlements,
    caps,
    balances,
    booksAt,
    activity,
    toasts,
    refreshAll,
    refreshBalances,
    refreshBooksNow,
    log,
    toast,
    dismiss,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppStateProvider missing');
  return v;
}
