// Done-contract costs, measured on a real temp repo. Runs in the `perf` project (no file parallelism). No retries: a slow result is real.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { type Contract, contractHash, setActiveTask, writeContract } from '../../src/done/contract.js';
import { readLedger } from '../../src/done/ledger.js';
import { treeHash } from '../../src/done/tree.js';
import { commit, git } from '../review/repo.js';
import { CEILING_MS, COUNTED_EDIT_OVERHEAD_MS, DISPATCH, measure, medianOf, OVERHEAD_MS, report as reportOverhead } from './overhead.js';

const PERF_CONTRACT: Contract = {
  id: 'perf', title: 'Perf', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
  criteria: [{ id: 'C1', text: 'builds', check: { run: 'node build.mjs', expect_exit: 0 } }], checks: ['test'], review: { model: 'sonnet' }, sha256: null,
};

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
  if (done) setActiveTask(root, writeContract(root, PERF_CONTRACT).id);
  return root;
}
const bashPost = (root: string, command: string) =>
  JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'lat', cwd: root, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false } });

// One sample took macOS 60-150 ms and Windows 268-602 ms (14-16 Nov 2026), against 1000; the failures on 14-15 Nov were
// vitest's old 5 s test timeout, not this ceiling. The median of 5 keeps one slow git spawn from deciding it.
test('tree hash of a 500-file repo stays under the ceiling', () => {
  const root = repo500();
  expect(medianOf('tree hash (500 files)', () => treeHash(root)).ms).toBeLessThan(CEILING_MS);
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

// A fresh clone or an unattended run has no task-hashes.json: origin's default branch vouches, which costs git calls, so a
// call that matches nothing must not load the contract at all (I3).
test('a non-check Bash PostToolUse with no local approval record (origin/HEAD vouches) stays within the plain hook overhead', () => {
  const root = repo500();
  commit(root, { '.harness/config.yaml': 'checks:\n  done: true\n', '.harness/tasks/perf.json': JSON.stringify({ ...PERF_CONTRACT, sha256: contractHash(PERF_CONTRACT) }, null, 2) + '\n' });
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  setActiveTask(root, 'perf');
  const m = measure(bashPost(root, 'ls'), (r) => expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']));
  reportOverhead('ledger-non-check-bash-no-approval-record', m);
  expect(readLedger(root)).toEqual([]);
  // Control: the contract is trusted through origin/HEAD, so a matched call records.
  expect(spawnSync(process.execPath, [DISPATCH], { input: bashPost(root, 'node build.mjs'), encoding: 'utf8' }).status).toBe(0);
  expect(readLedger(root)[0]).toMatchObject({ command: 'node build.mjs', exit: 0, criteria: ['C1'] });
  expect(m.overhead, `no-record overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(OVERHEAD_MS);
  expect(m.total, `no-record total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 60000);
