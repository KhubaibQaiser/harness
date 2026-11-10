import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { changedLines, coveredLines, diffCoverage, formatLines } from '../../../src/checks/stop/diff-coverage.js';
import { defaultExec, runStop, type Exec } from '../../../src/checks/stop/gate.js';
import { loadConfig, type HarnessConfig } from '../../../src/core/config.js';
import type { Ctx } from '../../../src/hooks/dispatch.js';

const fx = (p: string) => readFileSync(join(__dirname, '../../fixtures', p), 'utf8');
const cfgOf = (over: Partial<HarnessConfig['tdd']> = {}): HarnessConfig => {
  const c = loadConfig(mkdtempSync(join(tmpdir(), 'h-dc-'))).config;
  c.tdd = { ...c.tdd, paths: ['src/**'], exempt: ['src/gen/**'], ...over };
  return c;
};
const FRESH = Date.now() / 1000;
const json = (root: string) => JSON.stringify(root).slice(1, -1); // root inside a JSON string: Windows paths have backslashes
function repo(coverage: Record<string, unknown> | null, { mtime = FRESH + 10, file = 'coverage/coverage-final.json' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'h-dc-'));
  if (coverage) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(coverage).replaceAll('/ROOT', json(root)));
    utimesSync(join(root, file), mtime, mtime);
  }
  return root;
}
const istanbul = () => JSON.parse(fx('coverage/coverage-final.json'));
// Fake git: merge-base, diff, ls-files (untracked) answers; records calls.
function gitExec(o: { diff?: string; untracked?: string; mergeBase?: { status: number; output: string }; diffFail?: string; lsFail?: boolean }) {
  const calls: { args: string[]; ms: number }[] = [];
  const exec: Exec = (_c, args, ms) => {
    calls.push({ args, ms });
    const ok = (output: string) => ({ status: 0, output, timedOut: false });
    const sub = args.find((a) => ['merge-base', 'diff', 'ls-files'].includes(a));
    if (sub === 'merge-base') return { ...(o.mergeBase ?? ok('BASE\n')), timedOut: false };
    if (sub === 'diff') return o.diffFail ? { status: 128, output: o.diffFail, timedOut: false } : ok(o.diff ?? '');
    if (sub === 'ls-files') return o.lsFail ? { status: null, output: '', timedOut: true } : ok(o.untracked ?? '');
    return ok('');
  };
  return { exec, calls };
}
const addDiff = (file: string, lines: number[]) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` + lines.map((l) => `@@ -${l} +${l} @@\n-x\n+y`).join('\n') + '\n';
const opts = { baseHead: undefined as string | undefined, since: FRESH };

test('changedLines parses the real sample diff: added and modified lines, deletions ignored', async () => {
  const m = changedLines(fx('diff/sample.diff'));
  expect([...m.keys()]).toEqual(['src/a.ts']);
  expect([...m.get('src/a.ts')!]).toEqual([3, 5, 6]);
});

test('changedLines reads CRLF diff output the same as LF', async () => {
  const m = changedLines(fx('diff/sample.diff').replace(/\r?\n/g, '\r\n'));
  expect([...m.keys()]).toEqual(['src/a.ts']);
  expect([...m.get('src/a.ts')!]).toEqual([3, 5, 6]);
});

test('changedLines: pure deletion hunks (+n,0) add nothing; new files and ranges work', async () => {
  const d = 'diff --git a/n.ts b/n.ts\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n@@ -9,2 +11,0 @@\n-x\n-y\n';
  expect([...changedLines(d).get('n.ts')!]).toEqual([1, 2, 3]);
});

test('coveredLines maps absolute keys to repo paths, executable = statement ranges, covered = hit statements', async () => {
  const root = repo(null);
  const raw = JSON.parse(fx('coverage/coverage-final.json').replaceAll('/ROOT', json(root)));
  raw['/elsewhere/x.ts'] = raw[`${root}/src/a.ts`];
  const m = coveredLines(raw, root);
  expect([...m.keys()]).toEqual(['src/a.ts']);
  const f = m.get('src/a.ts')!;
  expect([...f.executable].sort()).toEqual([2, 3, 4, 5, 6]);
  expect([...f.covered].sort()).toEqual([2, 3, 4, 6]);
});

test('diffCoverage: 2 of 4 executable changed lines covered is 50%', async () => {
  const cov = istanbul();
  cov['/ROOT/src/a.ts'].statementMap['4'] = { start: { line: 7, column: 0 }, end: { line: 7, column: 5 } };
  cov['/ROOT/src/a.ts'].s['4'] = 0;
  const root = repo(cov);
  const { exec } = gitExec({ diff: addDiff('src/a.ts', [3, 5, 6, 7]) });
  const r = await diffCoverage(root, cfgOf(), exec, opts);
  expect(r).toMatchObject({ pct: 50, total: 4, covered: 2, uncovered: [{ file: 'src/a.ts', lines: [5, 7] }] });
});

test('non-executable changed lines, test files, exempt and out-of-scope files are ignored', async () => {
  const root = repo(istanbul());
  const diff = addDiff('src/a.ts', [1, 3]) + addDiff('src/a.test.ts', [1]) + addDiff('src/gen/g.ts', [1]) + addDiff('lib/o.ts', [1]);
  const r = await diffCoverage(root, cfgOf(), gitExec({ diff }).exec, opts);
  expect(r).toMatchObject({ pct: 100, total: 1, covered: 1, uncovered: [] });
});

test('files under tdd.coverage_skip are not measured and need no coverage file', async () => {
  const diff = addDiff('src/a.ts', [1, 3]);
  const r = await diffCoverage(repo(null), cfgOf({ coverage_skip: ['src/**'] }), gitExec({ diff }).exec, opts);
  expect(r).toMatchObject({ pct: 100, total: 0, uncovered: [] });
  expect(r.problem).toBeUndefined();
});

test('no changes means 100 and needs no coverage file', async () => {
  const r = await diffCoverage(repo(null), cfgOf(), gitExec({}).exec, opts);
  expect(r).toMatchObject({ pct: 100, total: 0, covered: 0, uncovered: [] });
  expect(r.problem).toBeUndefined();
});

test('changes in scope but only non-executable lines gives 100', async () => {
  const r = await diffCoverage(repo(istanbul()), cfgOf(), gitExec({ diff: addDiff('src/a.ts', [1]) }).exec, opts);
  expect(r.pct).toBe(100);
});

test('untracked files count with all lines added; missing from every report means all uncovered', async () => {
  const root = repo(istanbul());
  writeFileSync(join(root, 'n.txt'), '');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/new.ts'), 'a\nb\nc\n');
  const r = await diffCoverage(root, cfgOf(), gitExec({ untracked: 'src/new.ts\0n.txt\0\n' }).exec, opts);
  expect(r).toMatchObject({ pct: 0, total: 3, covered: 0, uncovered: [{ file: 'src/new.ts', lines: [1, 2, 3] }] });
});

test('a tracked changed file missing from every report counts all changed lines uncovered', async () => {
  const r = await diffCoverage(repo(istanbul()), cfgOf(), gitExec({ diff: addDiff('src/other.ts', [4, 5]) }).exec, opts);
  expect(r).toMatchObject({ pct: 0, total: 2, uncovered: [{ file: 'src/other.ts', lines: [4, 5] }] });
});

test('merges every report matching coverage_globs; a line covered in any report counts', async () => {
  const second = istanbul();
  second['/ROOT/src/a.ts'].s = { 0: 0, 1: 0, 2: 1, 3: 0 };
  const root = repo(istanbul());
  mkdirSync(join(root, 'pkg/coverage'), { recursive: true });
  writeFileSync(join(root, 'pkg/coverage/coverage-final.json'), JSON.stringify(second).replaceAll('/ROOT', json(root)));
  utimesSync(join(root, 'pkg/coverage/coverage-final.json'), FRESH + 10, FRESH + 10);
  mkdirSync(join(root, 'node_modules/x/coverage'), { recursive: true });
  writeFileSync(join(root, 'node_modules/x/coverage/coverage-final.json'), '{"bad json');
  const r = await diffCoverage(root, cfgOf(), gitExec({ diff: addDiff('src/a.ts', [3, 5, 6]) }).exec, opts);
  expect(r).toMatchObject({ pct: 100, total: 3, covered: 3 });
});

test('stale coverage (mtime before the steps started) is ignored: no fresh file blocks via problem', async () => {
  const root = repo(istanbul(), { mtime: FRESH - 100 });
  const r = await diffCoverage(root, cfgOf(), gitExec({ diff: addDiff('src/a.ts', [3]) }).exec, opts);
  expect(r.problem).toBe('no-fresh-coverage');
  expect((await diffCoverage(repo(null), cfgOf(), gitExec({ diff: addDiff('src/a.ts', [3]) }).exec, opts)).problem).toBe('no-fresh-coverage');
});

test('base: merge-base against base_ref, every git call uses the 5000 ms timeout', async () => {
  const g = gitExec({ diff: addDiff('src/a.ts', [3]) });
  await diffCoverage(repo(istanbul()), cfgOf(), g.exec, opts);
  expect(g.calls[0].args).toEqual(['merge-base', 'HEAD', 'origin/main']);
  expect(g.calls[1].args).toEqual(['-c', 'core.quotePath=false', 'diff', '--relative', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', 'BASE']);
  expect(g.calls.some((c) => c.args.includes('ls-files') && c.args.includes('-z') && c.args.includes('--exclude-standard'))).toBe(true);
  expect(g.calls.every((c) => c.ms === 5000)).toBe(true);
});

test('base: falls back to state.baseHead when merge-base fails; neither means no-base', async () => {
  const fail = { status: 128, output: 'fatal', timedOut: false };
  const g = gitExec({ mergeBase: fail, diff: '' });
  await diffCoverage(repo(istanbul()), cfgOf(), g.exec, { ...opts, baseHead: 'HEAD0' });
  expect(g.calls[1].args.at(-1)).toBe('HEAD0');
  expect((await diffCoverage(repo(null), cfgOf(), gitExec({ mergeBase: fail }).exec, opts)).problem).toBe('no-base');
});

test('a failing git diff reports diff-failed', async () => {
  const g = gitExec({ diffFail: 'fatal: bad revision\nmore' });
  expect(await diffCoverage(repo(null), cfgOf(), g.exec, opts)).toMatchObject({ problem: 'diff-failed', detail: 'fatal: bad revision' });
});

test('formatLines collapses consecutive runs into ranges', async () => {
  expect(formatLines([1, 2, 3, 5, 7, 8])).toBe('1-3,5,7-8');
});

// --- gate integration -------------------------------------------------------
function gateCtx(root: string, tdd = true) {
  const config = cfgOf();
  config.checks.tdd = tdd;
  config.stop.steps = [{ name: 't', run: ['true'] }]; // one passing step so the coverage gate is reached
  const saved: unknown[] = [];
  return { root, config, input: { session_id: 's' }, state: { startedAt: 0, files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0, baseHead: undefined }, unattended: false, env: {}, save: (s: unknown) => saved.push(s) } as unknown as Ctx;
}
const stopWith = (root: string, g: ReturnType<typeof gitExec>, ctx = gateCtx(root)) =>
  runStop(ctx, (c, a, ms) => (c === 'true' ? { status: 0, output: '', timedOut: false } : c === 'git' && a[0] === 'status' ? { status: 0, output: ' M src/a.ts\0', timedOut: false } : g.exec(c, a, ms)), () => FRESH * 1000, () => '/bin/true');

test('gate blocks below threshold with the brief message, capped at 10 files and 20 line numbers', async () => {
  const cov = istanbul();
  const a = cov['/ROOT/src/a.ts'];
  for (let i = 10; i < 50; i++) a.statementMap[String(i)] = { start: { line: i, column: 0 }, end: { line: i, column: 1 } };
  const many = Array.from({ length: 40 }, (_, i) => 2 * i + 10); // non-consecutive lines
  const root = repo(cov);
  const files = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts`);
  const d = await gateDecision(root, addDiff('src/a.ts', many.filter((l) => l < 50)) + files.map((f) => addDiff(f, [1])).join(''));
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

test('gate allows at or above the threshold and when tdd is off', async () => {
  const root = repo(istanbul());
  expect(await gateDecision(root, addDiff('src/a.ts', [3, 6]))).toEqual({ kind: 'allow' });
  const g = gitExec({ diff: addDiff('src/a.ts', [5]) });
  expect(await stopWith(root, g, gateCtx(root, false))).toEqual({ kind: 'allow' });
});

test('gate blocks with the fresh-coverage message when nothing fresh exists', async () => {
  const d = await gateDecision(repo(null), addDiff('src/a.ts', [3]));
  expect(d).toMatchObject({ kind: 'block' });
  expect((d as { reason: string }).reason).toBe('Diff coverage needs fresh coverage output (**/coverage/coverage-final.json). Make the test step write coverage, then finish again.');
});

test('coverage gave up (attempts past max): the allow goes through done(), so the team-decision nudge shows', async () => {
  const root = repo(null);
  const ctx = gateCtx(root);
  ctx.state = { ...ctx.state, stopAttempts: ctx.config.stop.max_attempts, decisionHits: [{ pattern: 'P1', excerpt: 'from now on use zod' }] };
  const d = await stopWith(root, gitExec({ diff: addDiff('src/a.ts', [3]) }), ctx);
  expect(d).toMatchObject({ kind: 'context', check: 'stop' });
  expect((d as { text: string }).text).toContain('(you said "from now on use zod")');
});

test('gate allows and logs coverage-skipped when there is no base', async () => {
  const root = repo(null);
  const g = gitExec({ mergeBase: { status: 128, output: 'fatal' } });
  expect(await stopWith(root, g)).toEqual({ kind: 'allow' });
  const log = readFileSync(join(root, '.harness/logs/events.jsonl'), 'utf8');
  expect(JSON.parse(log.trim().split('\n').at(-1)!)).toMatchObject({ check: 'stop', decision: 'coverage-skipped', reason: 'no base' });
});

test('config: stop.timeout_s above 550 is rejected with a warning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'h-cap-'));
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/config.yaml'), 'stop:\n  timeout_s: 900\n');
  const { config, warnings } = loadConfig(root);
  expect(config.stop.timeout_s).toBe(540);
  expect(warnings.join('\n')).toContain('stop.timeout_s');
});

// --- fix round 1: real git runs in temp repos ---------------------------------
const git = (root: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf8' });
function realRepo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'h-real-'));
  git(root, 'init', '-q');
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}
const covFor = (root: string, file: string, hit: number[], miss: number[]) => {
  const statementMap: Record<string, unknown> = {};
  const s: Record<string, number> = {};
  [...hit, ...miss].forEach((n, i) => {
    statementMap[i] = { start: { line: n, column: 0 }, end: { line: n, column: 1 } };
    s[i] = hit.includes(n) ? 1 : 0;
  });
  mkdirSync(join(root, 'coverage'), { recursive: true });
  const f = join(root, 'coverage/coverage-final.json');
  writeFileSync(f, JSON.stringify({ [join(root, file)]: { statementMap, s } }));
  utimesSync(f, FRESH + 10, FRESH + 10);
};
const realCfg = () => cfgOf({ paths: ['src/**'], exempt: [] });
const realRun = (root: string) => {
  const c = realCfg();
  c.stop.base_ref = 'HEAD';
  return diffCoverage(root, c, defaultExec(root), opts);
};

test.each(['src/sp ace.ts', 'src/café.ts'])('real git: tracked path %s is in scope and its changed lines are counted', async (name) => {
  const root = realRepo({ [name]: 'a\nb\nc\n' });
  writeFileSync(join(root, name), 'a\nB\nC\n');
  covFor(root, name, [2], [3]);
  expect(await realRun(root)).toMatchObject({ pct: 50, total: 2, covered: 1, uncovered: [{ file: name, lines: [3] }] });
});

test('real git: untracked non-ASCII path is counted (not silently dropped)', async () => {
  const root = realRepo({ 'src/a.ts': 'x\n' });
  writeFileSync(join(root, 'src/ünï.ts'), 'a\nb\n');
  covFor(root, 'src/ünï.ts', [1], [2]);
  expect(await realRun(root)).toMatchObject({ pct: 50, uncovered: [{ file: 'src/ünï.ts', lines: [2] }] });
});

test('real git: untracked symlinks are not followed', async () => {
  const root = realRepo({ 'src/a.ts': 'x\n' });
  const outside = mkdtempSync(join(tmpdir(), 'h-out-'));
  writeFileSync(join(outside, 'big.ts'), 'a\nb\nc\n');
  symlinkSync(join(outside, 'big.ts'), join(root, 'src/link.ts'));
  expect(await realRun(root)).toMatchObject({ pct: 100, total: 0 });
});

test('real git: an added line starting with "++ " does not drop later hunks', async () => {
  const root = realRepo({ 'src/a.ts': 'one\ntwo\nthree\nfour\nfive\n' });
  writeFileSync(join(root, 'src/a.ts'), 'one\n++ i;\nthree\nfour\nFIVE\n');
  covFor(root, 'src/a.ts', [], [2, 5]);
  expect(await realRun(root)).toMatchObject({ total: 2, uncovered: [{ file: 'src/a.ts', lines: [2, 5] }] });
});

test('gate: git diff failure blocks with the short reason and logs coverage-diff-failed', async () => {
  const root = repo(null);
  const d = await stopWith(root, gitExec({ diffFail: 'fatal: bad revision' }));
  expect(d).toEqual({ kind: 'block', check: 'stop', reason: 'Diff coverage could not read git diff (fatal: bad revision). Fix git, then finish again.' });
  const log = readFileSync(join(root, '.harness/logs/events.jsonl'), 'utf8');
  expect(JSON.parse(log.trim().split('\n').at(-1)!)).toMatchObject({ decision: 'coverage-diff-failed' });
});

test('gate: a failed untracked listing blocks and logs coverage-diff-failed', async () => {
  const root = repo(null);
  const d = await stopWith(root, gitExec({ diff: addDiff('src/a.ts', [3]), lsFail: true }));
  expect(d).toEqual({ kind: 'block', check: 'stop', reason: 'Diff coverage could not read git diff (untracked files: timed out). Fix git, then finish again.' });
  const log = readFileSync(join(root, '.harness/logs/events.jsonl'), 'utf8');
  expect(JSON.parse(log.trim().split('\n').at(-1)!)).toMatchObject({ decision: 'coverage-diff-failed', reason: 'untracked files: timed out' });
});

test('gate: coverage blocks count attempts and give up at max_attempts', async () => {
  const root = repo(null);
  const diff = addDiff('src/a.ts', [3]);
  const run = async (attempts: number) => {
    const ctx = gateCtx(root);
    ctx.state.stopAttempts = attempts;
    const saved: number[] = [];
    ctx.save = (s) => saved.push(s.stopAttempts);
    return { d: await stopWith(root, gitExec({ diff }), ctx), saved };
  };
  expect(await run(0)).toMatchObject({ d: { kind: 'block' }, saved: [1] });
  expect(await run(2)).toMatchObject({ d: { kind: 'block' }, saved: [3] });
  expect(await run(3)).toEqual({ d: { kind: 'allow' }, saved: [0] });
  expect(readFileSync(join(root, '.harness/logs/events.jsonl'), 'utf8')).toContain('stop-gave-up');
});

test('gate: all matched coverage files unparseable says so', async () => {
  const root = repo(null);
  mkdirSync(join(root, 'coverage'));
  writeFileSync(join(root, 'coverage/coverage-final.json'), '{"bad');
  utimesSync(join(root, 'coverage/coverage-final.json'), FRESH + 10, FRESH + 10);
  const d = await stopWith(root, gitExec({ diff: addDiff('src/a.ts', [3]) }));
  expect(d).toMatchObject({ kind: 'block', reason: 'Coverage output at **/coverage/coverage-final.json could not be parsed.' });
});
