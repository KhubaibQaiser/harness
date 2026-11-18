import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { TASKS_DIR } from '../../src/done/contract.js';
import { git } from '../review/repo.js';
import { run, runVerify, row, blockedRow, fake } from './verify-helpers.js';

const NESTED = "harness verify can't run its checks inside another sandbox. Ask the person to run harness verify in their own terminal, or ! harness verify (outside the sandbox on macOS, and on Linux without the env scrub).";

const T = (body: string) => `test('a', () => {\n${body}\n});\n`;

test('verify exits not done from sandboxed Bash: an unavailable runner gives the srt message, then the nested-sandbox line', async () => {
  const v = await runVerify({ deps: fake({ kind: 'unavailable', message: 'Stop steps could not run: sandbox-runtime (srt) is not installed.', reason: 'missing' }) });
  expect([v.code, v.outcome]).toEqual([1, 'not-done']);
  expect(v.reasons.slice(0, 2)).toEqual(['Stop steps could not run: sandbox-runtime (srt) is not installed.', NESTED]);
  expect(v.criteria[0]!.evidence).toBeNull();
});

test('sandbox: off and native Windows run unwrapped, with a note', async () => {
  expect((await runVerify()).text).toContain('Stop steps ran without the sandbox (sandbox: off).');
  const win = await runVerify({ platform: 'win32', files: { '.harness/config.yaml': 'checks:\n  done: true\n' }, deps: { which: (cmd) => cmd } });
  expect(win.outcome, win.text).toBe('done');
  expect(win.text).toContain('Stop steps ran without the sandbox (native Windows).');
});

test('test criteria run the test step once and pass on a passed result; a failed result fails them', async () => {
  const crit = [{ id: 'C2', text: 'works', check: { test: 'test/a.test.ts::a works' } }];
  const pass = await runVerify({ steps: [{ name: 'test', run: ['node', 'res.js', 'passed'] }], checks: [], criteria: crit });
  expect(pass.outcome, pass.text).toBe('done');
  expect(pass.criteria[0]!.evidence).toMatchObject({ command: 'node res.js passed', status: 'pass', source: 're-run' });
  const fail = await runVerify({ steps: [{ name: 'test', run: ['node', 'res.js', 'failed'] }], checks: [], criteria: crit });
  expect(fail.criteria[0]!.evidence).toMatchObject({ status: 'fail' });
  expect((await runVerify({ checks: [], criteria: crit })).reasons.join('\n')).toMatch(/C2: no stop step named test resolves here/);
  // A fresh row listing the criterion is reused.
  const reused = await runVerify({ steps: [{ name: 'test', run: ['node', 'fail.js'] }], checks: [], criteria: crit, setup: (root, c) => row(root, c, 'node fail.js', undefined, ['C2']) });
  expect(reused.criteria[0]!.evidence).toMatchObject({ source: 'reused', status: 'pass' });
});

test('blocked still loses to a tamper finding', async () => {
  const v = await runVerify({
    files: { 'a.test.ts': T('expect(1).toBe(1);') },
    setup: (root, c) => { writeFileSync(join(root, 'a.test.ts'), "test.skip('a', () => {\nexpect(1).toBe(1);\n});\n"); blockedRow(root, c); },
  });
  expect([v.code, v.outcome]).toEqual([1, 'not-done']);
  expect(v.tamper).toContain('a.test.ts: .skip( added');
  expect(v.text).toContain('tamper: a.test.ts: .skip( added');
});

test('a branch holding only the approved contract is harness-files-only, exit 0', async () => {
  const v = await runVerify({ filesOnly: true, criteria: [run('C1', 'node fail.js')] });
  expect([v.code, v.outcome]).toEqual([0, 'harness-files-only']);
  // A changed contract that doesn't validate is not harness-files-only.
  const bad = await runVerify({ filesOnly: true, setup: (root) => writeFileSync(join(root, TASKS_DIR, 'other.json'), '{}') });
  expect(bad.outcome).toBe('not-done');
});

test('the verdict is bound to commit and tree: clean is false on a dirty tree', async () => {
  const dirty = await runVerify();
  expect(dirty.clean).toBe(false);
  expect(dirty.text).toContain('harness verify (working tree not clean)');
  expect(dirty.tree).not.toBe(git(dirty.root, 'rev-parse', 'HEAD^{tree}').trim());
  const clean = await runVerify({ setup: (root) => { git(root, 'add', 'src', TASKS_DIR); git(root, 'commit', '-q', '-m', 'work'); } });
  const head = git(clean.root, 'rev-parse', 'HEAD').trim();
  expect([clean.clean, clean.commit, clean.tree]).toEqual([true, head, git(clean.root, 'rev-parse', 'HEAD^{tree}').trim()]);
  expect(clean.text).toContain(`Verdict: done at ${head} (tree ${clean.tree}), task add-login, harness verify`);
});

test('a file a check command names is a tamper finding when it changes (namedPaths)', async () => {
  const v = await runVerify({
    steps: [{ name: 'ci', run: ['node', 'scripts/ci.js'] }], criteria: [run('C1', 'node tools/check.js')],
    files: { 'scripts/ci.js': 'process.exit(0)\n', 'tools/check.js': 'process.exit(0)\n' },
    setup: (root) => { writeFileSync(join(root, 'scripts/ci.js'), 'process.exit(0)//\n'); writeFileSync(join(root, 'tools/check.js'), 'process.exit(0)//\n'); },
  });
  expect(v.tamper).toEqual(['scripts/ci.js: file named by a package.json script changed', 'tools/check.js: file named by a package.json script changed']);
});

test('merge-base ignores grafts, so a graft cannot move the base', async () => {
  let base = '';
  const v = await runVerify({
    setup: (root, c) => {
      base = c.base;
      writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
      git(root, 'add', 'b.ts');
      git(root, 'commit', '-q', '-m', 'more');
      const head = git(root, 'rev-parse', 'HEAD').trim();
      writeFileSync(join(root, '.git/info/grafts'), `${head}\n`); // HEAD with no parents
      expect(() => git(root, 'merge-base', base, head)).toThrow(); // the control: plain git honours the graft
    },
  });
  expect(v.reasons.join('\n')).not.toMatch(/not in this repo's history/);
  expect([v.base, v.outcome]).toEqual([base, 'done']);
});
