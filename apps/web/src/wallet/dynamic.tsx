// Dynamic (email/Google login + embedded wallet), loaded only when VITE_DYNAMIC_ENVIRONMENT_ID is set.
// Monad testnet and mainnet are injected with overrides.evmNetworks (our definitions win over the dashboard's);
// they must also be enabled in the Dynamic dashboard. Dynamic's gas sponsorship does not cover Monad, so new
// users get MON from our own drip (apps/api).
import { useCallback, useMemo, type ReactNode } from 'react';
import { DynamicContextProvider, mergeNetworks, useDynamicContext, useIsLoggedIn, type EvmNetwork } from '@dynamic-labs/sdk-react-core';
import { EthereumWalletConnectors, isEthereumWallet } from '@dynamic-labs/ethereum';
import type { Address } from 'viem';
import { CHAIN_ID, DYNAMIC_ENVIRONMENT_ID, EXPLORER, RPC_URL } from '../config';
import type { Client, DynamicBridgeState, DynamicModule } from './wallet';

const ICON = '/icon.svg';
const networks: EvmNetwork[] = [
  {
    chainId: 10143,
    networkId: 10143,
    name: 'Monad Testnet',
    vanityName: 'Monad Testnet',
    iconUrls: [ICON],
    nativeCurrency: { decimals: 18, name: 'Monad', symbol: 'MON', iconUrl: ICON },
    rpcUrls: [RPC_URL],
    blockExplorerUrls: [`${EXPLORER}/`],
    isTestnet: true,
  },
  {
    chainId: 143,
    networkId: 143,
    name: 'Monad',
    vanityName: 'Monad',
    iconUrls: [ICON],
    nativeCurrency: { decimals: 18, name: 'Monad', symbol: 'MON', iconUrl: ICON },
    rpcUrls: ['https://rpc.monad.xyz'],
    blockExplorerUrls: ['https://monadvision.com/'],
    isTestnet: false,
  },
];

export function DynamicRoot({ children }: { children: ReactNode }) {
  return (
    <DynamicContextProvider
      settings={{
        environmentId: DYNAMIC_ENVIRONMENT_ID,
        appName: 'Isotherm',
        appLogoUrl: ICON,
        walletConnectors: [EthereumWalletConnectors],
        overrides: { evmNetworks: (dashboard) => mergeNetworks(networks, dashboard) },
        initialAuthenticationMode: 'connect-and-sign',
      }}
    >
      {children}
    </DynamicContextProvider>
  );
}

function useBridge(): DynamicBridgeState {
  const { primaryWallet, user, handleLogOut, setShowAuthFlow, sdkHasLoaded } = useDynamicContext();
  const loggedIn = useIsLoggedIn();
  const address = (primaryWallet?.address as Address | undefined) ?? null;
  const getClient = useCallback(async (): Promise<Client> => {
    if (!primaryWallet || !isEthereumWallet(primaryWallet)) throw new Error('No EVM wallet');
    try {
      if (Number(await primaryWallet.getNetwork()) !== CHAIN_ID) await primaryWallet.switchNetwork(CHAIN_ID);
    } catch {
      /* embedded wallets accept any configured chain id in getWalletClient */
    }
    return (await primaryWallet.getWalletClient(String(CHAIN_ID))) as unknown as Client;
  }, [primaryWallet]);
  return useMemo(
    () => ({
      available: true,
      sdkLoaded: sdkHasLoaded,
      loggedIn,
      address,
      email: user?.email ?? null,
      getClient: primaryWallet ? getClient : null,
      openLogin: () => setShowAuthFlow(true),
      logout: async () => {
        await handleLogOut();
      },
    }),
    [sdkHasLoaded, loggedIn, address, user?.email, primaryWallet, getClient, setShowAuthFlow, handleLogOut],
  );
}

export const dynamicModule: DynamicModule = { useBridge };
