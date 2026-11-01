// Strict red-first gate: a source edit needs a fresh failing related test run from this session.
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isPaused } from '../../core/pause.js';
import { isTestFile, matches, toRepoPath } from '../../core/paths.js';
import type { Check } from '../../hooks/dispatch.js';
import { editTarget } from '../../hooks/edit-target.js';
import { newestFresh, readResults, relatedTests, resultsDir } from './results.js';

// Test files pairKey would pair with `rel`: .test/.spec siblings and a __tests__ copy.
const candidates = (rel: string): string[] => {
  const dir = dirname(rel);
  const name = basename(rel);
  return [sibling(rel), sibling(rel).replace('.test.', '.spec.'), join(dir, '__tests__', name)];
};

const sibling = (rel: string): string => rel.replace(/(\.[^./]+)$/, '.test$1');

export const redFirst: Check = {
  name: 'redFirst',
  events: ['PreToolUse'],
  run(ctx) {
    const p = editTarget(ctx.input);
    if (!ctx.config.checks.tdd || p === null) return { kind: 'allow' };
    const rel = toRepoPath(ctx.root, p);
    const { paths, exempt, results_dir } = ctx.config.tdd;
    if (rel === null || !matches(rel, paths) || matches(rel, exempt) || isTestFile(rel) || isPaused(ctx.root, ctx.input.session_id)) return { kind: 'allow' };

    const related = relatedTests(rel, readResults(ctx.root, resultsDir(ctx.root, ctx.config)));
    const fresh = [...newestFresh(related, ctx.state.startedAt).values()].sort((a, b) => b.writtenAt - a.writtenAt);
    if (fresh.some((r) => r.status === 'failed')) return { kind: 'allow' };
    if (fresh.length) return { kind: 'deny', reason: `Red first: ${fresh[0]!.file} is passing. Add or change a test so it fails, run it, then edit ${rel}.`, check: 'red-first' };
    if (related.length || candidates(rel).some((c) => existsSync(join(ctx.root, c)))) return { kind: 'deny', reason: `Run the test for \`${basename(rel)}\` and see it fail first, then edit.`, check: 'red-first' };
    return { kind: 'deny', reason: `No test for ${rel}. Write a failing test first (e.g. ${sibling(rel)}), run it, then edit.`, check: 'red-first' };
  },
};
