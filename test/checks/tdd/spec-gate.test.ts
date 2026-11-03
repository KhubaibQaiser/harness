import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { specGate } from '../../../src/checks/tdd/spec-gate.js';
import { writeState } from '../../../src/core/state.js';
import { dispatch, registry } from '../../../src/hooks/dispatch.js';

const T = 'src/a.test.ts';
const feat = (id: string, passes: boolean, criteria: unknown[] | undefined) => ({ id, title: id, passes, ...(criteria ? { criteria } : {}) });
const doc = (...f: unknown[]) => JSON.stringify({ features: f });
const setup = (cfg = 'checks:\n  tdd: true\n') => {
  const root = mkdtempSync(join(tmpdir(), 'h-sg-'));
  mkdirSync(join(root, '.harness/results'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), cfg.replaceAll('ROOT', root));
  const startedAt = Math.floor((Date.now() - 10000) / 1000) * 1000;
  writeState(root, 's', { startedAt, files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 });
  let n = 0;
  const result = (file: string, tests: [string, string][], at = Date.now(), dir = '.harness/results') => {
    mkdirSync(join(root, dir), { recursive: true });
    const p = join(root, dir, `r${n++}.json`);
    writeFileSync(p, JSON.stringify({ testResults: [{ name: join(root, file), status: 'passed', assertionResults: tests.map(([fullName, status]) => ({ fullName, status })) }] }));
    utimesSync(p, at / 1000, at / 1000);
  };
  const call = async (tool: string, input: Record<string, unknown>) => {
    const out = await dispatch(JSON.stringify({ session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }), [specGate], {});
    return out ? (JSON.parse(out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string }) : { permissionDecision: 'allow', permissionDecisionReason: '' };
  };
  const write = (content: string) => call('Write', { file_path: join(root, 'features.json'), content });
  return { root, startedAt, result, call, write };
};
const crit = (test?: string) => [{ text: 'does x', ...(test ? { test } : {}) }];

test('registered after testLock, not fail-closed, PreToolUse', () => {
  expect(registry.map((c) => c.name).slice(0, 7)).toEqual(['guard', 'protect', 'sandbox-required', 'redFirst', 'tamper', 'testLock', 'specGate']);
  expect(specGate.failClosed).toBeFalsy();
  expect(specGate.events).toEqual(['PreToolUse']);
});

test('passing test allows the feature to pass', async () => {
  const s = setup();
  s.result(T, [['adds', 'passed']]);
  expect((await s.write(doc(feat('f1', true, crit(`${T}::adds`))))).permissionDecision).toBe('allow');
});

test('failure reasons: no test named, test not found, test not passing', async () => {
  const s = setup();
  s.result(T, [['adds', 'passed'], ['fails', 'failed']]);
  const d = async (test?: string) => (await s.write(doc(feat('f1', true, crit(test))))).permissionDecisionReason;
  expect(await d()).toBe("f1 can't be marked passing: does x → no test named.");
  expect(await d(T)).toBe("f1 can't be marked passing: does x → no test named.");
  expect(await d(`${T}::nope`)).toBe("f1 can't be marked passing: does x → test not found.");
  expect(await d(`src/none.test.ts::adds`)).toBe("f1 can't be marked passing: does x → test not found.");
  expect(await d(`${T}::fails`)).toBe("f1 can't be marked passing: does x → test not passing.");
});

test('no criteria denies; splits on first :: only', async () => {
  const s = setup();
  s.result(T, [['a::b', 'passed']]);
  expect((await s.write(doc(feat('f1', true, []))))).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: "f1 can't be marked passing: no criteria." });
  expect((await s.write(doc(feat('f1', true, undefined)))).permissionDecisionReason).toContain('no criteria');
  expect((await s.write(doc(feat('f1', true, crit(`${T}::a::b`))))).permissionDecision).toBe('allow');
});

test('multiple features: first failing criterion each, joined by "; "', async () => {
  const s = setup();
  const r = await s.write(doc(feat('f1', true, crit()), feat('f2', true, [{ text: 'c1', test: `${T}::x` }, { text: 'c2' }])));
  expect(r.permissionDecisionReason).toBe("f1 can't be marked passing: does x → no test named.; f2 can't be marked passing: c1 → test not found.");
});

test('unchanged passes, already-passing and still-false features are allowed', async () => {
  const s = setup();
  writeFileSync(join(s.root, 'features.json'), doc(feat('f1', true, crit()), feat('f2', false, crit())));
  expect((await s.write(doc(feat('f1', true, crit()), feat('f2', false, crit('x')), feat('f3', false, []))))).toMatchObject({ permissionDecision: 'allow' });
  expect((await s.write(doc(feat('f1', true, crit()), feat('f2', true, crit())))).permissionDecisionReason).toContain('f2 can\'t');
});

test('new feature added passing is gated; invalid before means nothing passing yet', async () => {
  const s = setup();
  writeFileSync(join(s.root, 'features.json'), '{ not json');
  expect((await s.write(doc(feat('f1', true, crit())))).permissionDecision).toBe('deny');
});

test('invalid JSON after the edit is denied', async () => {
  const s = setup();
  expect(await s.write('{ nope')).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'features.json would be invalid JSON.' });
});

test('Edit and MultiEdit use the post-edit content', async () => {
  const s = setup();
  s.result(T, [['adds', 'passed']]);
  const p = join(s.root, 'features.json');
  writeFileSync(p, doc(feat('f1', false, crit('x::y'))));
  const text = readFileSync(p, 'utf8');
  expect((await s.call('Edit', { file_path: p, old_string: '"passes":false', new_string: '"passes":true' })).permissionDecision).toBe('deny');
  expect((await s.call('MultiEdit', { file_path: p, edits: [{ old_string: '"passes":false', new_string: '"passes":true' }, { old_string: 'x::y', new_string: `${T}::adds` }] })).permissionDecision).toBe('allow');
  expect(readFileSync(p, 'utf8')).toBe(text);
});

test('only root features.json is gated; TDD off disables; pause does not', async () => {
  const s = setup();
  const bad = doc(feat('f1', true, []));
  expect((await s.call('Write', { file_path: join(s.root, 'sub/features.json'), content: bad })).permissionDecision).toBe('allow');
  expect((await s.call('Write', { file_path: join(s.root, 'other.json'), content: bad })).permissionDecision).toBe('allow');
  const off = setup('checks:\n  tdd: false\n');
  expect((await off.write(bad)).permissionDecision).toBe('allow');
  mkdirSync(join(s.root, '.harness/state'), { recursive: true });
  writeFileSync(join(s.root, '.harness/state/tdd-pause.json'), JSON.stringify({ createdAt: Date.now() }));
  expect((await s.write(bad)).permissionDecision).toBe('deny');
});

test('Bash writes to features.json are denied', async () => {
  const s = setup();
  const MSG = 'Edit features.json with the Edit or Write tool so the spec gate can check it.';
  for (const command of ['echo {} > features.json', "sed -i 's/false/true/' features.json"]) {
    expect(await s.call('Bash', { command })).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: MSG });
  }
  expect((await s.call('Bash', { command: 'cat features.json' })).permissionDecision).toBe('allow');
});

test('real Vitest fixture fullName format', async () => {
  const s = setup();
  const fx = readFileSync(join(__dirname, '../../fixtures/results/vitest.json'), 'utf8').replaceAll('/ROOT', JSON.stringify(s.root).slice(1, -1)); // JSON-escaped: Windows paths have backslashes
  writeFileSync(join(s.root, '.harness/results/fx.json'), fx);
  expect((await s.write(doc(feat('f1', true, crit(`${T}::adds`))))).permissionDecision).toBe('allow');
  expect((await s.write(doc(feat('f1', true, crit(`${T}::fails`))))).permissionDecisionReason).toContain('test not passing');
});

test('stale result (mtime before startedAt) is test not found', async () => {
  const s = setup();
  s.result(T, [['adds', 'passed']], s.startedAt - 5000);
  expect((await s.write(doc(feat('f1', true, crit(`${T}::adds`))))).permissionDecisionReason).toBe("f1 can't be marked passing: does x → test not found.");
});

test('a newer fresh failure beats an older fresh pass', async () => {
  const s = setup();
  s.result(T, [['adds', 'passed']], Date.now() - 4000);
  s.result(T, [['adds', 'failed']], Date.now() - 1000);
  expect((await s.write(doc(feat('f1', true, crit(`${T}::adds`))))).permissionDecisionReason).toContain('test not passing');
});

test('ids must be unique non-empty strings', async () => {
  const s = setup();
  s.result(T, [['adds', 'passed']]);
  const ok = feat('f1', true, crit(`${T}::adds`));
  writeFileSync(join(s.root, 'features.json'), doc(ok));
  expect((await s.write(doc(ok, feat('f1', true, crit())))).permissionDecisionReason).toBe('features.json has a missing or duplicate feature id: f1.');
  expect((await s.write(doc({ title: 'x', passes: false, criteria: [] }))).permissionDecisionReason).toBe('features.json has a missing or duplicate feature id: (missing).');
  expect((await s.write(doc({ id: '', passes: false }))).permissionDecisionReason).toBe('features.json has a missing or duplicate feature id: (missing).');
});

test('passes must be a boolean', async () => {
  const s = setup();
  for (const v of ['true', 1]) {
    expect((await s.write(doc({ id: 'f1', title: 'f1', passes: v, criteria: [] }))).permissionDecisionReason).toBe('f1 has a non-boolean passes value.');
  }
});

test('criterion file part is normalised (./ and absolute)', async () => {
  const s = setup();
  s.result(T, [['adds', 'passed']]);
  expect((await s.write(doc(feat('f1', true, crit(`./${T}::adds`))))).permissionDecision).toBe('allow');
  expect((await s.write(doc(feat('f1', true, crit(`${join(s.root, T)}::adds`))))).permissionDecision).toBe('allow');
});

test('absolute results_dir works', async () => {
  const s = setup('checks:\n  tdd: true\ntdd:\n  results_dir: ROOT/abs-results\n');
  s.result(T, [['adds', 'passed']], Date.now(), 'abs-results');
  expect((await s.write(doc(feat('f1', true, crit(`${T}::adds`))))).permissionDecision).toBe('allow');
});

test('features.json missing on disk: Write creating a passing, evidenced feature is allowed', async () => {
  const s = setup();
  s.result(T, [['adds', 'passed']]);
  expect((await s.write(doc(feat('f1', true, crit(`${T}::adds`))))).permissionDecision).toBe('allow');
});

test('a deny is logged under the kebab-case id spec-gate', async () => {
  const s = setup();
  await s.write('{not json');
  const ev = readFileSync(join(s.root, '.harness/logs/events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(ev.at(-1)).toMatchObject({ check: 'spec-gate', decision: 'deny' });
});

test('PowerShell writes to features.json are denied with the Bash message', async () => {
  const s = setup();
  expect(await s.call('PowerShell', { command: 'echo {} > features.json' })).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'Edit features.json with the Edit or Write tool so the spec gate can check it.' });
});
