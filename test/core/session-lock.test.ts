import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync as renameSyncReal, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { RETRY } from '../../src/core/atomic.js';
import { LOCK_WAIT, readState, withSessionLock, writeState } from '../../src/core/state.js';
import type { Check } from '../../src/hooks/check.js';
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

const shortWait = (ms = 300) => {
  const saved = LOCK_WAIT.ms;
  LOCK_WAIT.ms = ms;
  onTestFinished(() => void (LOCK_WAIT.ms = saved));
};
const captureErr = async <T>(f: () => Promise<T>): Promise<{ v: T; err: string }> => {
  let err = '';
  const orig = process.stderr.write;
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    return { v: await f(), err };
  } finally {
    process.stderr.write = orig;
  }
};

test('a live holder\'s lock is never removed by a waiter, however old', async () => {
  shortWait(); // waits the live lock out
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

test('a fresh held lock times out after the bounded wait, warns, and runs fn (no onTimeout) or onTimeout instead', async () => {
  shortWait();
  const root = tmp();
  mkdirSync(join(root, '.harness/state/s.lock'), { recursive: true });
  const t = Date.now();
  const a = await captureErr(() => withSessionLock(root, 's', () => 'ran'));
  expect(Date.now() - t).toBeGreaterThanOrEqual(250);
  expect(a).toEqual({ v: 'ran', err: 'harness: state lock timeout\n' });
  let ran = false;
  const b = await captureErr(() => withSessionLock(root, 's', () => ((ran = true), 'ran'), undefined, () => 'closed'));
  expect(b.v).toBe('closed');
  expect(ran).toBe(false);
});

test('the default wait is 5 s: bounded (no hangs), and long enough for a burst of hooks under load', () => {
  expect(LOCK_WAIT.ms).toBe(5000);
});

const gated = (root: string, yaml = 'checks:\n  multiFile: true\n') => {
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), yaml);
};
const pre = (root: string, extra: object = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Edit', tool_input: { file_path: 'a.ts' }, ...extra });

test.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor', 'mcp__github__create_issue', 'mcp__x__frobnicate'])('forced lock timeout: %s fails closed (a write, shell or unclassified MCP tool)', async (tool) => {
  shortWait();
  const root = tmp();
  gated(root);
  mkLock(root, { pid: process.pid, nonce: 'live' });
  const out = JSON.parse((await captureErr(() => dispatch(pre(root, { tool_name: tool, tool_input: { command: 'ls', file_path: 'a.ts' } }), [], {}))).v);
  expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
});

test.each(['Read', 'Grep', 'Glob', 'mcp__github__get_issue', 'mcp__notion__search'])('forced lock timeout: read-only %s runs its checks (merged writes)', async (tool) => {
  shortWait();
  const root = tmp();
  mkLock(root, { pid: process.pid, nonce: 'live' });
  let ran = false;
  const spy: Check = { name: 'spy', events: ['PreToolUse'], run: () => ((ran = true), { kind: 'allow' }) };
  const { v, err } = await captureErr(() => dispatch(pre(root, { tool_name: tool, tool_input: { file_path: 'a.ts' } }), [spy], {}));
  expect(err).toContain('state lock timeout');
  expect(v).toBe('');
  expect(ran).toBe(true);
});

test('forced lock timeout: a PreToolUse gate fails closed (ask attended, deny unattended) and never runs its checks', async () => {
  shortWait();
  const root = tmp();
  gated(root);
  mkLock(root, { pid: process.pid, nonce: 'live' });
  let ran = false;
  const spy: Check = { name: 'spy', events: ['PreToolUse'], run: () => ((ran = true), { kind: 'allow' }) };
  const ask = JSON.parse((await captureErr(() => dispatch(pre(root), [spy], {}))).v);
  expect(ask.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' });
  expect(ask.hookSpecificOutput.permissionDecisionReason).toContain('busy');
  const deny = JSON.parse((await captureErr(() => dispatch(pre(root), [spy], { CI: 'true' }))).v);
  expect(deny.hookSpecificOutput.permissionDecision).toBe('deny');
  const bypass = JSON.parse((await captureErr(() => dispatch(pre(root, { permission_mode: 'bypassPermissions' }), [spy], {}))).v);
  expect(bypass.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(ran).toBe(false);
});

test.each([
  ['no state gate on', 'checks:\n  multiFile: false\n'],
  ['TDD paused', 'checks:\n  tdd: true\n'],
])('forced lock timeout: an Edit runs its checks when %s (config read without the lock)', async (_n, yaml) => {
  shortWait();
  const root = tmp();
  gated(root, yaml);
  if (yaml.includes('tdd')) {
    mkdirSync(join(root, '.harness/state'), { recursive: true });
    writeFileSync(join(root, '.harness/state/tdd-pause.json'), JSON.stringify({ createdAt: new Date().toISOString(), session: 's' }));
  }
  mkLock(root, { pid: process.pid, nonce: 'live' });
  let ran = false;
  const spy: Check = { name: 'spy', events: ['PreToolUse'], run: () => ((ran = true), { kind: 'allow' }) };
  expect((await captureErr(() => dispatch(pre(root), [spy], {}))).v).toBe('');
  expect(ran).toBe(true);
});

test('forced lock timeout: an invalid config still fails closed', async () => {
  shortWait();
  const root = tmp();
  gated(root, 'checks: [not, a, map]\n');
  mkLock(root, { pid: process.pid, nonce: 'live' });
  expect(JSON.parse((await captureErr(() => dispatch(pre(root), [], {}))).v).hookSpecificOutput.permissionDecision).toBe('ask');
});

test('the write lock busy past its bound: a write gate fails closed after its checks ran', async () => {
  const { WRITE_WAIT } = await import('../../src/core/state.js');
  const saved = WRITE_WAIT.ms;
  WRITE_WAIT.ms = 50;
  onTestFinished(() => void (WRITE_WAIT.ms = saved));
  const root = tmp();
  gated(root);
  writeState(root, 's', readState(root, 's'));
  const rec: Check = {
    name: 'rec', events: ['PreToolUse'],
    run(ctx) {
      mkdirSync(join(root, '.harness/state/s.wlock'));
      writeFileSync(join(root, '.harness/state/s.wlock/owner'), JSON.stringify({ pid: process.pid, nonce: 'stuck' }));
      ctx.save({ ...ctx.state, files: ['x.ts'] });
      return { kind: 'allow' };
    },
  };
  const out = JSON.parse((await captureErr(() => dispatch(pre(root), [rec], {}))).v);
  expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
  expect(readFileSync(join(root, '.harness/logs/events.jsonl'), 'utf8')).toContain('state-write-lost');
});

test('a stuck session-lock holder and 20 parallel PostToolUse Edits: every file and every red test is kept', async () => {
  const repo = tmp();
  gated(repo, "checks:\n  multiFile: true\n  tdd: true\ntdd:\n  paths: ['**']\n");
  mkLock(repo, { pid: process.pid, nonce: 'stuck' }); // live, never released: every hook times out and runs unlocked
  const run = (file: string) =>
    new Promise<string>((res) => {
      const p = spawn(process.execPath, [join(process.cwd(), 'dist/hooks/dispatch.mjs')], { env: { ...process.env, CI: '' } });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', () => res(err));
      p.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, file) } }));
    });
  const src = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`), tests = Array.from({ length: 10 }, (_, i) => `test/f${i}.test.ts`);
  const errs = await Promise.all([...src, ...tests].map(run));
  expect(errs.filter((e) => e.includes('state lock timeout'))).toHaveLength(20);
  const st = readState(repo, 's');
  expect([...st.files].sort()).toEqual([...src].sort());
  expect([...st.redTests].sort()).toEqual([...tests].sort());
}, 60000);

test('forced lock timeout: a non-gate hook still runs, and its save merges with what another hook wrote meanwhile', async () => {
  shortWait();
  const root = tmp();
  mkLock(root, { pid: process.pid, nonce: 'live' });
  const rec: Check = {
    name: 'rec', events: ['PostToolUse'],
    run(ctx) {
      writeState(root, 's', { ...readState(root, 's'), files: ['other.ts'] }); // another process, after this hook read the state
      ctx.save({ ...ctx.state, files: [...ctx.state.files, 'mine.ts'] });
      return { kind: 'allow' };
    },
  };
  const post = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', cwd: root, tool_name: 'Edit', tool_input: { file_path: 'mine.ts' } });
  const { err } = await captureErr(() => dispatch(post, [rec], {}));
  expect(err).toContain('state lock timeout');
  expect(readState(root, 's').files).toEqual(['other.ts', 'mine.ts']);
});

test('10 parallel dispatcher processes for one session: no lost state updates', async () => {
  const repo = tmp();
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  multiFile: true\n');
  const run = (i: number) =>
    new Promise<string>((res) => {
      const p = spawn(process.execPath, [join(process.cwd(), 'dist/hooks/dispatch.mjs')], { env: { ...process.env, CI: '' } }); // attended: the multi-file note needs it
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => res(out));
      p.stdin.end(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'par', cwd: repo, tool_name: 'Edit', tool_input: { file_path: `f${i}.ts` } }));
    });
  const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => run(i)));
  const noted = outs.filter(Boolean); // only the process that records the first unit says the multi-file note
  expect(noted).toHaveLength(1);
  expect(noted[0]).toContain('This turn has touched');
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
  shortWait(); // waits the live lock out
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
  shortWait(); // waits the live lock out
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
  // Broken, not waited out: the 2 s wait ends with the timeout warning. Asserting that, not wall time, is load-proof.
  let err = '';
  const orig = process.stderr.write;
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    expect(await withSessionLock(root, 's', () => 'ok')).toBe('ok');
  } finally {
    process.stderr.write = orig;
  }
  expect(err).not.toContain('state lock timeout');
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
  const saved = { ...RETRY };
  Object.assign(RETRY, { platform: 'win32', sleep: () => {} }); // the Windows rule, on every OS
  onTestFinished(() => void Object.assign(RETRY, saved));
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
