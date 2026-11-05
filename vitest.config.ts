import { defineConfig } from 'vitest/config';

// Unit tests drive real git, npm and node processes, so their wall time follows the runner's load, not the code:
// 1-8 s on a busy Windows runner (CI runs 41382143251, 41383051207). One budget on every OS; it only catches hangs.
// Speed itself is asserted in the perf project. The e2e project drives the built CLI end to end and gets more.
const UNIT_TIMEOUT = 30_000;
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/e2e/**', 'test/perf/**', '**/node_modules/**'], setupFiles: ['test/setup-no-gh.ts'], testTimeout: UNIT_TIMEOUT, hookTimeout: UNIT_TIMEOUT } },
      { test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } },
      // Timing tests: one file at a time, run alone (`pnpm test:perf`, its own CI step), never beside the parallel suite.
      { test: { name: 'perf', include: ['test/perf/**/*.test.ts'], fileParallelism: false } },
    ],
  },
});
