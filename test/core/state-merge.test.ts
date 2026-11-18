import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { expect, onTestFinished, test } from 'vitest';
import { type SessionState, mergeState, readState, StateBusyError, updateState, WRITE_WAIT, writeMerged, writeState } from '../../src/core/state.js';

const s = (o: Partial<SessionState> = {}): SessionState => ({ startedAt: 1, files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0, ...o });
const merge = (k: keyof SessionState, base: unknown, next: unknown, cur: unknown) =>
  (mergeState(s({ [k]: base }), s({ [k]: next }), s({ [k]: cur })) as unknown as Record<string, unknown>)[k];

// Every field is classified: a new SessionState field fails tsc here until its merge rule is chosen and tested.
const KINDS = {
  files: 'list', reasonDenied: 'list', redTests: 'list', lockedTests: 'list', stopToolMissing: 'list', decisionsWarned: 'list',
  lateReasons: 'objList', decisionHits: 'objList',
  stopAttempts: 'counter', doneClaimAttempts: 'counter', startedAt: 'counter',
  harnessFiles: 'record', guardedBase: 'record', guardedApplied: 'record',
  guardedOwned: 'whole',
  approved: 'flag', askNoted: 'flag', stopNoGitLogged: 'flag', stopUnwrappedLogged: 'flag', stopOffRefusedLogged: 'flag',
  stopNothingLogged: 'flag', sandboxUnavailableLogged: 'flag', decisionNudged: 'flag', rememberAdded: 'flag',
  sandboxBase: 'text', baseHead: 'text', harnessHead: 'text', harnessNoticed: 'text', guardedCli: 'text', pendingNotice: 'text',
} as const satisfies Record<keyof SessionState, string>;

const of = (kind: string) => Object.entries(KINDS).filter(([, v]) => v === kind).map(([k]) => k as keyof SessionState);

test.each(of('list'))('%s: set-union of both sides\' additions; the hook\'s removals stay removed', (k) => {
  expect(merge(k, ['a'], ['a', 'b'], ['a', 'c'])).toEqual(['a', 'c', 'b']); // both additions kept
  expect(merge(k, ['a', 'b'], [], ['a', 'b', 'c'])).toEqual(['c']); // a clear keeps what another hook added since
  expect(merge(k, ['a'], ['a'], ['a', 'c'])).toEqual(['a', 'c']); // untouched here: disk wins
  expect(merge(k, undefined, ['b'], undefined)).toEqual(['b']);
  expect(merge(k, ['a'], ['a', 'b'], ['a', 'b'])).toEqual(['a', 'b']); // no duplicates
});

test.each(of('objList'))('%s: entries compared by value, unioned like a list', (k) => {
  const [A, B, C] = [{ ts: '1', rel: 'a' }, { ts: '2', rel: 'b' }, { ts: '3', rel: 'c' }];
  expect(merge(k, [A], [A, B], [A, C])).toEqual([A, C, B]);
  expect(merge(k, [A], [], [{ ...A }, C])).toEqual([C]);
});

test.each(of('counter'))('%s: a raise takes the larger value, a reset stays a reset', (k) => {
  expect(merge(k, 1, 2, 5)).toBe(5);
  expect(merge(k, 1, 4, 2)).toBe(4);
  expect(merge(k, 3, 0, 5)).toBe(0);
  expect(merge(k, 2, 2, 7)).toBe(7); // untouched here: disk wins
  expect(merge(k, 2, 3, 0)).toBe(1); // another hook reset it meanwhile: the reset holds, plus this hook's raise
  expect(merge(k, undefined, 1, 0)).toBe(1);
});

test.each(of('record'))('%s: merged per key; a key the hook removed stays removed', (k) => {
  expect(merge(k, { a: '1' }, { a: '1', b: '2' }, { a: '1', c: '3' })).toEqual({ a: '1', c: '3', b: '2' });
  expect(merge(k, { a: '1', b: '2' }, { b: '9' }, { a: '1', b: '2', c: '3' })).toEqual({ b: '9', c: '3' });
  expect(merge(k, undefined, { a: '1' }, { c: '3' })).toEqual({ c: '3', a: '1' });
  expect(merge(k, { a: '1' }, undefined, { a: '1', c: '3' })).toEqual({ c: '3' }); // removed whole: other hooks' keys stay
  expect(merge(k, { a: '1' }, undefined, { a: '1' })).toBeUndefined();
});

test('guardedOwned: a snapshot, taken whole from the hook that set it', () => {
  expect(merge('guardedOwned', null, [{ x: 1 }], [{ y: 2 }])).toEqual([{ x: 1 }]);
  expect(merge('guardedOwned', [{ x: 1 }], [{ x: 1 }], null)).toBe(null);
});

test.each([...of('flag'), ...of('text')])('%s: the hook\'s change wins; untouched, disk wins', (k) => {
  const [v1, v2] = KINDS[k] === 'flag' ? [undefined, true] : ['old', 'new'];
  expect(merge(k, v1, v2, v1)).toBe(v2);
  expect(merge(k, v2, v1, v2)).toBe(v1); // cleared here (undefined drops out of the JSON)
  expect(merge(k, v1, v1, v2)).toBe(v2);
});

test('writeMerged re-reads the file right before writing, so another hook\'s update is never lost', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-merge-'));
  const base = s({ files: ['a.ts'], stopAttempts: 1 });
  writeState(root, 's', s({ files: ['a.ts', 'other.ts'], stopAttempts: 1, decisionNudged: true })); // written after our read
  const out = writeMerged(root, 's', base, { ...base, files: ['a.ts', 'mine.ts'], stopAttempts: 2 });
  expect(readState(root, 's')).toEqual(out);
  expect(out).toMatchObject({ files: ['a.ts', 'other.ts', 'mine.ts'], stopAttempts: 2, decisionNudged: true });
});

test('decisionHits: the cap of 3 holds after a merge, keeping the first 3 in order (disk first, then this hook)', () => {
  const h = (n: number) => ({ pattern: `P${n}`, excerpt: `e${n}` });
  expect(merge('decisionHits', [h(1)], [h(1), h(2), h(3)], [h(1), h(4)])).toEqual([h(1), h(4), h(2)]);
  expect(merge('files', ['a'], ['a', 'b', 'c'], ['a', 'd', 'e'])).toHaveLength(5); // other lists have no cap
});

test('the write lock: a live holder makes a write fail after WRITE_WAIT, logged, never silently; a dead holder is broken', async () => {
  const saved = WRITE_WAIT.ms;
  WRITE_WAIT.ms = 100;
  onTestFinished(() => void (WRITE_WAIT.ms = saved));
  const root = mkdtempSync(join(tmpdir(), 'h-wlock-'));
  const wlock = join(root, '.harness/state/s.wlock');
  mkdirSync(wlock, { recursive: true });
  writeFileSync(join(wlock, 'owner'), JSON.stringify({ pid: process.pid, nonce: 'live' }));
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = ((x: string) => ((err += x), true)) as typeof process.stderr.write;
  try {
    expect(() => updateState(root, 's', (c) => c)).toThrow(StateBusyError);
  } finally {
    process.stderr.write = orig;
  }
  expect(err).toContain('state write lock timeout');
  expect(readFileSync(join(root, '.harness/logs/events.jsonl'), 'utf8')).toContain('"decision":"state-write-lost"');
  const dead = await new Promise<number>((r) => { const c = spawn(process.execPath, ['-e', '']); c.on('close', () => r(c.pid as number)); });
  writeFileSync(join(wlock, 'owner'), JSON.stringify({ pid: dead, nonce: 'dead' }));
  expect(updateState(root, 's', (c) => ({ ...c, files: ['ok.ts'] })).files).toEqual(['ok.ts']);
  expect(existsSync(wlock)).toBe(false);
});

test('10 processes x 50 merged writes with no session lock: every entry survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-wrace-'));
  const entry = join(dir, 'child.ts');
  writeFileSync(entry, `import { readState, writeMerged } from ${JSON.stringify(join(process.cwd(), 'src/core/state.ts'))};
const [root, id, m] = process.argv.slice(2);
for (let j = 0; j < Number(m); j++) {
  const base = readState(root, 's');
  writeMerged(root, 's', base, { ...base, files: [...base.files, id + '-' + j] });
}
`);
  buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'child.mjs'), logLevel: 'silent' });
  const root = join(dir, 'repo');
  const codes = await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise<number | null>((r) => spawn(process.execPath, [join(dir, 'child.mjs'), root, String(i), '50']).on('close', r))));
  expect(codes).toEqual(Array(10).fill(0));
  expect(new Set(readState(root, 's').files).size).toBe(500);
}, 60000);
