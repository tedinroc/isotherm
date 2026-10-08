import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // one viem for the Worker code and the shared packages/maker core it imports
    alias: [{ find: /^viem(\/.*)?$/, replacement: fileURLToPath(new URL('./node_modules/viem$1', import.meta.url)) }],
  },
  test: {
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
