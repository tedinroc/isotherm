import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dynamic's React SDK expects Node globals (process, global). Per Dynamic's
// quickstart: use Vite 5 and a `define` block (NOT node-globals-polyfill).
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
});
