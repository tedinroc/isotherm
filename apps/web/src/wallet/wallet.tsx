// Wallet layer. Two sources feed one context:
//   - Dynamic (email login, embedded MPC wallet) when VITE_DYNAMIC_ENVIRONMENT_ID is set (lazy-loaded SDK);
//   - a clearly-labelled dev wallet: a testnet burner key in this browser's localStorage, so judges and testers can
//     use the app without an account.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createWalletClient, http, type Account, type Address, type Chain, type Hex, type Transport, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { RPC_URL } from '../config';
import { chain } from '../lib/chain';

export type Client = WalletClient<Transport, Chain, Account>;

export interface DynamicBridgeState {
  available: boolean;
  sdkLoaded: boolean;
  loggedIn: boolean;
  address: Address | null;
  email: string | null;
  getClient: (() => Promise<Client>) | null;
  openLogin: () => void;
  logout: () => Promise<void>;
}

export interface DynamicModule {
  useBridge: () => DynamicBridgeState;
}

export interface WalletState {
  kind: 'dev' | 'dynamic' | null;
  address: Address | null;
  email: string | null;
  getClient: () => Promise<Client>;
  dynamicAvailable: boolean;
  dynamicLoading: boolean;
  openDynamicLogin: () => void;
  useDevWallet: () => void;
  exportDevKey: () => Hex | null;
  forgetDevWallet: () => void;
  logout: () => Promise<void>;
}

const KEY = 'isotherm.devwallet.v1';
const MODE = 'isotherm.walletmode.v1';

function readKey(): Hex | null {
  try {
    const k = localStorage.getItem(KEY);
    return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null;
  } catch {
    return null;
  }
}

const noBridge: DynamicBridgeState = {
  available: false,
  sdkLoaded: false,
  loggedIn: false,
  address: null,
  email: null,
  getClient: null,
  openLogin: () => undefined,
  logout: async () => undefined,
};

const WalletCtx = createContext<WalletState | null>(null);

export function WalletProvider({ dynamic, children }: { dynamic: DynamicModule | null; children: ReactNode }) {
  // `dynamic` never changes during the app's life, so the hook order is stable.
  const bridge = dynamic ? dynamic.useBridge() : noBridge;
  const [devKey, setDevKey] = useState<Hex | null>(() => readKey());
  const [mode, setMode] = useState<'dev' | 'dynamic' | null>(() => {
    try {
      const m = localStorage.getItem(MODE);
      return m === 'dev' || m === 'dynamic' ? m : null;
    } catch {
      return null;
    }
  });

  // A Dynamic login takes over the session.
  useEffect(() => {
    if (bridge.loggedIn && bridge.address) {
      setMode('dynamic');
      try {
        localStorage.setItem(MODE, 'dynamic');
      } catch {
        /* ignore */
      }
    }
  }, [bridge.loggedIn, bridge.address]);

  const devAccount = useMemo(() => (devKey ? privateKeyToAccount(devKey) : null), [devKey]);
  const devClient = useMemo(
    () => (devAccount ? (createWalletClient({ account: devAccount, chain, transport: http(RPC_URL) }) as Client) : null),
    [devAccount],
  );

  const useDevWallet = useCallback(() => {
    let k = readKey();
    if (!k) {
      k = generatePrivateKey();
      try {
        localStorage.setItem(KEY, k);
      } catch {
        /* private mode: key lives only in memory for this tab */
      }
    }
    setDevKey(k);
    setMode('dev');
    try {
      localStorage.setItem(MODE, 'dev');
    } catch {
      /* ignore */
    }
  }, []);

  const forgetDevWallet = useCallback(() => {
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(MODE);
    } catch {
      /* ignore */
    }
    setDevKey(null);
    setMode(null);
  }, []);

  const logout = useCallback(async () => {
    if (mode === 'dynamic') await bridge.logout();
    try {
      localStorage.removeItem(MODE);
    } catch {
      /* ignore */
    }
    setMode(null);
  }, [mode, bridge]);

  const kind: WalletState['kind'] =
    mode === 'dynamic' && bridge.loggedIn && bridge.address ? 'dynamic' : mode === 'dev' && devAccount ? 'dev' : null;
  const address = kind === 'dynamic' ? bridge.address : kind === 'dev' ? devAccount!.address : null;

  const getClient = useCallback(async (): Promise<Client> => {
    if (kind === 'dynamic' && bridge.getClient) return bridge.getClient();
    if (kind === 'dev' && devClient) return devClient;
    throw new Error('Sign in first');
  }, [kind, bridge, devClient]);

  const value: WalletState = {
    kind,
    address,
    email: kind === 'dynamic' ? bridge.email : null,
    getClient,
    dynamicAvailable: bridge.available,
    dynamicLoading: bridge.available && !bridge.sdkLoaded,
    openDynamicLogin: bridge.openLogin,
    useDevWallet,
    exportDevKey: () => (kind === 'dev' ? devKey : null),
    forgetDevWallet,
    logout,
  };
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): WalletState {
  const w = useContext(WalletCtx);
  if (!w) throw new Error('WalletProvider missing');
  return w;
}
