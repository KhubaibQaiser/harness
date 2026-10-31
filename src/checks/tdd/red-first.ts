// Strict red-first gate: a source edit needs a fresh failing related test run from this session.
import { join } from 'node:path';
import { isPaused } from '../../core/pause.js';
import { isTestFile, matches, toRepoPath } from '../../core/paths.js';
import type { Check } from '../../hooks/dispatch.js';
import { readResults, relatedTests, type TestFileResult } from './results.js';

const sibling = (rel: string): string => rel.replace(/(\.[^./]+)$/, '.test$1');

export const redFirst: Check = {
  name: 'redFirst',
  events: ['PreToolUse'],
  run(ctx) {
    const { tool_name, tool_input = {} } = ctx.input;
    const key = tool_name === 'NotebookEdit' ? 'notebook_path' : tool_name === 'Edit' || tool_name === 'Write' || tool_name === 'MultiEdit' ? 'file_path' : '';
    const p = key && tool_input[key];
    if (!ctx.config.checks.tdd || typeof p !== 'string' || !p) return { kind: 'allow' };
    const rel = toRepoPath(ctx.root, p);
    const { paths, exempt, results_dir } = ctx.config.tdd;
    if (rel === null || !matches(rel, paths) || matches(rel, exempt) || isTestFile(rel) || isPaused(ctx.root, ctx.input.session_id)) return { kind: 'allow' };

    // Newest result per test file; fresh ones are those written since the session started.
    const newest = new Map<string, TestFileResult>();
    for (const r of relatedTests(ctx.root, rel, readResults(ctx.root, join(ctx.root, results_dir)))) {
      const cur = newest.get(r.file);
      if (!cur || r.writtenAt > cur.writtenAt) newest.set(r.file, r);
    }
    const all = [...newest.values()].sort((a, b) => b.writtenAt - a.writtenAt);
    const fresh = all.filter((r) => r.writtenAt >= ctx.state.startedAt);
    if (fresh.some((r) => r.status === 'failed')) return { kind: 'allow' };
    if (fresh.length) return { kind: 'deny', reason: `Red first: ${fresh[0]!.file} is passing. Add or change a test so it fails, run it, then edit ${rel}.`, check: 'red-first' };
    return { kind: 'deny', reason: `No test for ${rel}. Write a failing test first (e.g. ${all[0]?.file ?? sibling(rel)}), run it, then edit.`, check: 'red-first' };
  },
};
