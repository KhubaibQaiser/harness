import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { multiFile } from '../../src/checks/multi-file.js';
import { readEvents } from '../../src/core/events.js';
import { readState } from '../../src/core/state.js';
import { dispatch, registry } from '../../src/hooks/dispatch.js';

const setup = (mode = 'block', extra = '') => {
  const root = mkdtempSync(join(tmpdir(), 'h-mf-'));
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/config.yaml'), `checks:\n  multiFile: true\nunattended:\n  multi_file_gate: ${mode}\n${extra}`);
  const send = (o: Record<string, unknown>, env: NodeJS.ProcessEnv = {}, checks = [multiFile]) =>
    dispatch(JSON.stringify({ session_id: 's', cwd: root, ...o }), checks, env);
  const edit = async (p: string, tool = 'Edit', env: NodeJS.ProcessEnv = {}, extra2: Record<string, unknown> = {}) => {
    const out = await send({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: p }, ...extra2 }, env);
    return out ? (JSON.parse(out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string }) : { permissionDecision: 'allow', permissionDecisionReason: '' };
  };
  const post = (p: string, tool = 'Edit') => send({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: p } });
  const prompt = () => send({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  return { root, send, edit, post, prompt };
};
const kind = (d: { permissionDecision: string }) => d.permissionDecision;

test('registered third, not fail-closed, right events', () => {
  expect(registry.map((c) => c.name).slice(0, 3)).toEqual(['guard', 'protect', 'multiFile']);
  expect(multiFile.failClosed).toBeFalsy();
  expect(multiFile.events).toEqual(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
});

test('first file allowed, second asks with the message', async () => {
  const t = setup();
  expect(kind(await t.edit('a.ts'))).toBe('allow');
  await t.post('a.ts');
  const d = await t.edit('b.ts');
  expect(kind(d)).toBe('ask');
  expect(d.permissionDecisionReason).toBe('This change now spans more than one file. Touched: a.ts. Next: b.ts. Approve to continue this turn.');
});

test('ask lists several touched files joined by ", " and PreToolUse does not record', async () => {
  const t = setup();
  await t.post('a.ts');
  await t.post('src/b.ts');
  await t.prompt();
  await t.post('a.ts');
  await t.post('a.test.ts'); // same unit, second path
  await t.edit('c.ts'); // ask, unrecorded
  expect(readState(t.root, 's').files).toEqual(['a.ts', 'a.test.ts']);
  expect((await t.edit('c.ts')).permissionDecisionReason).toContain('Touched: a.ts, a.test.ts. Next: c.ts.');
});

test('source and its test count as one, either order', async () => {
  const t = setup();
  await t.post('foo.test.ts');
  expect(kind(await t.edit('foo.ts'))).toBe('allow');
  await t.post('foo.ts');
  expect(readState(t.root, 's').approved).toBe(false);
});

test('re-editing a recorded file is never a second unit', async () => {
  const t = setup();
  await t.post('a.ts');
  await t.post('a.ts');
  expect(readState(t.root, 's').files).toEqual(['a.ts']);
  expect(kind(await t.edit('a.ts'))).toBe('allow');
});

test('approval carries for the rest of the turn', async () => {
  const t = setup();
  await t.post('a.ts');
  await t.post('b.ts');
  expect(kind(await t.edit('c.ts'))).toBe('allow');
});

test('new prompt resets the count', async () => {
  const t = setup();
  await t.post('a.ts');
  await t.post('b.ts');
  await t.prompt();
  await t.post('c.ts');
  expect(kind(await t.edit('d.ts'))).toBe('ask');
});

test('lockfiles, snapshots, generated and outside-root files are not counted', async () => {
  const t = setup('block', 'multi_file_gate:\n  generated:\n    - "gen/**"\n');
  await t.post('a.ts');
  for (const p of ['pnpm-lock.yaml', 'sub/package-lock.json', 'yarn.lock', 'bun.lockb', 'test/__snapshots__/x.ts', 'x.snap', 'gen/api.ts', '/tmp/x.ts']) expect(kind(await t.edit(p))).toBe('allow');
  await t.post('pnpm-lock.yaml');
  await t.post('/tmp/x.ts');
  expect(readState(t.root, 's').files).toEqual(['a.ts']);
});

test('paths compare case-sensitively', async () => {
  const t = setup();
  await t.post('A.ts');
  expect(kind(await t.edit('a.ts'))).toBe('ask');
});

test.each(['Write', 'MultiEdit', 'NotebookEdit'])('%s counts', async (tool) => {
  const t = setup();
  await t.post('a.ts', tool);
  expect(kind(await t.edit('b.ts', tool))).toBe('ask');
});

test('non-edit tools and checks.multiFile=false are ignored', async () => {
  const t = setup();
  await t.post('a.ts');
  expect(await t.send({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'b.ts' } })).toBe('');
  writeFileSync(join(t.root, '.harness/config.yaml'), 'checks:\n  multiFile: false\n');
  expect(kind(await t.edit('b.ts'))).toBe('allow');
});

test('subagent edits count toward the same session', async () => {
  const t = setup();
  await t.post('a.ts');
  expect(kind(await t.edit('b.ts', 'Edit', {}, { agent_id: 'sub1' }))).toBe('ask');
});

test('unattended block denies with the brief message, never asks', async () => {
  const t = setup('block');
  await t.post('a.ts');
  const d = await t.edit('b.ts', 'Edit', { CI: 'true' });
  expect(kind(d)).toBe('deny');
  expect(d.permissionDecisionReason).toBe('Unattended multi-file change blocked. Wanted: a.ts, b.ts.');
});

test('unattended off allows', async () => {
  const t = setup('off');
  await t.post('a.ts');
  expect(kind(await t.edit('b.ts', 'Edit', { CI: 'true' }))).toBe('allow');
  expect(readEvents(t.root)).toEqual([]);
});

test('unattended allow-log allows and logs once per new unit, even after approval', async () => {
  const t = setup('allow-log');
  const env = { CI: 'true' };
  await t.post('a.ts');
  expect(kind(await t.edit('b.ts', 'Edit', env))).toBe('allow');
  await t.post('b.ts'); // approved now
  expect(kind(await t.edit('c.ts', 'Edit', env))).toBe('allow');
  expect(kind(await t.edit('b.ts', 'Edit', env))).toBe('allow'); // re-edit: no event
  const ev = readEvents(t.root).filter((e) => e.check === 'multi-file');
  expect(ev.map((e) => [e.decision, e.files])).toEqual([['allow-log', ['a.ts', 'b.ts']], ['allow-log', ['a.ts', 'b.ts', 'c.ts']]]);
});

test('end to end through the real registry: two edits, a prompt, then the third is allowed', async () => {
  const t = setup();
  const s = (o: Record<string, unknown>) => t.send(o, {}, registry);
  const pre = (p: string) => s({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: p } });
  const postE = (p: string) => s({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: p } });
  expect(await pre('a.ts')).toBe('');
  await postE('a.ts');
  expect(JSON.parse(await pre('b.ts')).hookSpecificOutput.permissionDecision).toBe('ask');
  await postE('b.ts');
  expect(await pre('c.ts')).toBe('');
  await s({ hook_event_name: 'UserPromptSubmit', prompt: 'next' });
  await postE('c.ts');
  expect(await pre('c.ts')).toBe('');
  expect(await pre('d.ts')).not.toBe('');
});
