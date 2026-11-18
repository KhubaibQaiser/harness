import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type SessionState, mergeState, readState, writeMerged, writeState } from '../../src/core/state.js';

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
});

test.each(of('record'))('%s: merged per key; a key the hook removed stays removed', (k) => {
  expect(merge(k, { a: '1' }, { a: '1', b: '2' }, { a: '1', c: '3' })).toEqual({ a: '1', c: '3', b: '2' });
  expect(merge(k, { a: '1', b: '2' }, { b: '9' }, { a: '1', b: '2', c: '3' })).toEqual({ b: '9', c: '3' });
  expect(merge(k, undefined, { a: '1' }, { c: '3' })).toEqual({ c: '3', a: '1' });
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
