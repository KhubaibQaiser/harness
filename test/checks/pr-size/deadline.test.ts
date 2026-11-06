// End to end through the real dispatch path: a slow check ahead of pr-size, then pr-size with a slow git. Date is faked
// (the smallest clock the dispatcher, its process-start time and pr-size all read), so the test runs in milliseconds.
import { afterEach, expect, test, vi } from 'vitest';
import { decidePrSize, prSize } from '../../../src/checks/pr-size/check.js';
import type { Git } from '../../../src/checks/pr-size/measure.js';
import type { Check } from '../../../src/hooks/dispatch.js';
import { PR_URL, repo } from './helpers.js';

const HOOK_TIMEOUT_MS = 10_000; // Claude Code's hook timeout for the harness hooks
const SLOW_GUARD_MS = 8_500;
const MARGIN_MS = 1_000;

afterEach(() => void vi.useRealTimers());

test('a guard that takes 8.5 s leaves pr-size its remainder: the hook ends under 9 s with the note', async () => {
  const root = repo();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now());
  vi.resetModules();
  const { dispatch } = await import('../../../src/hooks/dispatch.js'); // its process-start time is now
  const start = Date.now();
  const slowGuard: Check = { name: 'slow', events: ['PreToolUse'], run: () => (vi.setSystemTime(Date.now() + SLOW_GUARD_MS), { kind: 'allow' }) };
  const timeouts: number[] = [];
  // Each call takes its whole timeout, as a hung git would.
  const slowGit: Git = (args, timeout) => (timeouts.push(timeout), vi.setSystemTime(Date.now() + timeout), { status: 0, stdout: args.includes('diff') ? '' : 'abc\n' });
  const raw = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'gh pr create --base a' }, tool_response: PR_URL });
  const out = JSON.parse(await dispatch(raw, [slowGuard, { ...prSize, run: (c) => decidePrSize(c, slowGit) }], {}));
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThanOrEqual(HOOK_TIMEOUT_MS - MARGIN_MS);
  expect(timeouts.length).toBeGreaterThan(0);
  expect(out.hookSpecificOutput.additionalContext).toMatch(/^Note from pr-size: harness couldn't measure this pull request \(git timed out\)/);
});
