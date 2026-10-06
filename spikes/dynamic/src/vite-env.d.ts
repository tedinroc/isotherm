/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_DYNAMIC_ENVIRONMENT_ID?: string;
  readonly VITE_RELAYER_URL?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_DEPOSIT_TO?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
