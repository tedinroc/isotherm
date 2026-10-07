import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dynamic's React SDK expects Node globals (process, global); Dynamic's quickstart uses a `define` block on Vite 5.
// The SDK is only loaded (code-split) when VITE_DYNAMIC_ENVIRONMENT_ID is set.
// The app calls same-origin /api (src/config.ts). Locally, /api is proxied to the live site (whose Pages Function
// forwards it to the API Worker); ISOTHERM_DEV_API=http://127.0.0.1:8781 points it at `wrangler dev` instead.
const apiProxy = {
  '/api': { target: process.env.ISOTHERM_DEV_API || 'https://isotherm.pages.dev', changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: apiProxy },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: apiProxy },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
  },
});
