import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { withSessionLock } from '../../src/core/state.js';
import { dispatch } from '../../src/hooks/dispatch.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'h-lock-'));

test('lock is released after fn, even when it throws', async () => {
  const root = tmp();
  await expect(withSessionLock(root, 's', () => { throw new Error('x'); })).rejects.toThrow('x');
  expect(existsSync(join(root, '.harness/state/s.lock'))).toBe(false);
  expect(await withSessionLock(root, 's', () => 7)).toBe(7);
});

const lockDir = (root: string) => join(root, '.harness/state/s.lock');
const mkLock = (root: string, owner?: { pid: number; nonce: string }, ageMs = 0) => {
  mkdirSync(lockDir(root), { recursive: true });
  if (owner) writeFileSync(join(lockDir(root), 'owner'), JSON.stringify(owner));
  const t = new Date(Date.now() - ageMs);
  utimesSync(lockDir(root), t, t);
};
const deadPid = () =>
  new Promise<number>((res) => {
    const c = spawn(process.execPath, ['-e', '']);
    c.on('close', () => res(c.pid as number));
  });
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const orig = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await f();
  } finally {
    process.stderr.write = orig;
  }
};

test('a live holder\'s lock is never removed by a waiter, however old', async () => {
  const root = tmp();
  mkLock(root, { pid: process.pid, nonce: 'live' }, 60000);
  expect(await quiet(() => withSessionLock(root, 's', () => 'ran'))).toBe('ran');
  expect(existsSync(lockDir(root))).toBe(true);
  expect(readFileSync(join(lockDir(root), 'owner'), 'utf8')).toContain('live');
}, 10000);

test('release by a non-owner is a no-op', async () => {
  const root = tmp();
  await withSessionLock(root, 's', () => writeFileSync(join(lockDir(root), 'owner'), JSON.stringify({ pid: process.pid, nonce: 'thief' })));
  expect(readFileSync(join(lockDir(root), 'owner'), 'utf8')).toContain('thief');
});

test('a dead-pid lock is recovered quickly', async () => {
  const root = tmp();
  mkLock(root, { pid: await deadPid(), nonce: 'dead' });
  const t = Date.now();
  expect(await withSessionLock(root, 's', () => 'ok')).toBe('ok');
  expect(Date.now() - t).toBeLessThan(1000);
  expect(existsSync(lockDir(root))).toBe(false);
});

test('an owner-less lock is stale only after 30 s', async () => {
  const root = tmp();
  mkLock(root, undefined, 31000);
  const t = Date.now();
  expect(await withSessionLock(root, 's', () => 'ok')).toBe('ok');
  expect(Date.now() - t).toBeLessThan(1000);
});

test('Stop dispatch does not wait on a held lock', async () => {
  const root = tmp();
  mkLock(root, { pid: process.pid, nonce: 'live' });
  const t = Date.now();
  await dispatch(JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: root }), [], {});
  expect(Date.now() - t).toBeLessThan(500);
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
