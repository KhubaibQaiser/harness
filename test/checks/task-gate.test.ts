// Task 4: with the done contract on, an edit needs an approved, unchanged, open contract; drafting in a workdir does not.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { CONTRACT_LOCKED, NO_CONTRACT, NO_CONTRACT_UNATTENDED, taskGate } from '../../src/checks/task-gate.js';
import { loadConfig } from '../../src/core/config.js';
import { ACTIVE_TASK, type Contract, contractHash, setActiveTask, writeContract } from '../../src/done/contract.js';
import type { Ctx } from '../../src/hooks/check.js';
import type { Decision } from '../../src/hooks/types.js';
import { registry } from '../../src/hooks/dispatch.js';
import { commit, git, repoWith } from '../review/repo.js';

const contract = (patch: Partial<Contract> = {}): Contract => ({
  id: 'add-login', title: 'Add login', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
  criteria: [{ id: 'C1', text: 'it works', check: { test: 'test/a.test.ts::a works' } }], checks: ['test'], review: { model: 'sonnet' }, sha256: null, ...patch,
});
const sealed = (c: Contract) => JSON.stringify({ ...c, sha256: contractHash(c) }, null, 2) + '\n';
const configured = (root: string, done = true) => {
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), `checks:\n  done: ${done}\n`);
  return root;
};
const dir = (done = true) => configured(mkdtempSync(join(tmpdir(), 'h-tg-')), done);
const edit = (p: string) => ({ tool_name: 'Edit', tool_input: { file_path: p, old_string: 'a', new_string: 'b' } });
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
type Call = ReturnType<typeof edit> | ReturnType<typeof bash>;
const run = (root: string, call: Call, o: { env?: NodeJS.ProcessEnv; unattended?: boolean; baseHead?: string } = {}): Decision =>
  taskGate.run({
    input: { session_id: 's', cwd: root, hook_event_name: 'PreToolUse', ...call }, root, config: loadConfig(root).config, env: o.env ?? {},
    state: { startedAt: 0, files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0, ...(o.baseHead ? { baseHead: o.baseHead } : {}) },
    unattended: o.unattended ?? false, home: root, platform: process.platform, managed: '/nonexistent', startedAt: Date.now(), save() {},
  } as Ctx) as Decision; // the gate is synchronous
const deny = (reason: string) => ({ kind: 'deny', check: 'task', reason });

/** A clone of an origin whose default branch holds the contract: no local approval, origin/HEAD vouches (a cloud checkout). */
function cloneWithContract(c = contract()) {
  const origin = repoWith({ 'README.md': 'x' }, { [`.harness/tasks/${c.id}.json`]: sealed(c) });
  const d = mkdtempSync(join(tmpdir(), 'h-tg-'));
  git(d, 'clone', '-q', origin.root, 'c');
  return { root: configured(join(d, 'c')), before: origin.base, head: origin.head };
}

test('registered right after protect, fail-closed and pure, PreToolUse only', () => {
  expect(registry.map((c) => c.name).slice(0, 4)).toEqual(['guard', 'pr-size', 'protect', 'task']);
  expect(taskGate).toMatchObject({ name: 'task', events: ['PreToolUse'], failClosed: true, pure: true });
});

test('the first edit is denied with no approved contract', () => {
  const root = dir();
  expect(run(root, edit('src/a.ts'))).toEqual(deny(NO_CONTRACT));
  expect(run(root, bash('echo x > src/a.ts'))).toEqual(deny(NO_CONTRACT));
  expect(run(root, bash('rm src/a.ts'))).toEqual(deny(NO_CONTRACT)); // deletes and moves are writes too
  expect(run(root, edit(join(root, 'src/a.ts')))).toEqual(deny(NO_CONTRACT));
});

test('writes into a workdir are allowed without a contract (drafting)', () => {
  const root = dir();
  expect(run(root, edit('.harness/tmp/ab12/draft.json'))).toEqual({ kind: 'allow' });
  expect(run(root, bash("cat > .harness/tmp/ab12/draft.json <<'EOF'\n{}\nEOF"))).toEqual({ kind: 'allow' });
  expect(run(root, bash('harness task draft .harness/tmp/ab12/draft.json'))).toEqual({ kind: 'allow' });
  // one target outside the workdir is enough to need the contract
  expect(run(root, bash('tee .harness/tmp/ab12/d.json src/a.ts < x'))).toEqual(deny(NO_CONTRACT));
});

test('an approved, unchanged, open contract allows edits; a hand-changed or closed one denies', () => {
  const root = dir();
  writeContract(root, contract());
  setActiveTask(root, 'add-login');
  expect(run(root, edit('src/a.ts'))).toEqual({ kind: 'allow' });
  expect(run(root, bash('echo x > src/a.ts'))).toEqual({ kind: 'allow' });
  writeFileSync(join(root, '.harness/tasks/add-login.json'), sealed(contract({ title: 'Changed by hand' })));
  expect(run(root, edit('src/a.ts'))).toEqual(deny(expect.stringMatching(/^Active task add-login: \.harness\/tasks\/add-login\.json changed since it was approved/)));
  writeContract(root, contract({ closed_at: '2026-11-14T01:00:00Z' }));
  expect(run(root, edit('src/a.ts'))).toEqual(deny('Task add-login is closed; draft a new one'));
});

test('an unreadable active task record or HARNESS_TASK is a deny that names why', () => {
  const root = dir();
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  writeFileSync(join(root, ACTIVE_TASK), 'Not An Id\n');
  expect(run(root, edit('src/a.ts'))).toEqual(deny('the active task record is unreadable: .harness/state/active-task holds "Not An Id", not a task id'));
  expect(run(root, edit('src/a.ts'), { env: { HARNESS_TASK: '' } })).toEqual(deny(expect.stringContaining('HARNESS_TASK "" is not a task id')));
  expect(run(root, edit('src/a.ts'), { env: { HARNESS_TASK: '../x' }, unattended: true })).toEqual(deny(expect.stringContaining('HARNESS_TASK "../x" is not a task id')));
});

test('unattended: HARNESS_TASK must name a contract present at the session base commit', () => {
  const { root, before, head } = cloneWithContract();
  const env = { HARNESS_TASK: 'add-login' };
  // F1: a fresh checkout has no task-hashes.json; the contract on origin's default branch vouches for it
  expect(run(root, edit('src/a.ts'), { env, unattended: true, baseHead: head })).toEqual({ kind: 'allow' });
  expect(run(root, edit('src/a.ts'), { env, unattended: true, baseHead: before })).toEqual(deny(NO_CONTRACT_UNATTENDED));
  expect(run(root, edit('src/a.ts'), { env, unattended: true })).toEqual(deny(NO_CONTRACT_UNATTENDED)); // no base commit recorded
  expect(run(root, edit('src/a.ts'), { unattended: true, baseHead: head })).toEqual(deny(NO_CONTRACT_UNATTENDED));
  // a contract the agent committed on its own branch is not on origin's default branch: refused
  const forged = contract({ id: 'forged' });
  const at = commit(root, { '.harness/tasks/forged.json': sealed(forged) });
  expect(run(root, edit('src/a.ts'), { env: { HARNESS_TASK: 'forged' }, unattended: true, baseHead: at })).toEqual(deny(expect.stringMatching(/^Active task forged: .*changed since it was approved/)));
});

test('a Bash or Edit write to .harness/tasks is denied with CONTRACT_LOCKED even with a contract', () => {
  const root = dir();
  writeContract(root, contract());
  setActiveTask(root, 'add-login');
  expect(run(root, bash('echo {} > .harness/tasks/add-login.json'))).toEqual(deny(CONTRACT_LOCKED));
  expect(run(root, edit('.harness/tasks/add-login.json'))).toEqual(deny(CONTRACT_LOCKED));
  expect(run(root, bash('mv x .Harness/Tasks/y.json'))).toEqual(deny(CONTRACT_LOCKED)); // case-insensitive file systems
  expect(run(dir(), bash('cp x .harness/tasks/y.json'))).toEqual(deny(CONTRACT_LOCKED));
});

test('read-only shell commands and writes outside the repo pass with no contract', () => {
  const root = dir();
  for (const c of ['pnpm run test', 'git status', 'cat src/a.ts', 'pnpm test 2>/dev/null', 'pnpm test > /tmp/h-tg.log'])
    expect(run(root, bash(c)).kind, c).toBe('allow');
  expect(run(root, { tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } } as never)).toEqual({ kind: 'allow' });
});

test('checks.done false: never denies', () => {
  const root = dir(false);
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  writeFileSync(join(root, ACTIVE_TASK), 'Not An Id\n'); // not even read
  for (const call of [edit('src/a.ts'), bash('echo x > .harness/tasks/a.json'), bash('echo x > src/a.ts')]) expect(run(root, call)).toEqual({ kind: 'allow' });
});
