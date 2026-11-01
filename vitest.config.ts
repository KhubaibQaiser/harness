import { defineConfig } from 'vitest/config';

// The e2e project drives the built CLI in throwaway repos, so it gets longer timeouts.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/e2e/**', '**/node_modules/**'] } },
      { test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } },
    ],
  },
});
