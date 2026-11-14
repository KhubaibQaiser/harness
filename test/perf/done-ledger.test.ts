// Done-contract costs, measured on a real temp repo. Runs in the `perf` project (no file parallelism). No retries: a slow result is real.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { type Contract, setActiveTask, writeContract } from '../../src/done/contract.js';
import { readLedger } from '../../src/done/ledger.js';
import { treeHash } from '../../src/done/tree.js';
import { commit, git } from '../review/repo.js';
import { CEILING_MS, COUNTED_EDIT_OVERHEAD_MS, measure, OVERHEAD_MS, report as reportOverhead } from './overhead.js';

const report = (name: string, ms: number) => writeSync(2, `[perf] ${name} ${process.platform}: ${ms.toFixed(1)} ms\n`);

/** A committed 500-file repo plus one untracked file; with `done`, checks.done on and an approved active contract checking `test`. */
function repo500(done = false): string {
  const root = mkdtempSync(join(tmpdir(), 'h-perf-tree-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) git(root, 'config', k!, v!);
  const files: Record<string, string> = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) };
  for (let i = 0; i < 500; i++) files[`src/d${i % 10}/f${i}.ts`] = `export const n${i} = ${i};\n`;
  if (done) files['.harness/config.yaml'] = 'checks:\n  done: true\n';
  commit(root, files);
  mkdirSync(join(root, 'src/new'), { recursive: true });
  writeFileSync(join(root, 'src/new/untracked.ts'), 'x');
  if (done) {
    const c: Contract = {
      id: 'perf', title: 'Perf', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
      criteria: [{ id: 'C1', text: 'builds', check: { run: 'node build.mjs', expect_exit: 0 } }], checks: ['test'], review: { model: 'sonnet' }, sha256: null,
    };
    setActiveTask(root, writeContract(root, c).id);
  }
  return root;
}
const bashPost = (root: string, command: string) =>
  JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'lat', cwd: root, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false } });

test('tree hash of a 500-file repo stays under the ceiling', () => {
  const root = repo500();
  treeHash(root); // warm the file-system cache
  const t = performance.now();
  treeHash(root);
  const ms = performance.now() - t;
  report('tree hash (500 files)', ms);
  expect(ms).toBeLessThan(CEILING_MS);
});

test('a non-check Bash PostToolUse with an active contract stays within the plain hook overhead', () => {
  const root = repo500(true);
  const m = measure(bashPost(root, 'ls'), (r) => expect([r.status, r.stdout]).toEqual([0, '']));
  expect(readLedger(root)).toEqual([]); // control: nothing matched, so no tree hash ran
  reportOverhead('ledger-non-check-bash', m);
  expect(m.overhead, `non-check overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(OVERHEAD_MS);
  expect(m.total, `non-check total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 60000);

// Provisional ceiling: the counted-edit one, until the CI log gives this case its own numbers (as latency.test.ts recalibrates).
test('a matched check PostToolUse on a 500-file repo: tree hash plus ledger row', () => {
  const root = repo500(true);
  const m = measure(bashPost(root, 'pnpm run test'), (r) => expect([r.status, r.stdout]).toEqual([0, '']));
  const rows = readLedger(root);
  expect(rows).toHaveLength(21); // control: every spawn recorded the run
  expect(rows[0]).toMatchObject({ command: 'pnpm run test', exit: 0, tree: treeHash(root) });
  reportOverhead('ledger-matched-check-500', m);
  expect(m.overhead, `matched check overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(COUNTED_EDIT_OVERHEAD_MS);
  expect(m.total, `matched check total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 60000);
