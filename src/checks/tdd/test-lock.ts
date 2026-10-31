// A test seen failing is locked until a fresh passing run: changing it mid-green needs approval.
import { isPaused } from '../../core/pause.js';
import { isTestFile, toRepoPath } from '../../core/paths.js';
import type { Check } from '../../hooks/dispatch.js';
import { newestFresh, readResults, resultsDir } from './results.js';

export const testLock: Check = {
  name: 'testLock',
  events: ['PreToolUse', 'PostToolUse'],
  run(ctx) {
    const { tool_name, tool_input = {} } = ctx.input;
    const p = tool_name === 'Edit' || tool_name === 'Write' || tool_name === 'MultiEdit' ? tool_input.file_path : '';
    if (!ctx.config.checks.tdd || !ctx.config.tdd.test_lock || typeof p !== 'string' || !p || isPaused(ctx.root, ctx.input.session_id)) return { kind: 'allow' };
    const rel = toRepoPath(ctx.root, p);
    if (rel === null) return { kind: 'allow' };
    const s = ctx.state;
    if (ctx.input.hook_event_name === 'PostToolUse') {
      if (isTestFile(rel) && !s.redTests.includes(rel)) ctx.save({ ...s, redTests: [...s.redTests, rel] });
      return { kind: 'allow' };
    }
    const latest = newestFresh(readResults(ctx.root, resultsDir(ctx.root, ctx.config)), s.startedAt);
    const red = s.redTests.filter((f) => latest.get(f)?.status === 'failed');
    const locked = [...new Set([...s.lockedTests, ...red])].filter((f) => latest.get(f)?.status !== 'passed');
    if (red.length || locked.length !== s.lockedTests.length) ctx.save({ ...s, lockedTests: locked });
    return locked.includes(rel)
      ? { kind: 'ask', reason: `${rel} was written as a failing test. Changing it while making it pass needs your approval.`, check: 'test-lock' }
      : { kind: 'allow' };
  },
};
