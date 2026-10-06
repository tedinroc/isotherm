// Monad network definitions in the shape Dynamic's DynamicContextProvider
// expects for `overrides.evmNetworks` (see Dynamic docs "Adding Custom Networks").
// Kept free of Dynamic imports so the relayer/e2e scripts can import it too.
import { monad, monadTestnet } from 'viem/chains';

export const MONAD_TESTNET_ID = 10143;
export const MONAD_MAINNET_ID = 143;

export const EXPLORER_TX: Record<number, string> = {
  [MONAD_TESTNET_ID]: 'https://testnet.monadvision.com/tx/',
  [MONAD_MAINNET_ID]: 'https://monadvision.com/tx/',
};

export const RPC_URL: Record<number, string> = {
  [MONAD_TESTNET_ID]: 'https://testnet-rpc.monad.xyz',
  [MONAD_MAINNET_ID]: 'https://rpc.monad.xyz',
};

const MON_ICON = 'https://app.dynamic.xyz/assets/networks/eth.svg'; // placeholder; replace with a Monad svg on your own domain

/** Structural copy of Dynamic's EvmNetwork type (required fields per docs). */
export interface DynamicEvmNetwork {
  blockExplorerUrls: string[];
  chainId: number;
  name: string;
  iconUrls: string[];
  nativeCurrency: { decimals: number; name: string; symbol: string; iconUrl?: string };
  networkId: number;
  rpcUrls: string[];
  vanityName?: string;
}

export const monadTestnetDynamic: DynamicEvmNetwork = {
  chainId: MONAD_TESTNET_ID,
  networkId: MONAD_TESTNET_ID,
  name: 'Monad Testnet',
  vanityName: 'Monad Testnet',
  iconUrls: [MON_ICON],
  nativeCurrency: { decimals: 18, name: 'Monad', symbol: 'MON', iconUrl: MON_ICON },
  rpcUrls: [RPC_URL[MONAD_TESTNET_ID]],
  blockExplorerUrls: ['https://testnet.monadvision.com/'],
};

export const monadMainnetDynamic: DynamicEvmNetwork = {
  chainId: MONAD_MAINNET_ID,
  networkId: MONAD_MAINNET_ID,
  name: 'Monad',
  vanityName: 'Monad',
  iconUrls: [MON_ICON],
  nativeCurrency: { decimals: 18, name: 'Monad', symbol: 'MON', iconUrl: MON_ICON },
  rpcUrls: [RPC_URL[MONAD_MAINNET_ID]],
  blockExplorerUrls: ['https://monadvision.com/'],
};

export const viemChains = { [MONAD_TESTNET_ID]: monadTestnet, [MONAD_MAINNET_ID]: monad } as const;
