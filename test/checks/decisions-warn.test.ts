import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { decisionNotes } from '../../src/checks/decisions-stop.js';
import { decisionWarnings } from '../../src/checks/decisions-warn.js';
import { loadConfig } from '../../src/core/config.js';
import { readState, type SessionState } from '../../src/core/state.js';
import type { Ctx } from '../../src/hooks/check.js';
import type { Git } from '../../src/core/decisions-stale.js';
import { decision, installedRepo, syncNow, writeDecision } from '../core/decisions-helpers.js';
import { SAFE_GIT } from '../../src/core/git-safe.js';

const today = new Date().toISOString().slice(0, 10);
// An attended env: CI, HARNESS_UNATTENDED and CLAUDE_CODE_REMOTE are absent (CI sets CI=true).
const mk = (root: string, state: Partial<SessionState> = {}, unattended = false): Ctx => {
  const ctx = {
    input: { session_id: 's', cwd: root, hook_event_name: 'Stop' },
    root, config: loadConfig(root).config, state: { ...readState(root, 's'), ...state }, unattended, env: {},
    save(s: SessionState) { ctx.state = s; },
  } as Ctx;
  return ctx;
};
const fake = (files = ['src/env/a.ts', 'src/other/b.ts']): Git => (args) => {
  const cmd = args[SAFE_GIT.length];
  if (cmd === 'ls-files') return { ok: true, out: files.join('\0') + '\0' };
  if (cmd === 'log') return { ok: true, out: 'abc\n' };
  return { ok: true, out: '' };
};
const fresh = { verified_on: today };
const A = '2026-11-01-a';

async function synced(over = {}) {
  const root = await installedRepo();
  writeDecision(root, decision(A, { ...fresh, ...over }));
  writeDecision(root, decision('2026-11-01-b', { ...fresh, paths: ['src/other/**'] }));
  syncNow(root, today);
  return root;
}

test('lists only decisions linked to changed files, with the verbatim line', async () => {
  const root = await synced();
  const out = decisionWarnings(mk(root), ['src/env/a.ts'], fake());
  expect(out).toEqual([`Harness: you changed code covered by team decision \`${A}\` ("Title ${A}"). If it still holds, ask the person to run \`harness remember confirm ${A}\`; if not, \`harness remember retire ${A}\`.`]);
  expect(decisionWarnings(mk(root), ['README.md'], fake())).toEqual([]);
});

test('each decision is warned once per session; stopAttempts is untouched', async () => {
  const root = await synced();
  const ctx = mk(root, { stopAttempts: 2 });
  expect(decisionWarnings(ctx, ['src/env/a.ts'], fake())).toHaveLength(1);
  expect(ctx.state.decisionsWarned).toEqual([A]);
  expect(ctx.state.stopAttempts).toBe(2);
  expect(decisionWarnings(ctx, ['src/env/a.ts'], fake())).toEqual([]);
});

test('expired and dead-path sentences', async () => {
  const root = await synced({ verified_on: '2020-01-01', paths: ['src/env/**', 'gone/**'] });
  const [line] = decisionWarnings(mk(root), ['src/env/a.ts'], fake());
  expect(line).toContain(' It is expired (last confirmed 2020-01-01).');
  expect(line).toContain(' Its path gone/** no longer matches any file.');
});

test('out-of-sync sentence, once', async () => {
  const root = await synced();
  writeDecision(root, decision('2026-11-02-c', { ...fresh, paths: ['src/env/**'] })); // not synced
  const out = decisionWarnings(mk(root), ['src/env/a.ts'], fake());
  expect(out.filter((l) => l.includes('Rules are out of sync: run harness remember sync.'))).toHaveLength(1);
  expect(out.at(-1)).toBe('Rules are out of sync: run harness remember sync.');
});

test('a git failure gives the honest note, still warns, and never throws', async () => {
  const root = await synced();
  const bad: Git = () => ({ ok: false, out: '', reason: 'timeout' });
  const out = decisionWarnings(mk(root), ['src/env/a.ts'], bad);
  expect(out[0]).toContain(`\`${A}\``);
  expect(out.join('\n')).toContain("couldn't check decision staleness (timeout)");
  const thrower: Git = () => { throw new Error('boom'); };
  expect(() => decisionWarnings(mk(root), ['src/env/a.ts'], thrower)).not.toThrow();
});

test('no decisions folder, and checks off in a bare repo: no warnings', () => {
  expect(decisionWarnings(mk(mkdtempSync(join(tmpdir(), 'h-dwarn-'))), ['src/a.ts'], fake())).toEqual([]);
});

test('decisionNotes carries warnings without marking the nudge shown', async () => {
  const root = await synced();
  const ctx = mk(root);
  const notes = decisionNotes(ctx, ['src/env/a.ts']);
  expect(notes[0]).toContain(A);
  expect(ctx.state.decisionNudged).toBeUndefined();
});

test('at most 10 decisions are named per Stop; the rest wait for the next one', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-dwarn-'));
  for (let i = 0; i < 12; i++) writeDecision(root, decision(`2026-11-01-d${String(i).padStart(2, '0')}`, { verified_on: today, paths: ['src/**'] }));
  const ctx = mk(root);
  expect(decisionWarnings(ctx, ['src/a.ts'], fake(['src/a.ts'])).filter((l) => l.startsWith('Harness: you changed'))).toHaveLength(10);
  expect(decisionWarnings(ctx, ['src/a.ts'], fake(['src/a.ts'])).filter((l) => l.startsWith('Harness: you changed'))).toHaveLength(2);
});
