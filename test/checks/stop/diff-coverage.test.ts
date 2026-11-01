import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { changedLines, coveredLines, diffCoverage, formatLines } from '../../../src/checks/stop/diff-coverage.js';
import { runStop, type Exec } from '../../../src/checks/stop/gate.js';
import { loadConfig, type HarnessConfig } from '../../../src/core/config.js';
import type { Ctx } from '../../../src/hooks/dispatch.js';

const fx = (p: string) => readFileSync(join(__dirname, '../../fixtures', p), 'utf8');
const cfgOf = (over: Partial<HarnessConfig['tdd']> = {}): HarnessConfig => {
  const c = loadConfig(mkdtempSync(join(tmpdir(), 'h-dc-'))).config;
  c.tdd = { ...c.tdd, paths: ['src/**'], exempt: ['src/gen/**'], ...over };
  return c;
};
const FRESH = Date.now() / 1000;
function repo(coverage: Record<string, unknown> | null, { mtime = FRESH + 10, file = 'coverage/coverage-final.json' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'h-dc-'));
  if (coverage) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(coverage).replaceAll('/ROOT', root));
    utimesSync(join(root, file), mtime, mtime);
  }
  return root;
}
const istanbul = () => JSON.parse(fx('coverage/coverage-final.json'));
// Fake git: merge-base, diff, ls-files (untracked) answers; records calls.
function gitExec(o: { diff?: string; untracked?: string; mergeBase?: { status: number; output: string } }) {
  const calls: { args: string[]; ms: number }[] = [];
  const exec: Exec = (_c, args, ms) => {
    calls.push({ args, ms });
    const ok = (output: string) => ({ status: 0, output, timedOut: false });
    if (args[0] === 'merge-base') return { ...(o.mergeBase ?? ok('BASE\n')), timedOut: false };
    if (args[0] === 'diff') return ok(o.diff ?? '');
    if (args[0] === 'ls-files') return ok(o.untracked ?? '');
    return ok('');
  };
  return { exec, calls };
}
const addDiff = (file: string, lines: number[]) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` + lines.map((l) => `@@ -${l} +${l} @@\n-x\n+y`).join('\n') + '\n';
const opts = { baseHead: undefined as string | undefined, since: FRESH };

test('changedLines parses the real sample diff: added and modified lines, deletions ignored', () => {
  const m = changedLines(fx('diff/sample.diff'));
  expect([...m.keys()]).toEqual(['src/a.ts']);
  expect([...m.get('src/a.ts')!]).toEqual([3, 5, 6]);
});

test('changedLines: pure deletion hunks (+n,0) add nothing; new files and ranges work', () => {
  const d = 'diff --git a/n.ts b/n.ts\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n@@ -9,2 +11,0 @@\n-x\n-y\n';
  expect([...changedLines(d).get('n.ts')!]).toEqual([1, 2, 3]);
});

test('coveredLines maps absolute keys to repo paths, executable = statement ranges, covered = hit statements', () => {
  const root = repo(null);
  const raw = JSON.parse(fx('coverage/coverage-final.json').replaceAll('/ROOT', root));
  raw['/elsewhere/x.ts'] = raw[`${root}/src/a.ts`];
  const m = coveredLines(raw, root);
  expect([...m.keys()]).toEqual(['src/a.ts']);
  const f = m.get('src/a.ts')!;
  expect([...f.executable].sort()).toEqual([2, 3, 4, 5, 6]);
  expect([...f.covered].sort()).toEqual([2, 3, 4, 6]);
});

test('diffCoverage: 2 of 4 executable changed lines covered is 50%', () => {
  const cov = istanbul();
  cov['/ROOT/src/a.ts'].statementMap['4'] = { start: { line: 7, column: 0 }, end: { line: 7, column: 5 } };
  cov['/ROOT/src/a.ts'].s['4'] = 0;
  const root = repo(cov);
  const { exec } = gitExec({ diff: addDiff('src/a.ts', [3, 5, 6, 7]) });
  const r = diffCoverage(root, cfgOf(), exec, opts);
  expect(r).toMatchObject({ pct: 50, total: 4, covered: 2, uncovered: [{ file: 'src/a.ts', lines: [5, 7] }] });
});

test('non-executable changed lines, test files, exempt and out-of-scope files are ignored', () => {
  const root = repo(istanbul());
  const diff = addDiff('src/a.ts', [1, 3]) + addDiff('src/a.test.ts', [1]) + addDiff('src/gen/g.ts', [1]) + addDiff('lib/o.ts', [1]);
  const r = diffCoverage(root, cfgOf(), gitExec({ diff }).exec, opts);
  expect(r).toMatchObject({ pct: 100, total: 1, covered: 1, uncovered: [] });
});

test('no changes means 100 and needs no coverage file', () => {
  const r = diffCoverage(repo(null), cfgOf(), gitExec({}).exec, opts);
  expect(r).toMatchObject({ pct: 100, total: 0, covered: 0, uncovered: [] });
  expect(r.problem).toBeUndefined();
});

test('changes in scope but only non-executable lines gives 100', () => {
  const r = diffCoverage(repo(istanbul()), cfgOf(), gitExec({ diff: addDiff('src/a.ts', [1]) }).exec, opts);
  expect(r.pct).toBe(100);
});

test('untracked files count with all lines added; missing from every report means all uncovered', () => {
  const root = repo(istanbul());
  writeFileSync(join(root, 'n.txt'), '');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/new.ts'), 'a\nb\nc\n');
  const r = diffCoverage(root, cfgOf(), gitExec({ untracked: 'src/new.ts\nn.txt\n' }).exec, opts);
  expect(r).toMatchObject({ pct: 0, total: 3, covered: 0, uncovered: [{ file: 'src/new.ts', lines: [1, 2, 3] }] });
});

test('a tracked changed file missing from every report counts all changed lines uncovered', () => {
  const r = diffCoverage(repo(istanbul()), cfgOf(), gitExec({ diff: addDiff('src/other.ts', [4, 5]) }).exec, opts);
  expect(r).toMatchObject({ pct: 0, total: 2, uncovered: [{ file: 'src/other.ts', lines: [4, 5] }] });
});

test('merges every report matching coverage_globs; a line covered in any report counts', () => {
  const second = istanbul();
  second['/ROOT/src/a.ts'].s = { 0: 0, 1: 0, 2: 1, 3: 0 };
  const root = repo(istanbul());
  mkdirSync(join(root, 'pkg/coverage'), { recursive: true });
  writeFileSync(join(root, 'pkg/coverage/coverage-final.json'), JSON.stringify(second).replaceAll('/ROOT', root));
  utimesSync(join(root, 'pkg/coverage/coverage-final.json'), FRESH + 10, FRESH + 10);
  mkdirSync(join(root, 'node_modules/x/coverage'), { recursive: true });
  writeFileSync(join(root, 'node_modules/x/coverage/coverage-final.json'), '{"bad json');
  const r = diffCoverage(root, cfgOf(), gitExec({ diff: addDiff('src/a.ts', [3, 5, 6]) }).exec, opts);
  expect(r).toMatchObject({ pct: 100, total: 3, covered: 3 });
});

test('stale coverage (mtime before the steps started) is ignored: no fresh file blocks via problem', () => {
  const root = repo(istanbul(), { mtime: FRESH - 100 });
  const r = diffCoverage(root, cfgOf(), gitExec({ diff: addDiff('src/a.ts', [3]) }).exec, opts);
  expect(r.problem).toBe('no-fresh-coverage');
  expect(diffCoverage(repo(null), cfgOf(), gitExec({ diff: addDiff('src/a.ts', [3]) }).exec, opts).problem).toBe('no-fresh-coverage');
});

test('base: merge-base against base_ref, every git call uses the 5000 ms timeout', () => {
  const g = gitExec({ diff: addDiff('src/a.ts', [3]) });
  diffCoverage(repo(istanbul()), cfgOf(), g.exec, opts);
  expect(g.calls[0].args).toEqual(['merge-base', 'HEAD', 'origin/main']);
  expect(g.calls[1].args).toEqual(['diff', '--relative', '-U0', 'BASE']);
  expect(g.calls.some((c) => c.args[0] === 'ls-files' && c.args.includes('--exclude-standard'))).toBe(true);
  expect(g.calls.every((c) => c.ms === 5000)).toBe(true);
});

test('base: falls back to state.baseHead when merge-base fails; neither means no-base', () => {
  const fail = { status: 128, output: 'fatal', timedOut: false };
  const g = gitExec({ mergeBase: fail, diff: '' });
  diffCoverage(repo(istanbul()), cfgOf(), g.exec, { ...opts, baseHead: 'HEAD0' });
  expect(g.calls[1].args.at(-1)).toBe('HEAD0');
  expect(diffCoverage(repo(null), cfgOf(), gitExec({ mergeBase: fail }).exec, opts).problem).toBe('no-base');
});

test('a failing git diff reports diff-failed', () => {
  const exec: Exec = (_c, a) => (a[0] === 'diff' ? { status: 1, output: '', timedOut: false } : { status: 0, output: 'B\n', timedOut: false });
  expect(diffCoverage(repo(null), cfgOf(), exec, opts).problem).toBe('diff-failed');
});

test('formatLines collapses consecutive runs into ranges', () => {
  expect(formatLines([1, 2, 3, 5, 7, 8])).toBe('1-3,5,7-8');
});

// --- gate integration -------------------------------------------------------
function gateCtx(root: string, tdd = true) {
  const config = cfgOf();
  config.checks.tdd = tdd;
  config.stop.steps = [];
  const saved: unknown[] = [];
  return { root, config, input: { session_id: 's' }, state: { startedAt: 0, files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0, baseHead: undefined }, unattended: false, env: {}, save: (s: unknown) => saved.push(s) } as unknown as Ctx;
}
const stopWith = (root: string, g: ReturnType<typeof gitExec>, ctx = gateCtx(root)) =>
  runStop(ctx, (c, a, ms) => (c === 'git' && a[0] === 'status' ? { status: 0, output: ' M src/a.ts\n', timedOut: false } : g.exec(c, a, ms)), () => FRESH * 1000);

test('gate blocks below threshold with the brief message, capped at 10 files and 20 line numbers', () => {
  const cov = istanbul();
  const a = cov['/ROOT/src/a.ts'];
  for (let i = 10; i < 50; i++) a.statementMap[String(i)] = { start: { line: i, column: 0 }, end: { line: i, column: 1 } };
  const many = Array.from({ length: 40 }, (_, i) => 2 * i + 10); // non-consecutive lines
  const root = repo(cov);
  const files = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts`);
  const d = gateDecision(root, addDiff('src/a.ts', many.filter((l) => l < 50)) + files.map((f) => addDiff(f, [1])).join(''));
  expect(d).toMatchObject({ kind: 'block', check: 'stop' });
  const reason = (d as { reason: string }).reason;
  expect(reason).toMatch(/^Diff coverage \d+% is below 80%\. Uncovered: src\/a\.ts:/);
  expect(reason.split(', src/').length + 0).toBeLessThanOrEqual(10 + 1);
  expect(reason).toMatch(/\+\d+ more files/);
  expect(reason.match(/src\/a\.ts:([\d,-]+)/)![1].replace(/,$/, '').split(',').length).toBeLessThanOrEqual(20);
});
function gateDecision(root: string, diff: string) {
  return stopWith(root, gitExec({ diff }));
}

test('gate allows at or above the threshold and when tdd is off', () => {
  const root = repo(istanbul());
  expect(gateDecision(root, addDiff('src/a.ts', [3, 6]))).toEqual({ kind: 'allow' });
  const g = gitExec({ diff: addDiff('src/a.ts', [5]) });
  expect(stopWith(root, g, gateCtx(root, false))).toEqual({ kind: 'allow' });
});

test('gate blocks with the fresh-coverage message when nothing fresh exists', () => {
  const d = gateDecision(repo(null), addDiff('src/a.ts', [3]));
  expect(d).toMatchObject({ kind: 'block' });
  expect((d as { reason: string }).reason).toBe('Diff coverage needs fresh coverage output (**/coverage/coverage-final.json). Make the test step write coverage, then finish again.');
});

test('gate allows and logs coverage-skipped when there is no base', () => {
  const root = repo(null);
  const g = gitExec({ mergeBase: { status: 128, output: 'fatal' } });
  expect(stopWith(root, g)).toEqual({ kind: 'allow' });
  const log = readFileSync(join(root, '.harness/logs/events.jsonl'), 'utf8');
  expect(JSON.parse(log.trim().split('\n').at(-1)!)).toMatchObject({ check: 'stop', decision: 'coverage-skipped', reason: 'no base' });
});

test('config: stop.timeout_s above 580 is capped with a warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-cap-'));
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/config.yaml'), 'stop:\n  timeout_s: 900\n');
  const { config, warnings } = loadConfig(root);
  expect(config.stop.timeout_s).toBe(580);
  expect(warnings).toContain('stop.timeout_s capped at 580 to fit the 600 s Stop hook timeout');
});
