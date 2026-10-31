// Strict red-first gate: a source edit needs a fresh failing related test run from this session.
import { isPaused } from '../../core/pause.js';
import { isTestFile, matches, toRepoPath } from '../../core/paths.js';
import type { Check } from '../../hooks/dispatch.js';
import { newestFresh, readResults, relatedTests, resultsDir } from './results.js';

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

    const related = relatedTests(ctx.root, rel, readResults(ctx.root, resultsDir(ctx.root, ctx.config)));
    const fresh = [...newestFresh(related, ctx.state.startedAt).values()].sort((a, b) => b.writtenAt - a.writtenAt);
    const newestFile = [...related].sort((a, b) => b.writtenAt - a.writtenAt)[0]?.file;
    if (fresh.some((r) => r.status === 'failed')) return { kind: 'allow' };
    if (fresh.length) return { kind: 'deny', reason: `Red first: ${fresh[0]!.file} is passing. Add or change a test so it fails, run it, then edit ${rel}.`, check: 'red-first' };
    return { kind: 'deny', reason: `No test for ${rel}. Write a failing test first (e.g. ${newestFile ?? sibling(rel)}), run it, then edit.`, check: 'red-first' };
  },
};
