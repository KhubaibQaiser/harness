import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { plainArgv } from '../../src/done/commands.js';
import {
  ACTIVE_TASK, activeTaskId, type Contract, contractHash, type Criterion, featuresCriteria, loadContract, readTaskHashes, setActiveTask, TASK_HASHES, validateContract, writeContract,
} from '../../src/done/contract.js';
import { commit, git, repoWith } from '../review/repo.js';

const crit = (id: string): Criterion => ({ id, text: 'it works', check: { test: 'test/a.test.ts::a works' } });
const sample = (patch: Record<string, unknown> = {}): Contract => ({
  id: 'add-login', title: 'Add login', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
  criteria: [crit('C1'), { id: 'C2', text: 'exits clean', check: { run: 'pnpm run build', expect_exit: 0 } }, { id: 'C3', text: 'looks right', check: { person: 'open the login page' } }],
  checks: ['test'], review: { model: 'sonnet' }, sha256: null, ...patch,
} as Contract);
const reorderKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(reorderKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorderKeys(x)])) : v;
const errorsOf = (r: ReturnType<typeof validateContract>): string[] => (r.ok ? [] : r.errors);
const dir = () => mkdtempSync(join(tmpdir(), 'h-done-'));
const c = sample();

test('a valid approved contract passes; its hash ignores key order and the sha256 field', () => {
  const r = validateContract(sample({ approved_by: 'person', approved_at: '2026-11-14T00:00:00Z' }), { approved: true });
  expect(errorsOf(r)).toEqual([]);
  expect(r.ok).toBe(true);
  expect(contractHash({ ...c, sha256: 'x' })).toBe(contractHash(reorderKeys(c) as Contract));
  expect(contractHash(c)).toMatch(/^[0-9a-f]{64}$/);
  expect(contractHash(sample({ title: 'Other' }))).not.toBe(contractHash(c));
});

test('a draft needs approved_by, approved_at and closed_at null; an approved contract needs them set', () => {
  expect(errorsOf(validateContract(sample({ approved_by: null, approved_at: null }), { approved: false }))).toEqual([]);
  expect(errorsOf(validateContract(sample(), { approved: false }))).toEqual(['approved_by: must be null in a draft', 'approved_at: must be null in a draft']);
  expect(errorsOf(validateContract(sample({ approved_at: 'yesterday' }), { approved: true }))).toEqual(['approved_at: must be an ISO date-time such as 2026-11-14T00:00:00Z']);
});

test.each([
  [{ id: 'Bad_ID' }, 'id: must match'],
  [{ id: '../x' }, 'id: must match'],
  [{ criteria: [] }, 'criteria: at least one'],
  [{ criteria: [crit('C1'), crit('C1')] }, 'duplicate criterion id "C1"'],
  [{ criteria: [{ id: 'C1', text: 't', check: { run: 'pnpm test || true', expect_exit: 0 } }] }, 'run: must be one plain command'],
  [{ criteria: [{ id: 'C1', text: 't', check: { run: 'pnpm test', expect_exit: 256 } }] }, 'expect_exit: must be an integer from 0 to 255'],
  [{ criteria: [{ id: 'C1', text: 't', check: { test: 'a.test.ts' } }] }, 'test: must be <file>::<test name>'],
  [{ criteria: [{ id: 'C1', text: 't', check: { test: '../a.test.ts::x' } }] }, 'test: must be <file>::<test name>'],
  [{ criteria: [{ id: 'C1', text: 't', check: { test: 'a.test.ts::x', person: 'y' } }] }, 'check: must have exactly one of test, run or person'],
  [{ criteria: [{ id: 'C1', text: 'two\nlines', check: { person: 'y' } }] }, 'criteria[0].text: must not contain control characters'],
  [{ criteria: [{ id: '1x', text: 't', check: { person: 'y' } }] }, 'criteria[0].id: must match'],
  [{ approved_by: null }, 'approved_by: must be "person"'],
  [{ base: 'main' }, 'base: must be a commit sha'],
  [{ review: { model: '-x' } }, 'review.model: must be a model id'],
  [{ checks: ['test', 'test'] }, 'checks[1]: duplicate "test"'],
  [{ sha256: 'nope' }, 'sha256: must be null or a sha256 hex string'],
  [{ extra: 1 }, 'extra: unknown key'],
])('rejects %j', (patch, msg) => expect(errorsOf(validateContract(sample(patch), { approved: true }))).toContainEqual(expect.stringContaining(msg)));

test('writeContract records the hash; loadContract refuses a file whose bytes no longer match the recorded hash', () => {
  const root = dir();
  const written = writeContract(root, c);
  expect(written.sha256).toBe(contractHash(c));
  expect(readTaskHashes(root)).toEqual({ 'add-login': written.sha256 });
  expect(loadContract(root, 'add-login')).toEqual({ contract: written });
  const file = join(root, '.harness/tasks/add-login.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('it works', 'it compiles'));
  expect(loadContract(root, 'add-login')).toEqual({ error: expect.stringContaining('.harness/tasks/add-login.json changed since it was approved') });
  // the same bytes with a matching embedded sha256 still fail against task-hashes.json
  const forged = { ...written, criteria: [crit('C1')] };
  writeFileSync(file, JSON.stringify({ ...forged, sha256: contractHash(forged) }));
  expect(loadContract(root, 'add-login')).toEqual({ error: expect.stringContaining('changed since it was approved') });
});

test('a contract on the remote default branch loads in any clone; one only on HEAD or a local branch does not', () => {
  const good = { ...c, sha256: contractHash(c) };
  const text = JSON.stringify(good, null, 2) + '\n';
  const { root: origin } = repoWith({ '.harness/tasks/add-login.json': text }, {});
  const dirOf = mkdtempSync(join(tmpdir(), 'h-done-clone-'));
  git(dirOf, 'clone', '-q', origin, 'c');
  const root = join(dirOf, 'c');
  for (const [k, v] of [['user.name', 'test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) git(root, 'config', k!, v!);
  // (b) a fresh clone: no task-hashes.json, the file as on origin's default branch
  expect(loadContract(root, 'add-login')).toEqual({ contract: good });
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  writeFileSync(join(root, TASK_HASHES), JSON.stringify({ 'add-login': 'f'.repeat(64) }));
  expect(loadContract(root, 'add-login')).toEqual({ contract: good }); // stale local state, file as on the default branch
  // (a) the agent's forge: a self-consistent contract committed on a local branch and checked out
  const forged = { ...c, criteria: [crit('C1')] };
  git(root, 'checkout', '-q', '-b', 'agent');
  const r = (commit(root, { '.harness/tasks/add-login.json': JSON.stringify({ ...forged, sha256: contractHash(forged) }, null, 2) + '\n' }), loadContract(root, 'add-login'));
  expect(r).toEqual({ error: expect.stringContaining('changed since it was approved') });
  expect(r).toEqual({ error: expect.stringContaining('git checkout origin/HEAD -- .harness/tasks/add-login.json') });
  expect(r).toEqual({ error: expect.stringContaining('harness task approve --replace <file>') });
  // the git calls use SAFE_GIT and read origin/HEAD, never HEAD
  const calls: string[][] = [];
  loadContract(root, 'add-login', { git: (cmd, args) => (calls.push([cmd, ...args]), args.includes('symbolic-ref') ? { status: 0, stdout: 'refs/remotes/origin/main\n' } : { status: 128, stdout: '' }) });
  for (const call of calls) expect(call).toContain('core.hooksPath=/dev/null/harness-no-hooks');
  expect(calls.map((x) => x.slice(-3))).toEqual([['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], ['--verify', '--quiet', 'refs/remotes/origin/main:.harness/tasks/add-login.json']]);
});

test('a Windows autocrlf clone (CRLF in the working tree) still matches the default branch', () => {
  const good = { ...c, sha256: contractHash(c) };
  const { root: origin } = repoWith({ '.harness/tasks/add-login.json': JSON.stringify(good, null, 2) + '\n' }, {});
  const d = mkdtempSync(join(tmpdir(), 'h-done-crlf-'));
  git(d, 'clone', '-q', '-c', 'core.autocrlf=true', origin, 'c');
  const root = join(d, 'c');
  expect(readFileSync(join(root, '.harness/tasks/add-login.json'), 'utf8')).toContain('\r\n');
  expect(loadContract(root, 'add-login')).toEqual({ contract: good });
});

test('with origin/HEAD unset, the refusal tells the person to run git remote set-head origin --auto', () => {
  const good = { ...c, sha256: contractHash(c) };
  const { root: origin } = repoWith({ '.harness/tasks/add-login.json': JSON.stringify(good, null, 2) + '\n' }, {});
  const d = mkdtempSync(join(tmpdir(), 'h-done-nohead-'));
  git(d, 'clone', '-q', origin, 'c');
  const root = join(d, 'c');
  git(root, 'remote', 'set-head', 'origin', '-d');
  expect(loadContract(root, 'add-login')).toEqual({ error: expect.stringContaining('git remote set-head origin --auto') });
  git(root, 'remote', 'set-head', 'origin', 'main');
  expect(loadContract(root, 'add-login')).toEqual({ contract: good });
});

test('(c) with no remote, a committed contract loads only when task-hashes.json records it', () => {
  const good = { ...c, sha256: contractHash(c) };
  const { root } = repoWith({ '.harness/tasks/add-login.json': JSON.stringify(good, null, 2) + '\n' }, {});
  expect(loadContract(root, 'add-login')).toEqual({ error: expect.stringContaining('changed since it was approved') });
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  writeFileSync(join(root, TASK_HASHES), JSON.stringify({ 'add-login': good.sha256 }));
  expect(loadContract(root, 'add-login')).toEqual({ contract: good });
});

test('loadContract names the file for a missing, unparsable, invalid or misnamed contract, and refuses a bad id', () => {
  const root = dir();
  expect(loadContract(root, 'nope')).toEqual({ error: '.harness/tasks/nope.json: no such task contract' });
  expect(loadContract(root, '../x')).toEqual({ error: expect.stringContaining('is not a task id') });
  mkdirSync(join(root, '.harness/tasks'), { recursive: true });
  writeFileSync(join(root, '.harness/tasks/bad.json'), '{');
  expect(loadContract(root, 'bad')).toEqual({ error: expect.stringMatching(/^\.harness\/tasks\/bad\.json: not valid JSON/) });
  writeFileSync(join(root, '.harness/tasks/bad.json'), JSON.stringify(sample({ id: 'bad', criteria: [] })));
  expect(loadContract(root, 'bad')).toEqual({ error: '.harness/tasks/bad.json: criteria: at least one criterion is required' });
  writeContract(root, c);
  writeFileSync(join(root, '.harness/tasks/other.json'), readFileSync(join(root, '.harness/tasks/add-login.json')));
  expect(loadContract(root, 'other')).toEqual({ error: '.harness/tasks/other.json: id "add-login" does not match the file name' });
  writeFileSync(join(root, TASK_HASHES), '[]');
  expect(loadContract(root, 'add-login')).toEqual({ error: expect.stringContaining('.harness/state/task-hashes.json is not a mapping') });
  expect(() => readTaskHashes(root)).toThrow('is not a mapping');
});

test('loadContract with ref reads git show <ref>:.harness/tasks/<id>.json and checks the embedded sha256', () => {
  const good = { ...c, sha256: contractHash(c) };
  const { root } = repoWith({ '.harness/tasks/add-login.json': JSON.stringify(good, null, 2) }, { 'README.md': 'x' });
  expect(loadContract(root, 'add-login', { ref: 'main' })).toEqual({ contract: good }); // no task-hashes.json: CI has none
  expect(loadContract(root, 'gone', { ref: 'main' })).toEqual({ error: expect.stringMatching(/^main:\.harness\/tasks\/gone\.json: not found/) });
  expect(loadContract(root, 'add-login', { ref: '--output=x' })).toEqual({ error: expect.stringContaining('is not a git ref') });
  commit(root, { '.harness/tasks/add-login.json': JSON.stringify({ ...good, title: 'Edited' }) });
  expect(loadContract(root, 'add-login', { ref: 'HEAD' })).toEqual({ error: expect.stringContaining('HEAD:.harness/tasks/add-login.json changed since it was approved') });
  const calls: string[][] = [];
  loadContract(root, 'add-login', { ref: 'main', git: (cmd, args) => (calls.push([cmd, ...args]), { status: 128, stdout: '', stderr: 'fatal: bad\nmore' }) });
  expect(calls[0]?.slice(0, 1)).toEqual(['git']);
  expect(calls[0]?.slice(-3)).toEqual(['cat-file', 'blob', 'main:.harness/tasks/add-login.json']);
  expect(calls[0]).toContain('core.hooksPath=/dev/null/harness-no-hooks');
});

test('activeTaskId prefers a valid HARNESS_TASK, throws on an invalid one, else reads the state file', () => {
  const root = dir();
  expect(activeTaskId(root, {})).toBeNull();
  setActiveTask(root, 'from-file');
  expect(readFileSync(join(root, ACTIVE_TASK), 'utf8')).toBe('from-file\n');
  expect(activeTaskId(root, {})).toBe('from-file');
  expect(activeTaskId(root, { HARNESS_TASK: 'from-env' })).toBe('from-env');
  // a bad launch value is an error the caller turns into deny or not-done, never a silent fall back to the state file
  expect(() => activeTaskId(root, { HARNESS_TASK: '../evil' })).toThrow('HARNESS_TASK "../evil" is not a task id');
  expect(() => activeTaskId(root, { HARNESS_TASK: '' })).toThrow('HARNESS_TASK "" is not a task id');
  writeFileSync(join(root, ACTIVE_TASK), 'Not An Id\n');
  expect(activeTaskId(root, {})).toBeNull();
  setActiveTask(root, null);
  expect(activeTaskId(root, {})).toBeNull();
  setActiveTask(root, null); // clearing twice is fine
  expect(() => setActiveTask(root, 'Bad Id')).toThrow('is not a task id');
});

test('featuresCriteria turns each not-passing feature criterion into { test } criteria C1..Cn', () => {
  const root = dir();
  expect(featuresCriteria(root)).toEqual([]);
  writeFileSync(join(root, 'features.json'), JSON.stringify({ features: [
    { id: 'f1', passes: true, criteria: [{ text: 'done already', test: 'a.test.ts::old' }] },
    { id: 'f2', passes: false, criteria: [{ text: 'logs in', test: 'test/login.test.ts::logs in' }, { text: 'no test yet' }] },
    { id: 'f3', criteria: [{ text: 'logs out', test: 'test/login.test.ts::logs out' }] },
  ] }));
  expect(featuresCriteria(root)).toEqual([
    { id: 'C1', text: 'logs in', check: { test: 'test/login.test.ts::logs in' } },
    { id: 'C2', text: 'no test yet', check: { test: '' } }, // kept, so validation names it instead of it vanishing
    { id: 'C3', text: 'logs out', check: { test: 'test/login.test.ts::logs out' } },
  ]);
  writeFileSync(join(root, 'features.json'), '{');
  expect(() => featuresCriteria(root)).toThrow('features.json');
});

test('plainArgv', () => {
  expect(plainArgv("pnpm run 'test'")).toEqual(['pnpm', 'run', 'test']);
  expect(plainArgv('  npx vitest run "test/a b.test.ts"  ')).toEqual(['npx', 'vitest', 'run', 'test/a b.test.ts']);
  for (const bad of ['a && b', 'a | b', 'a > f', 'X=1 a', 'a $(b)', 'a `b`', 'a\nb', '', 'a; b', 'a &', 'a < f', "a 'open", 'a *.ts', 'a ~/x', 'a # c', 'a {b,c}']) expect(plainArgv(bad), bad).toBeNull();
});
