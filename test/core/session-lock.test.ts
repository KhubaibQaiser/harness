import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { withSessionLock } from '../../src/core/state.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'h-lock-'));

test('lock is released after fn, even when it throws', async () => {
  const root = tmp();
  await expect(withSessionLock(root, 's', () => { throw new Error('x'); })).rejects.toThrow('x');
  expect(existsSync(join(root, '.harness/state/s.lock'))).toBe(false);
  expect(await withSessionLock(root, 's', () => 7)).toBe(7);
});

test('a stale lock (older than 5 s) is recovered', async () => {
  const root = tmp();
  const lock = join(root, '.harness/state/s.lock');
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 6000);
  utimesSync(lock, old, old);
  const t = Date.now();
  expect(await withSessionLock(root, 's', () => 'ok')).toBe('ok');
  expect(Date.now() - t).toBeLessThan(1000);
});

test('a fresh held lock times out after ~2 s, runs fn anyway and warns', async () => {
  const root = tmp();
  mkdirSync(join(root, '.harness/state/s.lock'), { recursive: true });
  const w: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((s: string) => (w.push(String(s)), true)) as typeof process.stderr.write;
  try {
    const t = Date.now();
    expect(await withSessionLock(root, 's', () => 'ran')).toBe('ran');
    expect(Date.now() - t).toBeGreaterThanOrEqual(1900);
  } finally {
    process.stderr.write = orig;
  }
  expect(w.join('')).toContain('harness: state lock timeout');
}, 10000);

test('10 parallel dispatcher processes for one session: exactly one allow, the rest ask', async () => {
  const repo = tmp();
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  multiFile: true\n');
  const run = (i: number) =>
    new Promise<string>((res) => {
      const p = spawn(process.execPath, [join(process.cwd(), 'dist/hooks/dispatch.mjs')]);
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => res(out));
      p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'par', cwd: repo, tool_name: 'Edit', tool_input: { file_path: `f${i}.ts` } }));
    });
  const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => run(i)));
  expect(outs.filter((o) => o === '')).toHaveLength(1);
  expect(outs.filter((o) => JSON.parse(o || '{}').hookSpecificOutput?.permissionDecision === 'ask')).toHaveLength(9);
}, 30000);
