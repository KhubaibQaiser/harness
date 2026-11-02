import { defineConfig } from 'vitest/config';

// The e2e project drives the built CLI in throwaway repos, so it gets longer timeouts.
// Windows runners spawn git/npm and touch disk much slower (CI run 41382143251: windows-latest Node 22 hit 5 s in 3 tests).
const winTimeout = process.platform === 'win32' ? { testTimeout: 20_000 } : {};
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/e2e/**', 'test/perf/**', '**/node_modules/**'], ...winTimeout } },
      { test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } },
      // Timing tests: one file at a time, run alone (`pnpm test:perf`, its own CI step), never beside the parallel suite.
      { test: { name: 'perf', include: ['test/perf/**/*.test.ts'], fileParallelism: false } },
    ],
  },
});
