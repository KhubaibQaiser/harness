import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync as renameSyncReal, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readState, withSessionLock, writeState } from '../../src/core/state.js';
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

test('10 parallel dispatcher processes for one session: no lost state updates', async () => {
  const repo = tmp();
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  multiFile: true\n');
  const run = (i: number) =>
    new Promise<string>((res) => {
      const p = spawn(process.execPath, [join(process.cwd(), 'dist/hooks/dispatch.mjs')]);
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => res(out));
      p.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'par', cwd: repo, tool_name: 'Edit', tool_input: { file_path: `f${i}.ts` } }));
    });
  const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => run(i)));
  expect(outs).toEqual(Array(10).fill(''));
  expect(readState(repo, 'par').files.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `f${i}.ts`).sort());
}, 30000);

// Windows race shapes, reproduced on every OS with injected fs errors (CI run 41377482722 lost 1 of 10 updates).
const busy = (code: string) => Object.assign(new Error(code), { code });

test('release frees the lock name even when Windows refuses the first removals (a waiter has owner open)', async () => {
  const root = tmp();
  let fails = 3;
  const ops = {
    rename: (a: string, b: string) => {
      if (fails-- > 0) throw busy('EPERM');
      renameSyncReal(a, b);
    },
  };
  expect(await withSessionLock(root, 's', () => 'ok', ops)).toBe('ok');
  expect(existsSync(lockDir(root))).toBe(false); // never left behind as a dead-owner lock
});

test('a waiter that breaks a stale lock but finds a live lock in its hands puts it back', async () => {
  const root = tmp();
  mkLock(root, { pid: await deadPid(), nonce: 'dead' });
  let raced = false;
  const ops = {
    rename: (a: string, b: string) => {
      if (!raced && b.includes('.stale.')) {
        // Between this waiter's stale check and its rename, another waiter broke the stale lock and took it.
        raced = true;
        rmSync(lockDir(root), { recursive: true, force: true });
        mkLock(root, { pid: process.pid, nonce: 'other' });
      }
      renameSyncReal(a, b);
    },
  };
  let ownerInFn = '';
  await quiet(() => withSessionLock(root, 's', () => (ownerInFn = readFileSync(join(lockDir(root), 'owner'), 'utf8')), ops));
  expect(raced).toBe(true);
  expect(ownerInFn).toContain('other'); // the live lock is back and was never shared: this waiter timed out instead
}, 10000);

test('readState retries a transient read error instead of starting the session over', () => {
  const root = tmp();
  writeState(root, 's', { ...readState(root, 's'), files: ['kept.ts'] });
  let fails = 2;
  const read = (p: string, e: 'utf8') => {
    if (fails-- > 0) throw busy('EBUSY');
    return readFileSync(p, e);
  };
  expect(readState(root, 's', read).files).toEqual(['kept.ts']);
  expect(() => readState(root, 's', () => { throw busy('EACCES'); })).toThrow(); // never a silent fresh state
  expect(readState(root, 'none', () => { throw busy('ENOENT'); }).files).toEqual([]);
});
