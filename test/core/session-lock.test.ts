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

const realOps = { rename: renameSyncReal, rm: rmSync, mkdir: mkdirSync };

test('release: the rename fails every retry, so the lock dir itself is removed', async () => {
  const root = tmp();
  const ops = { ...realOps, rename: () => { throw busy('EPERM'); } };
  expect(await withSessionLock(root, 's', () => 'ok', ops)).toBe('ok');
  expect(existsSync(lockDir(root))).toBe(false);
});

test('release: rename succeeds but removing the freed dir fails; the next holder\'s lock is left alone', async () => {
  const root = tmp();
  const ops = {
    ...realOps,
    rm: (p: string, o?: object) => {
      if (p.includes('.free.')) {
        mkLock(root, { pid: process.pid, nonce: 'next' }); // a waiter takes the freed name at once
        throw busy('EPERM'); // a scanner holds the freed dir past every retry
      }
      rmSync(p, o);
    },
  };
  expect(await withSessionLock(root, 's', () => 'ok', ops)).toBe('ok');
  expect(readFileSync(join(lockDir(root), 'owner'), 'utf8')).toContain('next');
});

// Between a waiter's stale judgment and its break, the stale lock was broken by someone else and a new holder made a
// lock (owner file not written yet). The injection fires at whichever step comes first: taking the break lock, or the rename.
const swapToFreshLock = (root: string) => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    rmSync(lockDir(root), { recursive: true, force: true });
    mkdirSync(lockDir(root));
    writeFileSync(join(lockDir(root), 'marker'), 'new holder');
  };
};

test('stale owner-less lock: a new holder that has not written its owner file yet is never robbed', async () => {
  const root = tmp();
  mkLock(root, undefined, 31000);
  const swap = swapToFreshLock(root);
  const ops = {
    rename: (a: string, b: string) => (b.includes('.stale.') && swap(), renameSyncReal(a, b)),
    rm: rmSync,
    mkdir: (p: string, o?: object) => (p.endsWith('.break') && swap(), mkdirSync(p, o)),
  };
  await quiet(() => withSessionLock(root, 's', () => 'ran', ops));
  expect(readFileSync(join(lockDir(root), 'marker'), 'utf8')).toBe('new holder');
}, 10000);

test('stale dead-owner lock: a new live lock made in the race window is never renamed away', async () => {
  const root = tmp();
  mkLock(root, { pid: await deadPid(), nonce: 'dead' });
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    rmSync(lockDir(root), { recursive: true, force: true });
    mkLock(root, { pid: process.pid, nonce: 'other' });
  };
  const renames: string[] = [];
  const ops = {
    rename: (a: string, b: string) => (b.includes('.stale.') && swap(), renames.push(b), renameSyncReal(a, b)),
    rm: rmSync,
    mkdir: (p: string, o?: object) => (p.endsWith('.break') && swap(), mkdirSync(p, o)),
  };
  await quiet(() => withSessionLock(root, 's', () => 'ran', ops));
  expect(renames.filter((r) => r.includes('.stale.'))).toEqual([]); // judged again under the break lock: live, untouched
  expect(readFileSync(join(lockDir(root), 'owner'), 'utf8')).toContain('other');
}, 10000);

test('a stale dead-owner lock is still broken quickly through the break lock', async () => {
  const root = tmp();
  mkLock(root, { pid: await deadPid(), nonce: 'dead' });
  const t = Date.now();
  expect(await withSessionLock(root, 's', () => 'ok')).toBe('ok');
  expect(Date.now() - t).toBeLessThan(1000);
  expect(existsSync(`${lockDir(root)}.break`)).toBe(false);
});

test('an abandoned break lock older than 5 s does not block breaking', async () => {
  const root = tmp();
  mkLock(root, { pid: await deadPid(), nonce: 'dead' });
  const brk = `${lockDir(root)}.break`;
  mkdirSync(brk);
  const old = new Date(Date.now() - 6000);
  utimesSync(brk, old, old);
  expect(await withSessionLock(root, 's', () => 'ok')).toBe('ok');
  expect(existsSync(lockDir(root))).toBe(false);
});

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

test('the break lock is removed with retries, like the release (a transient Windows EPERM must not block breaking for 5 s)', async () => {
  const root = tmp();
  mkLock(root, { pid: await deadPid(), nonce: 'dead' });
  const calls: { p: string; o?: { maxRetries?: number } }[] = [];
  const ops = { ...realOps, rm: (p: string, o?: object) => (calls.push({ p, o }), rmSync(p, o)) };
  expect(await withSessionLock(root, 's', () => 'ok', ops)).toBe('ok');
  const brk = calls.find((c) => c.p.endsWith('.break'));
  expect(brk?.o?.maxRetries).toBeGreaterThan(0);
});
