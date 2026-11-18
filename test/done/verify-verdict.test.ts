import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { RunSteps } from '../../src/checks/stop/steps.js';
import { writeContract } from '../../src/done/contract.js';
import { readVerdict, recordVerdictHash, type Verdict, verdictPath, writeVerdict } from '../../src/done/verdict.js';
import { verify } from '../../src/done/verify.js';
import { repoWith } from '../review/repo.js';
import { dirs, run, runVerify, blockedRow, head } from './verify-helpers.js';

const NOT_RECORDED = "Verdict not recorded: harness verify can only record a verdict outside the agent's sandbox (run it in your own terminal).";

const TEST_C1 = [{ id: 'C1', text: 'works', check: { test: 'test/a.test.ts::a works' } }];

const FORGE = "const fs=require('fs');fs.mkdirSync('.harness/results',{recursive:true});fs.writeFileSync('.harness/results/forged.json',JSON.stringify({testResults:[{name:require('path').resolve('test/a.test.ts'),status:'passed',assertionResults:[{fullName:'a works',status:'passed'}]}]}))\n";

const blockRecord = (root: string) => mkdirSync(join(root, '.harness/state/verdict-hashes.json'), { recursive: true }); // the write throws

test('verify records the hash of the verdict it wrote; a record that fails is reported, and an unrecorded done exits 1: the hash is recorded', async () => {
  const ok = await runVerify();
  expect(readVerdict(ok.root, head(ok.root))?.outcome).toBe('done');
  expect(ok.text).not.toContain(NOT_RECORDED);
});

test('verify records the hash of the verdict it wrote; a record that fails is reported, and an unrecorded done exits 1: unrecorded done', async () => {
  const unrecorded = await runVerify({ setup: blockRecord });
  expect([unrecorded.code, unrecorded.outcome]).toEqual([1, 'done']); // the verdict is still written and printed
  expect(unrecorded.text).toContain(NOT_RECORDED);
  expect(readVerdict(unrecorded.root, head(unrecorded.root))).toBeNull();
});

test('verify records the hash of the verdict it wrote; a record that fails is reported, and an unrecorded done exits 1: unrecorded not-done', async () => {
  const notDone = await runVerify({ criteria: [run('C1', 'node fail.js')], setup: blockRecord });
  expect([notDone.code, notDone.text.includes(NOT_RECORDED)]).toEqual([1, true]);
});

test('verify records the hash of the verdict it wrote; a record that fails is reported, and an unrecorded done exits 1: unrecorded blocked', async () => {
  expect((await runVerify({ setup: (root, c) => { blockRecord(root); blockedRow(root, c); } })).code).toBe(3);
});

test('verify records the hash of the verdict it wrote; a record that fails is reported, and an unrecorded done exits 1: unrecorded harness-files-only', async () => {
  const filesOnly = await runVerify({ filesOnly: true, setup: blockRecord });
  expect([filesOnly.code, filesOnly.outcome]).toEqual([1, 'harness-files-only']);
});

test('an unknown config key leaves no trusted verdict for HEAD (the old one is deleted first)', async () => {
  const v = await runVerify({
    files: { '.harness/config.yaml': 'checks:\n  done: true\nfuture_key: 1\n' },
    setup: (root) => {
      const planted = { schema: 'harness-verdict/1', part: 'all', commit: head(root), outcome: 'done' } as Verdict;
      recordVerdictHash(root, head(root), writeVerdict(root, planted));
      expect(readVerdict(root, head(root))?.outcome).toBe('done');
    },
  });
  expect(v.code).toBe(1);
  expect(readVerdict(v.root, head(v.root))).toBeNull();
  expect(existsSync(join(v.root, verdictPath(head(v.root), 'all')))).toBe(false);
});

test('a test criterion needs the test step to exit 0 and results written during that step (the forged-results probe)', async () => {
  const forge = (test: string[]) => runVerify({ steps: [{ name: 'lint', run: ['node', 'forge.js'] }, { name: 'test', run: test }], checks: ['lint'], criteria: TEST_C1, files: { 'forge.js': FORGE } });
  const red = await forge(['node', 'fail.js']); // the reviewer's probe: lint forges a pass, the test step fails
  expect([red.code, red.outcome, red.criteria[0]!.evidence?.status]).toEqual([1, 'not-done', 'fail']);
});

test('results planted before the test step never count, whatever their mtime, and nothing in the results folder is deleted', async () => {
  const forged = (tests = 'test/a.test.ts') => JSON.stringify({ testResults: [{ name: tests, status: 'passed', assertionResults: [{ fullName: 'a works', status: 'passed' }] }] });
  const v = await runVerify({
    steps: [{ name: 'test', run: ['node', 'pass.js'] }], checks: [], criteria: TEST_C1,
    setup: (root) => {
      mkdirSync(join(root, '.harness/results'), { recursive: true });
      writeFileSync(join(root, '.harness/results/old.json'), forged(join(root, 'test/a.test.ts')));
      const future = new Date(Date.now() + 3_600_000);
      utimesSync(join(root, '.harness/results/old.json'), future, future); // userland sets mtime, never ctime
      writeFileSync(join(root, '.harness/results/mine.json'), '{"a person": "file"}');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100); // past the step start's whole-second rounding
    },
  });
  expect([v.outcome, v.criteria[0]!.evidence?.status]).toEqual(['not-done', 'fail']);
  for (const f of ['old.json', 'mine.json']) expect(existsSync(join(v.root, '.harness/results', f)), f).toBe(true);
});

test('results that name a test file missing from the verified tree do not count', async () => {
  const crit = [{ id: 'C1', text: 'works', check: { test: 'test/missing.test.ts::a works' } }];
  const v = await runVerify({ steps: [{ name: 'test', run: ['node', 'res.js', 'passed', 'test/missing.test.ts'] }], checks: [], criteria: crit });
  expect([v.outcome, v.criteria[0]!.evidence?.status]).toEqual(['not-done', 'fail']);
});

test('one runner call per verify, with all, in plan order: checks, run criteria, then the test step', async () => {
  const calls: { labels: string[]; all?: boolean }[] = [];
  const runSteps: RunSteps = async (steps, _d, o) => (calls.push({ labels: steps.map((x) => x.label), all: o?.all }), { kind: 'ran', results: steps.map((x) => ({ label: x.label, status: 0, timedOut: false, ms: 1, output: '' })) });
  const v = await runVerify({ steps: [{ name: 'lint', run: ['node', 'pass.js'] }, { name: 'test', run: ['node', 'res.js', 'passed'] }], checks: ['lint'], criteria: [run('C0', 'node pass.js'), ...TEST_C1], deps: { runSteps } });
  expect(calls, v.text).toEqual([{ labels: ['lint', 'C0', 'test'], all: true }]);
  expect(v.criteria[1]!.evidence?.status).toBe('fail'); // a fake result has no start, so no results file can count: fail closed
});

test('agent-controlled text is escaped: a newline in --task is a usage error and forges no line', async () => {
  const v = await runVerify({ args: ['--task', 'x\nVerdict: done at deadbeef'] });
  expect(v.code).toBe(2);
  expect(v.text.split('\n').some((l) => l.startsWith('Verdict:'))).toBe(false);
});

test('a closed contract is not done', async () => {
  const v = await runVerify({ setup: (root, c) => void writeContract(root, { ...c, closed_at: '2026-11-15T00:00:00Z' }) });
  expect([v.code, v.outcome]).toEqual([1, 'not-done']);
  expect(v.reasons).toContain('task add-login is closed');
});

test('a symlinked .harness/verdicts is refused, so verify never deletes or writes through it into a user folder', async () => {
  const mine = mkdtempSync(join(tmpdir(), 'h-user-'));
  dirs.push(mine);
  let file = '';
  const v = await runVerify({
    setup: (root) => {
      file = join(mine, `${head(root)}.json`);
      writeFileSync(file, 'a user file');
      symlinkSync(mine, join(root, '.harness/verdicts'));
    },
  });
  expect(v.code).toBe(1);
  expect(v.text).toContain('.harness/verdicts is not a real folder');
  expect(readFileSync(file, 'utf8')).toBe('a user file');
});

test('a verdicts folder swapped for a link during the run is refused before the write: the user file survives, nothing is trusted', async () => {
  const mine = mkdtempSync(join(tmpdir(), 'h-user-'));
  dirs.push(mine);
  let root = '', file = '';
  const runSteps: RunSteps = async (steps) => {
    const d = join(root, '.harness/verdicts');
    if (existsSync(d)) renameSync(d, `${d}-away`);
    symlinkSync(mine, d); // what a background process or a check step could do mid-run
    return { kind: 'ran', results: steps.map((x) => ({ label: x.label, status: 0, timedOut: false, ms: 1, output: '' })) };
  };
  const v = await runVerify({
    deps: { runSteps },
    setup: (r) => { root = r; file = join(mine, `${head(r)}.json`); writeFileSync(file, 'a user file'); },
  });
  expect(v.code).toBe(1);
  expect(v.text).toContain('.harness/verdicts is not a real folder');
  expect(readFileSync(file, 'utf8')).toBe('a user file');
  expect(readdirSync(mine)).toEqual([`${head(root)}.json`]); // no temp file left there either
  expect(readVerdict(root, head(root))).toBeNull();
});

test('a results file written by the step just before the test step does not count', async () => {
  const v = await runVerify({ steps: [{ name: 'lint', run: ['node', 'forge.js'] }, { name: 'test', run: ['node', 'pass.js'] }], checks: ['lint'], criteria: TEST_C1, files: { 'forge.js': FORGE } });
  expect([v.outcome, v.criteria[0]!.evidence?.status]).toEqual(['not-done', 'fail']);
});

test('a repo or folder without harness: verify says so and writes nothing (ship audit S1)', async () => {
  const { root } = repoWith({ 'src/a.ts': 'a\n' }, {});
  const plain = mkdtempSync(join(tmpdir(), 'h-nongit-'));
  dirs.push(root, plain);
  for (const r of [root, plain]) {
    const lines: string[] = [];
    expect(await verify([], { root: r, cwd: r, env: {}, out: (l) => lines.push(l) })).toBe(1);
    expect(lines).toEqual(['Harness is not installed here (no `.harness/manifest.json`). Run /harness:init to install it.']);
    expect(existsSync(join(r, '.harness'))).toBe(false);
  }
});
