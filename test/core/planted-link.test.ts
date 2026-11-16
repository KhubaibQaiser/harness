import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';
import { saveDebug } from '../../src/ai/debug.js';
import { ensureRealDir } from '../../src/core/atomic.js';
import { appendEvent } from '../../src/core/events.js';
import { appendTiming } from '../../src/core/timing.js';
import { appendRow } from '../../src/done/ledger.js';

// A folder the agent's Bash can write may hold a planted symlink; harness must never write or delete through it onto a user's file.
const mk = () => realpathSync(mkdtempSync(join(tmpdir(), 'harness-link-')));
const victim = () => { const d = mk(), f = join(d, 'mine.txt'); writeFileSync(f, 'mine'); return { d, f }; };
/** A repo whose `.harness/<sub>` is a link to a user's folder. */
const planted = (sub: string) => { const root = mk(), v = victim(); mkdirSync(join(root, '.harness'), { recursive: true }); symlinkSync(v.d, join(root, '.harness', sub)); return { root, ...v }; };
const intact = (v: { d: string; f: string }) => { expect(readFileSync(v.f, 'utf8')).toBe('mine'); expect(readdirSync(v.d)).toEqual(['mine.txt']); };

test.each(['logs', 'tmp', 'reports', 'reviews', 'vet', 'debug', 'state', 'results'])('ensureRealDir refuses a planted link at .harness/%s', (sub) => {
  const v = planted(sub);
  expect(() => ensureRealDir(v.root, `.harness/${sub}`)).toThrow(/does not write through/);
  intact(v);
});

test('logs: the event log is never written through a linked folder or a linked file', () => {
  const v = planted('logs');
  expect(() => appendEvent(v.root, { ts: 't', session: 's', check: 'c', decision: 'd' } as never)).toThrow();
  intact(v);
  const r = mk(), w = victim();
  mkdirSync(join(r, '.harness/logs'), { recursive: true });
  symlinkSync(w.f, join(r, '.harness/logs/events.jsonl'));
  expect(() => appendEvent(r, { ts: 't', session: 's', check: 'c', decision: 'd' } as never)).toThrow();
  expect(readFileSync(w.f, 'utf8')).toBe('mine');
});

test('logs: the timing log is never written through a linked folder or file', () => {
  const v = planted('logs');
  appendTiming(v.root, { ts: 't', session: 's', event: 'e', outcome: 'o', ms: 1 } as never);
  intact(v);
  const r = mk(), w = victim();
  mkdirSync(join(r, '.harness/logs'), { recursive: true });
  symlinkSync(w.f, join(r, '.harness/logs/timing.jsonl'));
  appendTiming(r, { ts: 't', session: 's', event: 'e', outcome: 'o', ms: 1 } as never);
  expect(readFileSync(w.f, 'utf8')).toBe('mine');
});

test('debug: a saved output is never written through a linked folder', () => {
  const v = planted('debug');
  expect(() => saveDebug(v.root, 'picks', 'x')).toThrow();
  intact(v);
});

test('state: the evidence ledger is never appended through a linked folder or file', () => {
  const v = planted('state');
  expect(() => appendRow(v.root, { kind: 'blocked' } as never)).toThrow();
  intact(v);
  const r = mk(), w = victim();
  mkdirSync(join(r, '.harness/state'), { recursive: true });
  symlinkSync(w.f, join(r, '.harness/state/evidence.jsonl'));
  expect(() => appendRow(r, { kind: 'blocked' } as never)).toThrow();
  expect(readFileSync(w.f, 'utf8')).toBe('mine');
});

test('tmp: workdir never writes through a planted .gitignore link', () => {
  const r = mk(), w = victim();
  mkdirSync(join(r, '.harness/tmp'), { recursive: true });
  symlinkSync(w.f, join(r, '.harness/tmp/.gitignore'));
  const lines: string[] = [];
  run(['workdir'], { root: r, env: {}, out: (l) => lines.push(l) });
  expect(readFileSync(w.f, 'utf8')).toBe('mine');
});


test('ensureRealDir makes a missing folder, and is fine when it already exists', () => {
  const r = mk();
  ensureRealDir(r, '.harness/logs');
  expect(() => ensureRealDir(r, '.harness/logs')).not.toThrow();
});

test('appendEventSafe reports a planted link on stderr instead of throwing', async () => {
  const { appendEventSafe } = await import('../../src/core/events.js');
  const v = planted('logs');
  expect(() => appendEventSafe(v.root, { ts: 't', session: 's', check: 'c', decision: 'd' } as never)).not.toThrow();
  intact(v);
});
