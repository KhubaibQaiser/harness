import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const ev = (d: number, check: string, decision: string, reason?: string) => JSON.stringify({ ts: ago(d), session: 's', check, decision, ...(reason ? { reason } : {}) });
const seed = (lines: string[]) => {
  const root = mkdtempSync(join(tmpdir(), 'h-st-'));
  mkdirSync(join(root, '.harness/logs'), { recursive: true });
  writeFileSync(join(root, '.harness/logs/events.jsonl'), lines.join('\n') + '\n');
  return root;
};
const stats = (root: string, args: string[] = []) => {
  let out = '';
  const code = run(['stats', ...args], { root, env: {}, out: (s) => (out += s + '\n') });
  return { code, out };
};

const lines = [
  ev(1, 'guard', 'deny'),
  ev(1, 'guard', 'deny'),
  ev(2, 'tdd', 'paused'),
  ev(2, 'multi-file', 'allow-log'),
  ev(2, 'multi-file', 'approved'),
  ev(3, 'stop', 'block', 'lint failed (attempt 1 of 3). Fix it'),
  ev(3, 'stop', 'block', 'lint failed (attempt 2 of 3). Fix it'),
  ev(3, 'stop', 'block', 'test failed (attempt 1 of 3). Fix it'),
  ev(3, 'stop', 'block', 'Diff coverage 40% is below 80%. Uncovered: a.ts:1'),
  ev(3, 'stop', 'block', 'Coverage output at **/coverage/coverage-final.json could not be parsed.'),
  ev(3, 'stop', 'block'),
  ev(3, 'stop', 'context', 'Stop gate timed out after 5s'),
  ev(3, 'stop', 'stop-gave-up'),
  ev(3, 'stop', 'stop-skipped', 'git status failed'),
  ev(3, 'stop', 'stop-diff-failed'),
  ev(3, 'stop', 'coverage-skipped', 'no base'),
  ev(3, 'stop', 'coverage-diff-failed', 'x'),
  ev(10, 'guard', 'deny'), // out of the default window
  'not json{',
];

test('counts the window exactly and skips malformed lines', () => {
  const r = stats(seed(lines));
  expect(r.code).toBe(0);
  expect(r.out).toContain('guard deny: 2');
  expect(r.out).toContain('stop block: 6');
  expect(r.out).toContain('Overrides\n  tdd paused: 1\n  multi-file approvals: 2\n  allow-log: 1');
  expect(r.out).toContain('Stop failures by step\n  lint: 2\n  test: 1\n  coverage: 2\n  other: 1');
  expect(r.out).toContain('Gave up and timeouts\n  timeouts: 1\n  stop-gave-up: 1\n  stop-skipped: 1\n  stop-diff-failed: 1\n  coverage-skipped: 1\n  coverage-diff-failed: 1');
});

test('--days widens the window', () => {
  expect(stats(seed(lines), ['--days', '30']).out).toContain('guard deny: 3');
  expect(stats(seed(lines), ['--days', '1']).out).toContain('No harness events in the last 1 days.');
});

test('no events', () => {
  expect(stats(seed(['']), []).out.trim()).toBe('No harness events in the last 7 days.');
});

test('--days must be a positive integer', () => {
  const root = seed(lines);
  for (const a of [['--days', '0'], ['--days', '-1'], ['--days', '1.5'], ['--days', 'x'], ['--days']]) expect(stats(root, a).code).toBe(2);
});
