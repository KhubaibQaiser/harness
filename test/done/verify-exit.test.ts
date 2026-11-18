import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { defaultExec, type Exec } from '../../src/core/exec.js';
import { TASKS_DIR } from '../../src/done/contract.js';
import { VERIFY_USAGE } from '../../src/done/verify.js';
import { run, type Opts, runVerify, row, blockedRow, fake } from './verify-helpers.js';

test('a config that is not valid YAML names the file and the problem in one plain sentence', async () => {
  const v = await runVerify({ files: { '.harness/config.yaml': 'checks: [\n' } });
  expect(v.code).toBe(1);
  expect(v.text).toMatch(/^harness verify: `\.harness\/config\.yaml` is invalid: it is not valid YAML \(/);
});

test('fresh ledger rows are reused, stale ones re-run; the verdict records both', async () => {
  // A relative mark path: a tmpdir path has \\ on Windows and ~ in its 8.3 name (RUNNER~1), which plainArgv never counts.
  const mark = '.git/mark';
  const steps = ['s1', 's2'].map((n) => ({ name: n, run: ['node', 'mark.js', mark, n] }));
  const v = await runVerify({
    steps, files: { 'mark.js': "require('fs').appendFileSync(process.argv[2], process.argv[3] + '\\n')\n" },
    setup: (root, c) => { row(root, c, `node mark.js ${mark} s1`); row(root, c, `node mark.js ${mark} s2`, 'f'.repeat(40)); },
  });
  expect(v.outcome, v.text).toBe('done');
  expect(v.checks.map((x) => [x.name, x.evidence?.source, x.evidence?.status])).toEqual([['s1', 'reused', 'pass'], ['s2', 're-run', 'pass']]);
  expect(readFileSync(join(v.root, mark), 'utf8')).toBe('s2\n'); // only the stale one ran
  expect(v.criteria[0]!.evidence).toMatchObject({ command: 'node pass.js', exit: 0, source: 're-run', status: 'pass' });
  expect(v.text).toContain(`- s1 pass: node mark.js ${mark} s1 exit 0 (reused)`);
  expect(v.text).toContain(`- s2 pass: node mark.js ${mark} s2 exit 0 (re-run)`);
  expect(v.text).toContain('--- How to verify ---');
});

test('a fresh row whose command has a Windows path (\\ or an 8.3 ~) is re-run, never reused', async () => {
  const mark = '.git/mark';
  const steps = ['C:\\Users\\x', 'RUNNER~1'].map((n) => ({ name: n, run: ['node', 'mark.js', mark, n] }));
  const v = await runVerify({
    steps, files: { 'mark.js': "require('fs').appendFileSync(process.argv[2], process.argv[3] + '\\n')\n" },
    setup: (root, c) => { for (const s of steps) row(root, c, s.run.join(' ')); },
  });
  expect(v.outcome, v.text).toBe('done');
  expect(v.checks.map((x) => x.evidence?.source)).toEqual(['re-run', 're-run']);
  expect(readFileSync(join(v.root, mark), 'utf8')).toBe('C:\\Users\\x\nRUNNER~1\n');
});

test('exit codes: done 0', async () => {
  const done = await runVerify();
  expect([done.code, done.outcome]).toEqual([0, 'done']);
});

test('exit codes: failing criterion 1', async () => {
  const failing = await runVerify({ criteria: [run('C1', 'node fail.js')] });
  expect([failing.code, failing.outcome]).toEqual([1, 'not-done']);
  expect(failing.criteria[0]!.evidence).toMatchObject({ exit: 1, status: 'fail' });
});

test('exit codes: expect_exit is what passes', async () => {
  // A criterion that must exit 1 passes on 1.
  expect((await runVerify({ criteria: [run('C1', 'node fail.js', 1)] })).outcome).toBe('done');
});

test('exit codes: blocked 3', async () => {
  const blocked = await runVerify({ setup: blockedRow });
  expect([blocked.code, blocked.outcome, blocked.blocked]).toEqual([3, 'blocked', { reason: 'the API key is missing', failing_criteria: ['C1'] }]);
  expect(blocked.text).toContain('Blocked: the API key is missing');
});

test.each([['--nope'], ['--task'], ['--task', 'add-login', 'x'], ['--ci']].map((args) => [args.join(' '), args] as const))('exit codes: bad flag 2 (%s)', async (_n, args) => {
  const bad = await runVerify({ args: [...args] });
  expect(bad.code, JSON.stringify(args)).toBe(2);
  expect(bad.text).toContain(VERIFY_USAGE);
});

test('exit codes: --task with the contract id is done 0', async () => {
  expect((await runVerify({ args: ['--task', 'add-login'] })).code).toBe(0);
});

test('a check that edits a tracked file is not done', async () => {
  const v = await runVerify({ steps: [{ name: 'fmt', run: ['node', '-e', "require('fs').appendFileSync('src/a.ts','\\n')"] }] });
  expect(v.outcome, v.text).toBe('not-done');
  expect(v.reasons, v.text).toContain('the checks changed the working tree');
});

const file = (root: string) => join(root, TASKS_DIR, 'add-login.json');
const failClosed: [string, Opts, RegExp][] = [
  ['unreadable contract', { setup: (root) => writeFileSync(file(root), 'nope') }, /not valid JSON/],
  ['hash mismatch', { setup: (root) => writeFileSync(file(root), readFileSync(file(root), 'utf8').replace('Add login', 'Add logins')) }, /changed since it was approved/],
  ['missing tool', { steps: [{ name: 'lint', run: ['no-such-tool-h11'] }] }, /lint: no-such-tool-h11 is not on PATH/],
  ['timeout', { deps: fake({ kind: 'timeout' }) }, /timed out after 1800s \(done\.timeout_s\)/],
  ['git error', { deps: { git: ((c, a, x) => (a.includes('diff') ? { status: 128, stdout: '', stderr: 'fatal: boom' } : defaultExec(c, a, x))) as Exec } }, /tamper check: git listing changes failed \(128\): fatal: boom/],
  ['unknown base', { base: 'b'.repeat(40) }, /contract base bbbbbbb is not in this repo's history/],
  ['runner throw', { deps: fake(() => { throw new Error('spawn EACCES'); }) }, /the check runner failed: spawn EACCES/],
  ['result mismatch', { deps: fake({ kind: 'ran', results: [{ label: 'other', status: 0, timedOut: false, ms: 1, output: '' }] }) }, /the check runner's results don't match the plan/],
];
test.each(failClosed)('fail closed: %s', async (name, o, rx) => {
  const v = await runVerify(o);
  expect([v.code, v.outcome], name).toEqual([1, 'not-done']);
  expect(v.reasons.join('\n'), name).toMatch(rx);
  if (name === 'missing tool') expect(v.checks[0]!.evidence).toMatchObject({ status: 'missing', exit: null });
});
