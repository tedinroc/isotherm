import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dynamic's React SDK expects Node globals (process, global); Dynamic's quickstart uses a `define` block on Vite 5.
// The SDK is only loaded (code-split) when VITE_DYNAMIC_ENVIRONMENT_ID is set.
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
  },
});
