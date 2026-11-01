// A test seen failing is locked until a fresh passing run: changing it mid-green needs approval.
import { isPaused } from '../../core/pause.js';
import { isTestFile, matches, toRepoPath } from '../../core/paths.js';
import type { Check } from '../../hooks/dispatch.js';
import { editTarget } from '../../hooks/edit-target.js';
import { newestFresh, readResults, resultsDir } from './results.js';

export const testLock: Check = {
  name: 'testLock',
  events: ['PreToolUse', 'PostToolUse'],
  run(ctx) {
    const p = editTarget(ctx.input);
    if (!ctx.config.checks.tdd || !ctx.config.tdd.test_lock || p === null || isPaused(ctx.root, ctx.input.session_id)) return { kind: 'allow' };
    const rel = toRepoPath(ctx.root, p);
    if (rel === null || !matches(rel, ctx.config.tdd.paths) || matches(rel, ctx.config.tdd.exempt)) return { kind: 'allow' };
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
