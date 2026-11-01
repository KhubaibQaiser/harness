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

test('registered after specGate, not fail-closed, right events', () => {
  expect(registry.map((c) => c.name)).toEqual(['guard', 'protect', 'redFirst', 'tamper', 'testLock', 'specGate', 'multiFile', 'stopGate']);
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
  await t.send({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'b.ts' } }, env); // approved now, no attended approval logged
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

test('PreToolUse records an allowed edit, so a parallel second Pre asks', async () => {
  const t = setup();
  expect(kind(await t.edit('a.ts'))).toBe('allow');
  expect(readState(t.root, 's').files).toEqual(['a.ts']);
  expect(kind(await t.edit('b.ts'))).toBe('ask');
});

test('an asked edit is not recorded: retrying a allows, b asks again', async () => {
  const t = setup();
  await t.edit('a.ts');
  expect(kind(await t.edit('b.ts'))).toBe('ask');
  expect(kind(await t.edit('a.ts'))).toBe('allow');
  expect(kind(await t.edit('b.ts'))).toBe('ask');
  expect(readState(t.root, 's').files).toEqual(['a.ts']);
});

test('allow-log appends only when a unit is newly recorded, not on repeated Pre', async () => {
  const t = setup('allow-log');
  const env = { CI: 'true' };
  await t.edit('a.ts', 'Edit', env);
  await t.edit('b.ts', 'Edit', env);
  await t.edit('b.ts', 'Edit', env);
  await t.edit('b.test.ts', 'Edit', env);
  expect(readEvents(t.root).filter((e) => e.check === 'multi-file').map((e) => e.files)).toEqual([['a.ts', 'b.ts']]);
});

// --- unattended.require_reason ---
const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const asst = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', name: 'Edit' }] } });
const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } };
const reasonSetup = (lines: unknown[] | null, extra = '  require_reason: true\n') => {
  const t = setup('allow-log', extra);
  const transcript = join(t.root, 't.jsonl');
  if (lines) writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const edit2 = async (p: string) => t.edit(p, 'Edit', { CI: 'true' }, { transcript_path: transcript });
  const log = () => readEvents(t.root).filter((e) => e.check === 'multi-file');
  return { ...t, edit2, log };
};
const DENY = 'State why each extra file is necessary, then retry. Write one line per file: "<file> because <reason>".';

test('require_reason: reason present allows and logs it', async () => {
  const t = reasonSetup([user('go'), asst('Plan:\nsrc/b.ts because the helper moves there\nmore')]);
  await t.post('a.ts');
  expect(kind(await t.edit2('src/b.ts'))).toBe('allow');
  expect(t.log().map((e) => [e.decision, e.reason])).toEqual([['allow-log', 'src/b.ts: src/b.ts because the helper moves there']]);
});

test('require_reason: absent denies once, retry allowed with no reason given', async () => {
  const t = reasonSetup([user('go'), asst('just editing')]);
  await t.post('a.ts');
  const d = await t.edit2('b.ts');
  expect(kind(d)).toBe('deny');
  expect(d.permissionDecisionReason).toBe(DENY);
  expect(t.log().map((e) => e.decision)).toContain('reason-required');
  expect(kind(await t.edit2('b.ts'))).toBe('allow');
  expect(t.log().filter((e) => e.decision === 'allow-log').map((e) => e.reason)).toEqual(['b.ts: no reason given']);
});

test('require_reason: denied-state clears on the next prompt', async () => {
  const t = reasonSetup([user('go'), asst('nothing')]);
  await t.post('a.ts');
  await t.edit2('b.ts');
  await t.prompt();
  await t.post('a.ts');
  expect(kind(await t.edit2('b.ts'))).toBe('deny');
});

test('require_reason: a reason before the last user prompt does not count', async () => {
  const t = reasonSetup([user('one'), asst('b.ts because old'), user('two'), asst('nothing')]);
  await t.post('a.ts');
  expect(kind(await t.edit2('b.ts'))).toBe('deny');
});

test('require_reason: tool_result user lines do not end the turn', async () => {
  const t = reasonSetup([user([{ type: 'text', text: 'go' }]), asst('b.ts BECAUSE it is needed'), toolResult, asst('working')]);
  await t.post('a.ts');
  expect(kind(await t.edit2('b.ts'))).toBe('allow');
  expect(t.log()[0]!.reason).toBe('b.ts: b.ts BECAUSE it is needed');
});

test('require_reason: unreadable transcript fails open', async () => {
  const t = reasonSetup(null);
  await t.post('a.ts');
  expect(kind(await t.edit2('b.ts'))).toBe('allow');
  expect(t.log().map((e) => e.reason)).toEqual(['b.ts: transcript unreadable']);
});

test('require_reason false: plain allow-log, no reason needed', async () => {
  const t = reasonSetup([user('go'), asst('nothing')], '');
  await t.post('a.ts');
  expect(kind(await t.edit2('b.ts'))).toBe('allow');
  expect(t.log().map((e) => [e.decision, e.reason])).toEqual([['allow-log', undefined]]);
});

test('require_reason: attended runs unaffected', async () => {
  const t = reasonSetup([user('go'), asst('nothing')]);
  await t.post('a.ts');
  const d = await t.edit('b.ts', 'Edit', {}, { transcript_path: join(t.root, 't.jsonl') });
  expect(kind(d)).toBe('ask');
});

test('require_reason: reason line is truncated to 300 chars', async () => {
  const t = reasonSetup([user('go'), asst('b.ts because ' + 'x'.repeat(400))]);
  await t.post('a.ts');
  expect(kind(await t.edit2('b.ts'))).toBe('allow');
  expect(t.log()[0]!.reason).toBe('b.ts: ' + ('b.ts because ' + 'x'.repeat(400)).slice(0, 300));
});

test('require_reason: basename matches on boundaries only', async () => {
  const t = reasonSetup([user('go'), asst('data.ts because it differs\nmy-a.ts because no\na.tsx because no')]);
  await t.post('z.ts');
  expect(kind(await t.edit2('a.ts'))).toBe('deny');
  const ok = reasonSetup([user('go'), asst('Edit `a.ts` because yes')]);
  await ok.post('z.ts');
  expect(kind(await ok.edit2('a.ts'))).toBe('allow');
});

test('require_reason: malformed JSONL line is skipped', async () => {
  const t = reasonSetup([user('go'), asst('b.ts because ok')]);
  await t.post('a.ts');
  writeFileSync(join(t.root, 't.jsonl'), JSON.stringify(user('go')) + '\n{not json\n' + JSON.stringify(asst('b.ts because ok')) + '\n');
  expect(kind(await t.edit2('b.ts'))).toBe('allow');
  expect(t.log()[0]!.reason).toBe('b.ts: b.ts because ok');
});

test('require_reason: a third file needs its own reason', async () => {
  const t = reasonSetup([user('go'), asst('b.ts because x')]);
  await t.post('a.ts');
  expect(kind(await t.edit2('b.ts'))).toBe('allow');
  expect(kind(await t.edit2('c.ts'))).toBe('deny');
  expect(kind(await t.edit2('c.ts'))).toBe('allow');
  expect(t.log().filter((e) => e.decision === 'allow-log').map((e) => e.reason)).toEqual(['b.ts: b.ts because x', 'c.ts: no reason given']);
});

test('require_reason: block mode still blocks', async () => {
  const t = setup('block', '  require_reason: true\n');
  await t.post('a.ts');
  const d = await t.edit('b.ts', 'Edit', { CI: 'true' });
  expect(d.permissionDecisionReason).toBe('Unattended multi-file change blocked. Wanted: a.ts, b.ts.');
});

test('require_reason: a reason deny leaves files and approved unchanged', async () => {
  const t = reasonSetup([user('go'), asst('nothing')]);
  await t.post('a.ts');
  const before = readState(t.root, 's');
  await t.edit2('b.ts');
  const after = readState(t.root, 's');
  expect(after.files).toEqual(before.files);
  expect(after.approved).toBe(before.approved);
});

test.each([[{}], [{ CI: 'true' }]])('a red-first deny is not counted: the first real edit gets no multi-file ask (env %j)', async (env) => {
  const t = setup('block');
  writeFileSync(join(t.root, '.harness/config.yaml'), 'checks:\n  multiFile: true\n  tdd: true\ntdd:\n  paths: ["src/**"]\nunattended:\n  multi_file_gate: block\n');
  const pre = (p: string) => t.send({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: p } }, env, registry);
  expect(JSON.parse(await pre('src/a.ts')).hookSpecificOutput.permissionDecision).toBe('deny');
  expect(readState(t.root, 's').files).toEqual([]);
  expect(await pre('docs/n.md')).toBe('');
});

test('multiFile runs after every other PreToolUse check', () => {
  const pre = registry.filter((c) => c.events.includes('PreToolUse')).map((c) => c.name);
  expect(pre.at(-1)).toBe('multiFile');
});

test('an attended approval is logged once per turn', async () => {
  const t = setup();
  await t.post('a.ts');
  expect(kind(await t.edit('b.ts'))).toBe('ask');
  await t.post('b.ts'); // the user said yes
  await t.post('c.ts');
  const approved = () => readEvents(t.root).filter((e) => e.check === 'multi-file' && e.decision === 'approved');
  expect(approved().map((e) => e.files)).toEqual([['a.ts', 'b.ts']]);
  await t.prompt();
  await t.post('a.ts');
  await t.post('b.ts');
  expect(approved()).toHaveLength(2);
});
