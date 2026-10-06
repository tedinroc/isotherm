import type { Address } from 'viem';
import { MONAD_TESTNET_ID } from './lib/chains';

const env = import.meta.env;

export const DYNAMIC_ENVIRONMENT_ID = (env.VITE_DYNAMIC_ENVIRONMENT_ID ?? '').trim();
export const RELAYER_URL = (env.VITE_RELAYER_URL ?? 'http://localhost:8790').replace(/\/$/, '');
export const CHAIN_ID = Number(env.VITE_CHAIN_ID ?? MONAD_TESTNET_ID);
export const DEPOSIT_TO = ((env.VITE_DEPOSIT_TO ?? '').trim() || undefined) as Address | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isConfigured = UUID.test(DYNAMIC_ENVIRONMENT_ID) && !/^0{8}-/.test(DYNAMIC_ENVIRONMENT_ID);
