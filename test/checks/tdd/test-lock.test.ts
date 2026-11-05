import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { testLock } from '../../../src/checks/tdd/test-lock.js';
import { newestFresh, type TestFileResult } from '../../../src/checks/tdd/results.js';
import { clearTurn, readState, writeState } from '../../../src/core/state.js';
import { dispatch, registry } from '../../../src/hooks/dispatch.js';

const CFG = 'checks:\n  tdd: true\ntdd:\n  paths: ["src/**"]\n  exempt: ["src/ui/**"]\n';
const T = 'src/a.test.ts';
const MSG = `${T} was written as a failing test. Changing it while making it pass needs your approval.`;
const setup = (cfg = CFG, env: NodeJS.ProcessEnv = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'h-tl-'));
  mkdirSync(join(root, '.harness/results'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), cfg);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, T), "it('a', () => {\n  expect(1 + 1).toBe(2);\n});\n");
  const startedAt = Math.floor((Date.now() - 10000) / 1000) * 1000;
  writeState(root, 's', { startedAt, files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 });
  let n = 0;
  const result = (file: string, status: 'passed' | 'failed', at = Date.now()) => {
    const p = join(root, '.harness/results', `r${n++}.json`);
    writeFileSync(p, JSON.stringify({ testResults: [{ name: join(root, file), status, assertionResults: [{ fullName: 't', status }] }] }));
    utimesSync(p, at / 1000, at / 1000);
  };
  const call = async (event: string, p: string, checks = [testLock], tool = 'Edit', input: Record<string, unknown> = {}) => {
    const out = await dispatch(JSON.stringify({ session_id: 's', cwd: root, hook_event_name: event, tool_name: tool, tool_input: { file_path: p, ...input } }), checks, env);
    return out ? (JSON.parse(out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string }) : { permissionDecision: 'allow', permissionDecisionReason: '' };
  };
  return { root, startedAt, result, call, st: () => readState(root, 's') };
};

test('registered after tamper, not fail-closed, Pre and PostToolUse', () => {
  expect(registry.map((c) => c.name).slice(0, 7)).toEqual(['guard', 'pr-size', 'protect', 'sandbox-required', 'redFirst', 'tamper', 'testLock']);
  expect(testLock.failClosed).toBeFalsy();
  expect(testLock.events).toEqual(['PreToolUse', 'PostToolUse']);
});

test('test written then seen failing becomes locked', async () => {
  const s = setup();
  await s.call('PostToolUse', T);
  await s.call('PostToolUse', join(s.root, T)); // absolute path, de-duplicated
  expect(s.st().redTests).toEqual([T]);
  s.result(T, 'failed');
  await s.call('PreToolUse', 'src/other.ts');
  expect(s.st()).toMatchObject({ redTests: [T], lockedTests: [T] });
});

test('editing a locked test asks with the exact message', async () => {
  const s = setup();
  await s.call('PostToolUse', T);
  s.result(T, 'failed');
  expect(await s.call('PreToolUse', T)).toMatchObject({ permissionDecision: 'ask', permissionDecisionReason: MSG });
});

test('a test never seen failing is not locked', async () => {
  const s = setup();
  await s.call('PostToolUse', T);
  expect((await s.call('PreToolUse', T)).permissionDecision).toBe('allow');
  s.result(T, 'passed');
  expect((await s.call('PreToolUse', T)).permissionDecision).toBe('allow');
  expect(s.st().lockedTests).toEqual([]);
});

test('a stale failing result (before session start) does not lock', async () => {
  const s = setup();
  await s.call('PostToolUse', T);
  s.result(T, 'failed', s.startedAt - 5000);
  expect((await s.call('PreToolUse', T)).permissionDecision).toBe('allow');
});

test('non-test files are never added; PostToolUse on a non-test file does nothing', async () => {
  const s = setup();
  await s.call('PostToolUse', 'src/a.ts');
  expect(s.st().redTests).toEqual([]);
});

test('paused TDD allows', async () => {
  const s = setup();
  await s.call('PostToolUse', T);
  s.result(T, 'failed');
  writeFileSync(join(s.root, '.harness/state/tdd-pause.json'), JSON.stringify({ createdAt: new Date().toISOString(), session: 's' }));
  expect((await s.call('PreToolUse', T)).permissionDecision).toBe('allow');
});

test('tests outside tdd.paths or inside tdd.exempt are never locked', async () => {
  for (const f of ['lib/b.test.ts', 'src/ui/c.test.ts']) {
    const s = setup();
    await s.call('PostToolUse', f);
    s.result(f, 'failed');
    expect((await s.call('PreToolUse', f)).permissionDecision, f).toBe('allow');
    expect(s.st().redTests).toEqual([]);
  }
});

test('inactive when checks.tdd or tdd.test_lock is off', async () => {
  for (const cfg of ['checks:\n  tdd: false\ntdd:\n  paths: ["src/**"]\n', 'checks:\n  tdd: true\ntdd:\n  paths: ["src/**"]\n  test_lock: false\n']) {
    const s = setup(cfg);
    await s.call('PostToolUse', T);
    expect(s.st().redTests).toEqual([]);
  }
});

test('unattended: ask becomes deny through the dispatcher', async () => {
  const s = setup(CFG, { HARNESS_UNATTENDED: '1' });
  await s.call('PostToolUse', T);
  s.result(T, 'failed');
  const d = await s.call('PreToolUse', T);
  expect(d.permissionDecision).toBe('deny');
  expect(d.permissionDecisionReason).toContain(MSG);
});

test('locks persist across prompts: clearTurn keeps redTests and lockedTests', () => {
  const s = setup();
  writeState(s.root, 's', { ...s.st(), redTests: ['a'], lockedTests: ['b'], files: ['x'] });
  clearTurn(s.root, 's');
  expect(s.st()).toMatchObject({ redTests: ['a'], lockedTests: ['b'], files: [] });
});

test('end to end with the real registry: locked while red, free once green', async () => {
  const s = setup();
  const add = { old_string: 'toBe(2);', new_string: 'toBe(2);\n  expect(2 + 2).toBe(4);' };
  await s.call('PostToolUse', T, registry, 'Write', { content: 'x' });
  s.result(T, 'failed', Date.now() - 2000);
  expect((await s.call('PreToolUse', T, registry, 'Edit', add)).permissionDecision).toBe('ask');
  s.result(T, 'passed', Date.now());
  expect((await s.call('PreToolUse', T, registry, 'Edit', add)).permissionDecision).toBe('allow');
  expect(s.st().lockedTests).toEqual([]);
});

test('newestFresh keeps the newest fresh result per file and drops stale ones', () => {
  const r = (file: string, status: 'passed' | 'failed', writtenAt: number): TestFileResult => ({ file, status, tests: [], writtenAt });
  const m = newestFresh([r('a', 'failed', 200), r('a', 'passed', 300), r('b', 'failed', 50), r('c', 'failed', 100)], 100);
  expect([...m.entries()].map(([k, v]) => [k, v.status])).toEqual([['a', 'passed'], ['c', 'failed']]);
});

test('a PowerShell input naming a locked test file is allowed (no shell detection)', async () => {
  const s = setup();
  writeState(s.root, 's', { ...s.st(), lockedTests: [T] });
  // the lock is live: an Edit of the same file under the same state needs approval (ask)
  expect(await s.call('PreToolUse', T)).toMatchObject({ permissionDecision: 'ask', permissionDecisionReason: MSG });
  // a pure shell input: a command only, no file_path
  const raw = JSON.stringify({ session_id: 's', cwd: s.root, hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: `Set-Content ${T} x` } });
  expect(await dispatch(raw, [testLock], {})).toBe('');
});
