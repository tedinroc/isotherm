const env = import.meta.env;

/** Dynamic Sandbox environment id. When unset, the app offers only the clearly-labelled dev (burner) wallet. */
export const DYNAMIC_ENVIRONMENT_ID = (env.VITE_DYNAMIC_ENVIRONMENT_ID ?? '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DYNAMIC_ENABLED = UUID.test(DYNAMIC_ENVIRONMENT_ID) && !/^0{8}-/.test(DYNAMIC_ENVIRONMENT_ID);

export const CHAIN_ID = Number(env.VITE_CHAIN_ID ?? 10143);
export const RPC_URL = (env.VITE_RPC_URL ?? 'https://testnet-rpc.monad.xyz').trim();
/** API origin. Empty (the default) = same origin: on https://isotherm.pages.dev a Pages Function forwards /api/* to the
 *  API Worker (functions/api/[[path]].ts), and `npm run dev` / `npm run preview` proxy /api to the live site. */
export const API_URL = (env.VITE_API_URL ?? '').trim().replace(/\/$/, '');
export const EXPLORER = (env.VITE_EXPLORER ?? 'https://testnet.monadvision.com').replace(/\/$/, '');
/** e.g. "anvil fork" while testing locally; shown in the header so screenshots are never mistaken for live. */
export const ENV_LABEL = (env.VITE_ENV_LABEL ?? '').trim();

export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;

/** Monad bills the gas LIMIT, so user transactions use estimate × 1.10. */
export const GAS_MULTIPLIER_PCT = 110n;
