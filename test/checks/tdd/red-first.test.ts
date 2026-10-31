import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { redFirst } from '../../../src/checks/tdd/red-first.js';
import { writeState } from '../../../src/core/state.js';
import { dispatch, registry } from '../../../src/hooks/dispatch.js';

const CFG = 'checks:\n  tdd: true\ntdd:\n  paths: ["packages/**"]\n  exempt: ["packages/ui/**"]\n';
const setup = (cfg = CFG) => {
  const root = mkdtempSync(join(tmpdir(), 'h-rf-'));
  mkdirSync(join(root, '.harness/state/test-results'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), cfg);
  const startedAt = Math.floor((Date.now() - 10000) / 1000) * 1000; // whole seconds so utimes round-trips exactly
  writeState(root, 's', { startedAt, files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 });
  let n = 0;
  const result = (file: string, status: 'passed' | 'failed', at = Date.now()) => {
    const p = join(root, '.harness/state/test-results', `r${n++}.json`);
    const a = status === 'failed' ? 'failed' : 'passed';
    writeFileSync(p, JSON.stringify({ testResults: [{ name: join(root, file), status, assertionResults: [{ fullName: 't', status: a }] }] }));
    utimesSync(p, at / 1000, at / 1000);
  };
  const edit = async (p: string, checks = [redFirst], tool = 'Edit') => {
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    const out = await dispatch(JSON.stringify({ session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { [key]: p } }), checks, {});
    return out ? (JSON.parse(out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string }) : { permissionDecision: 'allow', permissionDecisionReason: '' };
  };
  return { root, startedAt, result, edit };
};
const A = 'packages/core/src/a.ts';
const T = 'packages/core/src/a.test.ts';

test('registered after multiFile, not fail-closed, PreToolUse', () => {
  expect(registry.map((c) => c.name).slice(0, 4)).toEqual(['guard', 'protect', 'multiFile', 'redFirst']);
  expect(redFirst.failClosed).toBeFalsy();
  expect(redFirst.events).toEqual(['PreToolUse']);
});

test('blocked with no related test, suggesting the sibling path', async () => {
  const d = await setup().edit(A);
  expect(d.permissionDecision).toBe('deny');
  expect(d.permissionDecisionReason).toBe(`No test for ${A}. Write a failing test first (e.g. packages/core/src/a.test.ts), run it, then edit.`);
});

test('tsx keeps its extension in the suggestion', async () => {
  expect((await setup().edit('packages/core/src/B.tsx')).permissionDecisionReason).toContain('(e.g. packages/core/src/B.test.tsx)');
});

test('allowed after a fresh failing related run', async () => {
  const t = setup();
  t.result(T, 'failed');
  expect((await t.edit(A)).permissionDecision).toBe('allow');
});

test('NotebookEdit and absolute paths are covered', async () => {
  const t = setup();
  expect((await t.edit(join(t.root, A), [redFirst], 'NotebookEdit')).permissionDecision).toBe('deny');
  t.result(T, 'failed');
  expect((await t.edit(join(t.root, A), [redFirst], 'Write')).permissionDecision).toBe('allow');
});

test('blocked again once related tests pass (strict)', async () => {
  const t = setup();
  t.result(T, 'passed');
  const d = await t.edit(A);
  expect(d.permissionDecision).toBe('deny');
  expect(d.permissionDecisionReason).toBe(`Red first: ${T} is passing. Add or change a test so it fails, run it, then edit ${A}.`);
});

test('stale failing result from before the session is ignored, with the No test message at the existing path', async () => {
  const t = setup();
  t.result(T, 'failed', t.startedAt - 1000);
  const d = await t.edit(A);
  expect(d.permissionDecision).toBe('deny');
  expect(d.permissionDecisionReason).toBe(`No test for ${A}. Write a failing test first (e.g. ${T}), run it, then edit.`);
});

test('only the newest fresh result per test file counts', async () => {
  const t = setup();
  t.result(T, 'failed', Date.now() - 2000);
  t.result(T, 'passed', Date.now() - 1000);
  expect((await t.edit(A)).permissionDecision).toBe('deny');
  t.result(T, 'failed', Date.now());
  expect((await t.edit(A)).permissionDecision).toBe('allow');
});

test('exempt, test, outside-root and non-tdd files are allowed', async () => {
  const t = setup();
  for (const f of ['packages/ui/src/Button.tsx', T, '/tmp/a.ts', 'docs/x.md']) expect((await t.edit(f)).permissionDecision).toBe('allow');
});

test('does nothing when checks.tdd is false', async () => {
  expect((await setup('tdd:\n  paths: ["packages/**"]\n').edit(A)).permissionDecision).toBe('allow');
});

test('paused TDD allows only when bound to this session', async () => {
  const t = setup();
  const pf = join(t.root, '.harness/state/tdd-pause.json');
  writeFileSync(pf, JSON.stringify({ createdAt: new Date().toISOString() }));
  expect((await t.edit(A)).permissionDecision).toBe('deny'); // pending
  writeFileSync(pf, JSON.stringify({ createdAt: new Date().toISOString(), session: 'other' }));
  expect((await t.edit(A)).permissionDecision).toBe('deny');
  writeFileSync(pf, JSON.stringify({ createdAt: new Date().toISOString(), session: 's' }));
  expect((await t.edit(A)).permissionDecision).toBe('allow');
});

test('end to end through the real registry', async () => {
  const t = setup();
  expect((await t.edit(A, registry)).permissionDecision).toBe('deny');
  t.result(T, 'failed');
  expect((await t.edit(A, registry)).permissionDecision).toBe('allow');
});

test('writtenAt equal to startedAt counts as fresh', async () => {
  const t = setup();
  t.result(T, 'failed', t.startedAt);
  expect((await t.edit(A)).permissionDecision).toBe('allow');
});
