import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 20 s: viem/React imports alone can take several seconds when the machine is busy; no test waits that long itself.
  test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 20_000 },
});
