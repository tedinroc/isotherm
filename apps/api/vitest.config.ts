import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
