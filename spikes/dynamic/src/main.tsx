import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DynamicContextProvider, mergeNetworks, type EvmNetwork } from '@dynamic-labs/sdk-react-core';
import { EthereumWalletConnectors } from '@dynamic-labs/ethereum';
import { App } from './App';
import { SetupNeeded } from './SetupNeeded';
import { DYNAMIC_ENVIRONMENT_ID, isConfigured } from './config';
import { monadMainnetDynamic, monadTestnetDynamic } from './lib/chains';
import './styles.css';

// Our Monad definitions win over whatever the dashboard sends (first arg takes
// precedence in mergeNetworks). Monad Testnet + Monad must ALSO be enabled in
// the dashboard (Chains & Networks), otherwise embedded-wallet ops can fail.
const ourNetworks: EvmNetwork[] = [
  { ...monadTestnetDynamic, isTestnet: true },
  { ...monadMainnetDynamic, isTestnet: false },
];

const root = createRoot(document.getElementById('root')!);

if (!isConfigured) {
  root.render(<SetupNeeded />);
} else {
  root.render(
    <StrictMode>
      <DynamicContextProvider
        settings={{
          environmentId: DYNAMIC_ENVIRONMENT_ID,
          appName: 'Isotherm',
          walletConnectors: [EthereumWalletConnectors],
          overrides: { evmNetworks: (dashboard) => mergeNetworks(ourNetworks, dashboard) },
          events: {
            onAuthSuccess: ({ user }) => console.info('[dynamic] auth success', user?.userId),
          },
        }}
      >
        <App />
      </DynamicContextProvider>
    </StrictMode>,
  );
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('sw register failed', e));
  });
}
