/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DYNAMIC_ENVIRONMENT_ID?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_EXPLORER?: string;
  readonly VITE_ENV_LABEL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
