import { createContext, useContext } from 'react';

export type Tab = 'markets' | 'portfolio' | 'history' | 'how';

export interface Ui {
  tab: Tab;
  setTab: (t: Tab) => void;
  openWallet: () => void;
}

export const UiContext = createContext<Ui>({ tab: 'markets', setTab: () => undefined, openWallet: () => undefined });
export const useUi = () => useContext(UiContext);
