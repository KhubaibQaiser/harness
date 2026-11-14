// Task 6: the evidence ledger hook. Only an exact check, criterion or test-runner call records a row; a blocked call records a blocked row.
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { readEvents } from '../../src/core/events.js';
import { checkArgv, harnessArgs, isTestRunner } from '../../src/done/commands.js';
import { type Contract, setActiveTask, writeContract } from '../../src/done/contract.js';
import { readLedger, type RunRow } from '../../src/done/ledger.js';
import { evidenceLedger } from '../../src/done/ledger-hook.js';
import { treeHash } from '../../src/done/tree.js';
import type { Ctx } from '../../src/hooks/check.js';
import { dispatch } from '../../src/hooks/dispatch.js';
import { git, repoWith } from '../review/repo.js';

const contract: Contract = {
  id: 'add-login', title: 'Add login', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
  criteria: [
    { id: 'C1', text: 'it works', check: { test: 'test/a.test.ts::a works' } },
    { id: 'C2', text: 'builds', check: { run: 'node build.mjs', expect_exit: 0 } },
    { id: 'C3', text: 'looks right', check: { person: 'open the login page' } },
  ],
  checks: ['test'], review: { model: 'sonnet' }, sha256: null,
};
const OK = { stdout: '', stderr: '', interrupted: false, isImage: false }; // Bash's own output object

function setup(o: { done?: boolean; active?: boolean } = {}) {
  const { root } = repoWith({ 'README.md': 'x\n', 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }, {});
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), `checks:\n  done: ${o.done ?? true}\n`);
  const c = writeContract(root, contract);
  if (o.active ?? true) setActiveTask(root, c.id);
  return { root, c };
}
type Extra = Record<string, unknown>;
const post = (command: string, o: { input?: Extra; res?: unknown; tool?: string } = {}) => ({
  hook_event_name: 'PostToolUse', session_id: 's', tool_name: o.tool ?? 'Bash', tool_input: { command, ...o.input }, tool_response: 'res' in o ? o.res : OK,
});
const failure = (command: string, error: string) => ({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: { command }, error });
async function rowsAfter(root: string, call: Extra & { hook_event_name: string }, env: NodeJS.ProcessEnv = {}) {
  expect(await dispatch(JSON.stringify({ cwd: root, ...call }), [evidenceLedger], env)).toBe('');
  return readLedger(root) as RunRow[]; // blocked rows are checked by shape
}

test('a matched check records a row with tree, contract hash and passing criteria', async () => {
  const { root, c } = setup();
  const [row] = await rowsAfter(root, post('pnpm run test'));
  expect(row).toEqual({ kind: 'run', ts: expect.any(String), session: 's', command: 'pnpm run test', exit: 0, tree: treeHash(root), contract: c.sha256, criteria: [] });
  const rows = await rowsAfter(root, post('node build.mjs'));
  expect(rows[1]).toMatchObject({ command: 'node build.mjs', exit: 0, criteria: ['C2'] });
  // PowerShell runs the same commands; Monitor and other tools are not runs.
  // PowerShell's response shape is unverified (I2): its row records exit null until a live Windows check.
  expect((await rowsAfter(root, post('node build.mjs', { tool: 'PowerShell' }))).at(-1)).toMatchObject({ exit: null, criteria: [] });
  expect(await rowsAfter(root, post('node build.mjs', { tool: 'Monitor' }))).toHaveLength(3);
});

test('PostToolUseFailure records the exit from "Exit code 2"', async () => {
  const { root } = setup();
  expect((await rowsAfter(root, failure('pnpm run test', 'Exit code 2\nfoo')))[0]!.exit).toBe(2);
  // A failed run criterion is not passing evidence; an error with no exit line is an unknown exit.
  expect((await rowsAfter(root, failure('node build.mjs', 'Exit code 1')))[1]).toMatchObject({ exit: 1, criteria: [] });
  expect((await rowsAfter(root, failure('pnpm run test', 'Command timed out\nExit code 0')))[2]!.exit).toBeNull();
  // A failure event never reads as exit 0 (M2).
  expect((await rowsAfter(root, failure('node build.mjs', 'Exit code 0')))[3]).toMatchObject({ exit: null, criteria: [] });
});

test('F4: a PostToolUse response with no success or failure signal records exit null, never a pass', async () => {
  const { root } = setup();
  for (const res of [undefined, null, 'done', {}, { stdout: '' }, { ...OK, interrupted: true }, { ...OK, is_error: true }, { ...OK, exitCode: '0' }, { ...OK, exit_code: null }]) await rowsAfter(root, post('node build.mjs', { res }));
  const rows = readLedger(root);
  expect(rows.map((r) => (r.kind === 'run' ? [r.exit, r.criteria] : null))).toEqual(Array(9).fill([null, []])); // a non-numeric exit field is unknown too (M1)
  // An explicit exit code is used as it is.
  expect((await rowsAfter(root, post('node build.mjs', { res: { exitCode: 3 } }))).at(-1)).toMatchObject({ exit: 3, criteria: [] });
  expect((await rowsAfter(root, post('node build.mjs', { res: { exit_code: 0 } }))).at(-1)).toMatchObject({ exit: 0, criteria: ['C2'] });
});

test('compound, prefixed, redirected and background runs record nothing', async () => {
  const { root } = setup();
  for (const command of ['pnpm run test || true', 'CI=1 pnpm run test', 'pnpm run test > out.txt', 'pnpm run test &', 'pnpm run test; true', 'pnpm run $T'])
    expect(await rowsAfter(root, post(command))).toEqual([]);
  expect(await rowsAfter(root, post('pnpm run test', { input: { run_in_background: true } }))).toEqual([]);
  // Commands that are no check, criterion or test runner record nothing either.
  for (const command of ['ls', 'pnpm run lint', 'node build.mjs --watch', 'git status']) expect(await rowsAfter(root, post(command))).toEqual([]);
});

test('a vitest run marks a test criterion passing only from results written during the call', async () => {
  const { root } = setup();
  const results = (status: 'passed' | 'failed', name = 'results.json') => {
    mkdirSync(join(root, '.harness/results'), { recursive: true });
    const p = join(root, '.harness/results', name);
    writeFileSync(p, JSON.stringify({ testResults: [{ name: join(root, 'test/a.test.ts'), status, assertionResults: [{ fullName: 'a works', status }] }] }));
    return p;
  };
  const vitest = (input: Extra = {}) => ({ ...post('npx vitest run'), duration_ms: 5000, ...input });
  const old = results('passed');
  utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  expect((await rowsAfter(root, vitest())).at(-1)).toMatchObject({ command: 'npx vitest run', exit: 0, criteria: [] });
  results('passed');
  expect((await rowsAfter(root, vitest())).at(-1)!.criteria).toEqual(['C1']);
  // No duration_ms: no window, so no test criterion.
  const { duration_ms: _, ...noDuration } = vitest();
  expect((await rowsAfter(root, noDuration)).at(-1)!.criteria).toEqual([]);
  results('failed');
  expect((await rowsAfter(root, vitest())).at(-1)!.criteria).toEqual([]);
});

test('harness done --blocked "x" records a blocked row with the current criterion gaps', async () => {
  const { root, c } = setup();
  await rowsAfter(root, post('node build.mjs')); // C2 passes; C1 has no evidence; C3 is the person's
  const rows = await rowsAfter(root, post('harness done --blocked "the API key is missing"'));
  expect(rows[1]).toEqual({ kind: 'blocked', ts: expect.any(String), session: 's', task: c.id, reason: 'the API key is missing', failing_criteria: ['C1'], tree: treeHash(root), contract: c.sha256 });
  expect(readEvents(root).filter((e) => e.decision === 'task-blocked')).toEqual([expect.objectContaining({ check: 'done', reason: 'the API key is missing' })]);
  // A refused call (non-zero exit), a wrapped call, or other args record nothing.
  for (const call of [failure('harness done --blocked "x"', 'Exit code 2'), post('harness done --blocked x || true'), post('harness done --blocked'), post('harness done x y')])
    expect(await rowsAfter(root, call)).toHaveLength(2);
  expect((await rowsAfter(root, post('npx harness done --blocked y'))).at(-1)).toMatchObject({ kind: 'blocked', reason: 'y' });
});

test('the reason in the event log is redacted, escaped and cut to 200 characters', async () => {
  const { root } = setup();
  await rowsAfter(root, post(`harness done --blocked "token ghp_${'a'.repeat(36)} ${'é‮'.repeat(150)}"`));
  const [e] = readEvents(root).filter((x) => x.decision === 'task-blocked');
  expect(e!.reason).not.toContain('ghp_');
  expect(e!.reason).not.toContain('‮');
  expect(e!.reason!.length).toBe(200);
});

test('off, no active task, a bad HARNESS_TASK, a broken contract or a tree that cannot be hashed: no row, no crash', async () => {
  expect(await rowsAfter(setup({ done: false }).root, post('pnpm run test'))).toEqual([]);
  expect(await rowsAfter(setup({ active: false }).root, post('pnpm run test'))).toEqual([]);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const { root } = setup();
    expect(await rowsAfter(root, post('pnpm run test'), { HARNESS_TASK: 'Not A Task' })).toEqual([]);
    expect(err.mock.calls.flat().join('')).toContain('HARNESS_TASK');
    writeFileSync(join(root, '.harness/tasks/add-login.json'), '{}');
    expect(await rowsAfter(root, post('pnpm run test'))).toEqual([]);
    const orphan = setup().root;
    git(orphan, 'checkout', '-q', '--orphan', 'other');
    err.mockClear();
    expect(await rowsAfter(orphan, post('pnpm run test'))).toEqual([]);
    expect(err.mock.calls.flat().join('')).toContain('orphan branch');
  } finally {
    err.mockRestore();
  }
});

test('harnessArgs, isTestRunner and checkArgv read commands exactly', () => {
  expect(harnessArgs('harness done --blocked "a b"')).toEqual(['done', '--blocked', 'a b']);
  expect(harnessArgs('npx harness done')).toEqual(['done']);
  expect(harnessArgs('node_modules/.bin/harness verify')).toEqual(['verify']);
  for (const cmd of ['harness done && ls', 'echo harness done', 'X=1 harness done', 'harnessx done']) expect(harnessArgs(cmd)).toBeNull();
  for (const argv of ['vitest', 'jest --ci', 'npx vitest run', 'pnpm jest', 'bunx vitest', 'pnpm exec vitest run', 'yarn exec jest', 'npm test', 'bun test', 'pnpm run test', 'yarn run test'])
    expect(isTestRunner(argv.split(' ')), argv).toBe(true);
  for (const argv of ['node test', 'npm run lint', 'npx eslint', 'npm exec vitest', 'make test', 'pnpm run'])
    expect(isTestRunner(argv.split(' ')), argv).toBe(false);
  const { root } = setup();
  const { config } = loadConfig(root);
  expect(checkArgv(root, config, 'test')).toEqual(['pnpm', 'run', 'test']);
  expect(checkArgv(root, config, 'lint')).toBeNull(); // no such script
  config.stop.steps = [{ name: 'unit', run: ['make', 'unit'] }];
  expect(checkArgv(root, config, 'unit')).toEqual(['make', 'unit']);
});

test('C1: a run from any folder but the repo root records nothing', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'packages/web'), { recursive: true });
  expect(await rowsAfter(root, { ...post('pnpm run test'), cwd: join(root, 'packages/web') })).toEqual([]);
  // A workdir package.json would run its own "test" script; .harness/tmp is outside the tree hash.
  mkdirSync(join(root, '.harness/tmp/x'), { recursive: true });
  writeFileSync(join(root, '.harness/tmp/x/package.json'), JSON.stringify({ scripts: { test: 'true' } }));
  expect(await rowsAfter(root, { ...post('pnpm run test'), cwd: join(root, '.harness/tmp/x') })).toEqual([]);
  // No cwd at all: no row.
  const { config } = loadConfig(root);
  const input = { ...post('pnpm run test'), cwd: '' } as unknown as Ctx['input'];
  evidenceLedger.run({ input, root, config, env: {}, state: {}, unattended: false, save() {} } as unknown as Ctx);
  expect(readLedger(root)).toEqual([]);
  expect(await rowsAfter(root, post('pnpm run test'))).toHaveLength(1); // the root still records
});

test('I1: a results file dated in the future never counts, and never hides a fresh failure', async () => {
  const { root } = setup();
  const results = (status: 'passed' | 'failed', name: string, mtime?: Date) => {
    mkdirSync(join(root, '.harness/results'), { recursive: true });
    const p = join(root, '.harness/results', name);
    writeFileSync(p, JSON.stringify({ testResults: [{ name: join(root, 'test/a.test.ts'), status, assertionResults: [{ fullName: 'a works', status }] }] }));
    if (mtime) utimesSync(p, mtime, mtime);
  };
  const vitest = { ...post('npx vitest run'), duration_ms: 5000 };
  results('passed', 'future.json', new Date(Date.now() + 3_600_000));
  expect((await rowsAfter(root, vitest)).at(-1)!.criteria).toEqual([]);
  results('failed', 'now.json');
  expect((await rowsAfter(root, vitest)).at(-1)!.criteria).toEqual([]);
});

test('I3: a plain call that matches nothing prints no warning, even when the contract would not load', async () => {
  const { root } = setup();
  writeFileSync(join(root, '.harness/tasks/add-login.json'), '{}');
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    for (const command of ['ls', 'git status', 'cat README.md']) expect(await rowsAfter(root, post(command))).toEqual([]);
    expect(err.mock.calls.flat().join('')).toBe('');
    expect(readEvents(root).filter((e) => e.check === 'done')).toEqual([]);
  } finally {
    err.mockRestore();
  }
});

test('I3: the verified contract gates every row, whatever the unverified parse matched', async () => {
  const { root } = setup();
  // A stop step the contract does not check: matched loosely, then refused by the verified contract.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }));
  expect(await rowsAfter(root, post('pnpm run lint'))).toEqual([]);
  // An edited contract claims `ls` as a run criterion: the parse matches it, the load refuses it, nothing is written.
  const p = join(root, '.harness/tasks/add-login.json');
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  raw.criteria[1].check.run = 'ls';
  writeFileSync(p, JSON.stringify(raw));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(await rowsAfter(root, post('ls'))).toEqual([]);
    expect(err.mock.calls.flat().join('')).toContain('changed since it was approved');
  } finally {
    err.mockRestore();
  }
});

test('M3: a blocked call needs a reason, and the row keeps at most 200 characters of it', async () => {
  const { root } = setup();
  expect(await rowsAfter(root, post('harness done --blocked ""'))).toEqual([]);
  expect(await rowsAfter(root, post('harness done --blocked "   "'))).toEqual([]);
  const [row] = await rowsAfter(root, post(`harness done --blocked "${'r'.repeat(300)}"`));
  expect(row).toMatchObject({ kind: 'blocked', reason: 'r'.repeat(200) });
});

test('M4: a failure after a match is logged as done ledger-failed, redacted and capped', async () => {
  const { root } = setup();
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const token = `ghp_${'a'.repeat(36)}`;
    expect(await rowsAfter(root, post('pnpm run test'), { HARNESS_TASK: `${token}${'x'.repeat(300)}` })).toEqual([]);
    const [e] = readEvents(root).filter((x) => x.decision === 'ledger-failed');
    expect(e).toMatchObject({ check: 'done', reason: expect.stringContaining('HARNESS_TASK') });
    expect(e!.reason).not.toContain('ghp_');
    expect(e!.reason!.length).toBeLessThanOrEqual(200);
  } finally {
    err.mockRestore();
  }
});
