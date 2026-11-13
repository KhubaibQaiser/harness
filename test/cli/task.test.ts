import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Prompt } from '../../src/cli/prompt.js';
import { task } from '../../src/cli/task.js';
import { readEvents } from '../../src/core/events.js';
import { detect } from '../../src/install/detect.js';
import { testConfigChange } from '../../src/install/test-config.js';
import { activeTaskId, type Contract, contractHash, readTaskHashes } from '../../src/done/contract.js';
import { commit, git, repoWith } from '../review/repo.js';

const wd = '.harness/tmp/w';
const PKG = JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc', test: 'vitest run' } });
const fake = (answer = true): Prompt => ({ confirm: async () => answer, edit: async (_l, v) => v });

function setup(files: Record<string, string> = {}) {
  const { root } = repoWith({ 'package.json': PKG, 'test/old.test.ts': 'x', ...files }, {});
  const lines: string[] = [];
  const cli = { root, env: {} as NodeJS.ProcessEnv, out: (l: string) => lines.push(l), prompt: fake(), now: () => new Date('2026-11-14T12:00:00Z') };
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const write = (rel: string, v: unknown) => (mkdirSync(join(root, rel, '..'), { recursive: true }), writeFileSync(join(root, rel), JSON.stringify(v)));
  const loaded = (id = 't1') => JSON.parse(read(`.harness/tasks/${id}.json`)) as Contract;
  const text = () => lines.splice(0).join('\n');
  return { root, cli, read, write, loaded, text };
}

/** A filled-in draft at `${wd}/task.json`. */
function drafted(s: ReturnType<typeof setup>, patch: Record<string, unknown> = {}) {
  const head = commit(s.root, {}, 'empty');
  const d = {
    id: 't1', title: 'Add login', base: head, approved_by: null, approved_at: null, closed_at: null,
    criteria: [{ id: 'C1', text: 'old test passes', check: { test: 'test/old.test.ts::works' } }, { id: 'C2', text: 'builds', check: { run: 'pnpm run build', expect_exit: 0 } }],
    checks: ['lint', 'test'], review: { model: 'sonnet' }, sha256: null, ...patch,
  };
  s.write(`${wd}/task.json`, d);
  return `${wd}/task.json`;
}

test('draft writes a skeleton only inside a workdir', async () => {
  const s = setup();
  expect(await task(['draft', 'notes/task.json'], s.cli)).toBe(2);
  expect(existsSync(join(s.root, 'notes/task.json'))).toBe(false);
  expect(await task(['draft', `${wd}/task.json`], s.cli)).toBe(0);
  expect(JSON.parse(s.read(`${wd}/task.json`))).toMatchObject({
    id: '', title: '', base: git(s.root, 'rev-parse', 'HEAD').trim(), approved_by: null, checks: ['lint', 'typecheck', 'test'], review: { model: 'sonnet' }, criteria: [],
  });
  expect(s.text()).toContain('harness task draft');
});

test('draft flags a test criterion whose file is not in HEAD, and one whose runner writes no JSON results', async () => {
  const s = setup();
  const f = drafted(s, { criteria: [{ id: 'C1', text: 'new test', check: { test: 'test/new.test.ts::works' } }] });
  expect(await task(['draft', f], s.cli)).toBe(0);
  const out = s.text();
  expect(out).toContain('C1');
  expect(out).toContain('rests on a test written during the task (prefer a run check or a test the person writes first)');
  expect(out).toContain('no JSON results reporter');
  expect(out).toContain(`task approve ${f} --yes`);
  expect(readEvents(s.root).at(-1)).toMatchObject({ check: 'task', decision: 'task-drafted', reason: 't1' });
});

test('draft does not flag a test criterion when the vitest JSON results reporter is set up', async () => {
  const s = setup({ 'vitest.config.ts': 'export default { test: {} };\n', 'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }) });
  const pkg = detect(s.root).packages[0]!;
  const r = testConfigChange(pkg, s.root, '.harness/results');
  if (!('change' in r) || r.change.kind !== 'update') throw new Error('expected a vitest config change');
  commit(s.root, { 'vitest.config.ts': r.change.after });
  const f = drafted(s, { checks: ['test'] });
  expect(await task(['draft', f], s.cli)).toBe(0);
  const out = s.text();
  expect(out).not.toContain('no JSON results reporter');
  expect(out).not.toContain('rests on a test written during the task');
});

test('draft of an invalid file lists its errors and exits 1; a check that is not a stop step is an error', async () => {
  const s = setup();
  const f = drafted(s, { checks: ['lint', 'deploy'] });
  expect(await task(['draft', f], s.cli)).toBe(1);
  expect(s.text()).toContain('checks[1]: "deploy" is not a configured stop step');
  s.write(f, { id: 'Bad' });
  expect(await task(['draft', f], s.cli)).toBe(1);
  expect(s.text()).toContain('id: must match');
});

test('approve without --yes and without a TTY previews and exits 2; with --yes it writes, hashes and activates', async () => {
  const s = setup();
  const f = drafted(s);
  expect(await task(['approve', f], { ...s.cli, tty: false })).toBe(2);
  const preview = s.text();
  expect(preview).toContain('C1');
  expect(preview).toContain(`task approve ${f} --yes`);
  expect(existsSync(join(s.root, '.harness/tasks/t1.json'))).toBe(false);
  expect(await task(['approve', f, '--yes'], s.cli)).toBe(0);
  const c = s.loaded();
  expect(c).toMatchObject({ approved_by: 'person', approved_at: '2026-11-14T12:00:00.000Z', closed_at: null });
  expect(c.base).toBe(git(s.root, 'rev-parse', 'HEAD').trim());
  expect(readTaskHashes(s.root).t1).toBe(contractHash(c));
  expect(c.sha256).toBe(contractHash(c));
  expect(activeTaskId(s.root, {})).toBe('t1');
  expect(s.text()).toContain('Commit .harness/tasks/t1.json and land it on the base branch before the work PR: CI reads contracts only from there.');
  expect(readEvents(s.root).at(-1)).toMatchObject({ check: 'task', decision: 'task-approved', reason: 't1' });
});

test('approve with a TTY asks; a no writes nothing', async () => {
  const s = setup();
  const f = drafted(s);
  expect(await task(['approve', f], { ...s.cli, prompt: fake(false) })).toBe(1);
  expect(existsSync(join(s.root, '.harness/tasks/t1.json'))).toBe(false);
  expect(await task(['approve', f], s.cli)).toBe(0);
  expect(existsSync(join(s.root, '.harness/tasks/t1.json'))).toBe(true);
});

test('approve refuses when CI=true', async () => {
  const s = setup();
  const f = drafted(s);
  expect(await task(['approve', f, '--yes'], { ...s.cli, env: { CI: 'true' } })).toBe(1);
  expect(existsSync(join(s.root, '.harness/tasks/t1.json'))).toBe(false);
  expect(readEvents(s.root).at(-1)).toMatchObject({ check: 'task', decision: 'task-approve-refused' });
});

test('approve refuses an id that already exists, an invalid draft, a file outside a workdir, and a check that is not a stop step', async () => {
  const s = setup();
  const f = drafted(s);
  expect(await task(['approve', f, '--yes'], s.cli)).toBe(0);
  s.text();
  expect(await task(['approve', f, '--yes'], s.cli)).toBe(1);
  expect(s.text()).toContain('use harness task edit');
  const g = drafted(s, { id: 't2', checks: ['deploy'] });
  expect(await task(['approve', g, '--yes'], s.cli)).toBe(1);
  expect(s.text()).toContain('"deploy" is not a configured stop step');
  drafted(s, { id: 't3', approved_by: 'person' });
  expect(await task(['approve', f, '--yes'], s.cli)).toBe(1);
  expect(existsSync(join(s.root, '.harness/tasks/t3.json'))).toBe(false);
  s.write('notes/t.json', {});
  expect(await task(['approve', 'notes/t.json', '--yes'], s.cli)).toBe(2);
  expect(readEvents(s.root).filter((e) => e.decision === 'task-approve-refused').length).toBe(3);
});

test('edit lists changed criteria and re-hashes; close clears the active task', async () => {
  const s = setup();
  const f = drafted(s);
  expect(await task(['approve', f, '--yes'], s.cli)).toBe(0);
  const before = s.loaded();
  commit(s.root, {}, 'moved on');
  drafted(s, {
    id: 't1', base: before.base,
    criteria: [{ id: 'C1', text: 'old test still passes', check: { test: 'test/old.test.ts::works' } }, { id: 'C3', text: 'looks right', check: { person: 'open the page' } }],
  });
  s.text();
  expect(await task(['edit', 't1', '--from', f], { ...s.cli, tty: false })).toBe(2);
  expect(s.loaded().sha256).toBe(before.sha256);
  const preview = s.text();
  expect(preview).toContain('added C3');
  expect(preview).toContain('removed C2');
  expect(preview).toContain('changed C1');
  expect(await task(['edit', 't1', '--from', f, '--yes'], s.cli)).toBe(0);
  const after = s.loaded();
  expect(after.base).toBe(before.base);
  expect(after.criteria.map((c) => c.id)).toEqual(['C1', 'C3']);
  expect(readTaskHashes(s.root).t1).toBe(contractHash(after));
  expect(after.sha256).not.toBe(before.sha256);
  expect(readEvents(s.root).at(-1)).toMatchObject({ decision: 'task-edited', reason: 't1' });
  drafted(s, { id: 't2' });
  expect(await task(['edit', 't1', '--from', f, '--yes'], s.cli)).toBe(1); // the file's id must be the task's

  expect(await task(['close', 't1'], { ...s.cli, tty: false })).toBe(2);
  expect(activeTaskId(s.root, {})).toBe('t1');
  expect(await task(['close', 't1', '--yes'], s.cli)).toBe(0);
  expect(s.loaded().closed_at).toBe('2026-11-14T12:00:00.000Z');
  expect(readTaskHashes(s.root).t1).toBe(contractHash(s.loaded()));
  expect(activeTaskId(s.root, {})).toBe(null);
  expect(readEvents(s.root).at(-1)).toMatchObject({ decision: 'task-closed', reason: 't1' });
  expect(await task(['close', 't1', '--yes'], s.cli)).toBe(1); // already closed
  expect(await task(['edit', 't1', '--from', f, '--yes'], s.cli)).toBe(1); // closed
});

test('edit and close refuse a contract changed since approval, and unattended runs', async () => {
  const s = setup();
  const f = drafted(s);
  expect(await task(['approve', f, '--yes'], s.cli)).toBe(0);
  expect(await task(['close', 't1', '--yes'], { ...s.cli, env: { HARNESS_UNATTENDED: '1' } })).toBe(1);
  const c = s.loaded();
  s.write('.harness/tasks/t1.json', { ...c, title: 'Sneaky' });
  s.text();
  expect(await task(['close', 't1', '--yes'], s.cli)).toBe(1);
  expect(s.text()).toContain('changed since it was approved');
  expect(await task(['edit', 't1', '--from', f, '--yes'], s.cli)).toBe(1);
});

test('bad arguments print the usage and exit 2', async () => {
  const s = setup();
  for (const a of [[], ['nope'], ['draft'], ['approve', 'a', 'b'], ['edit', 't1'], ['edit', 't1', '--from'], ['close'], ['close', 't1', '--force']]) {
    expect(await task(a, s.cli), a.join(' ')).toBe(2);
    expect(s.text()).toContain('Usage: harness task draft <file>');
  }
});
