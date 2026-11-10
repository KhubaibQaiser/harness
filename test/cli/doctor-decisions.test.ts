import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { decisionChecks, decisionsStatusLine } from '../../src/cli/doctor-decisions.js';
import { contextDirs } from '../../src/cli/doctor-context.js';
import { contextSet } from '../../src/budget/summary.js';
import { defaults, loadConfig } from '../../src/core/config.js';
import type { Git } from '../../src/core/decisions-stale.js';
import { TODAY, decision, installedRepo, syncNow, writeDecision } from '../core/decisions-helpers.js';

const cfg = defaults();
const g = (r: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: r, encoding: 'utf8' }).trim();
const put = (r: string, rel: string, t = 'x') => { mkdirSync(join(r, rel, '..'), { recursive: true }); writeFileSync(join(r, rel), t); };
const commit = (r: string) => { g(r, 'add', '-A'); g(r, 'commit', '-q', '-m', 'c'); return g(r, 'rev-parse', 'HEAD'); };
const run = (root: string, o: { git?: Git } = {}) => {
  const lines: string[] = []; let bad = 0;
  decisionChecks(root, cfg, {
    ok: (s) => lines.push(`ok ${s}`),
    fix: (w, n) => (bad++, lines.push(`fix ${w}: ${n}`)),
    note: (w, n) => lines.push(`note ${w}${n === undefined ? '' : `: ${n}`}`),
  }, { today: TODAY, ...o });
  return { lines, bad };
};

test('no decisions: ok line, status none', async () => {
  const r = await installedRepo();
  expect(run(r).lines).toEqual(['ok no team decisions yet']);
  expect(decisionsStatusLine(r, cfg, { today: TODAY })).toBe('Decisions: none');
});

test('summary, in sync, and the status line', async () => {
  const r = await installedRepo(); put(r, 'src/env/a.ts'); const sha = commit(r);
  writeDecision(r, decision('2026-11-03-a', { verified_at: sha })); syncNow(r); commit(r);
  expect(run(r)).toEqual({ lines: ['ok decisions: 1 active, rules in sync'], bad: 0 });
  expect(decisionsStatusLine(r, cfg, { today: TODAY })).toBe('Decisions: 1 active (0 stale, 0 expired), rules in sync');
});

test('invalid file and out of sync are fix rows', async () => {
  const r = await installedRepo(); put(r, 'src/env/a.ts'); const sha = commit(r);
  writeDecision(r, decision('2026-11-03-a', { verified_at: sha }));
  put(r, 'docs/decisions/2026-11-03-bad.md', '---\nschema: harness-decision/1\nid: 2026-11-03-bad\n---\n');
  const { lines, bad } = run(r);
  expect(lines.some((l) => /^fix docs\/decisions\/2026-11-03-bad\.md: .*: correct it by hand, then run harness remember sync$/.test(l))).toBe(true);
  expect(lines).toContain('fix decision rules are out of sync with docs/decisions/: run harness remember sync');
  expect(bad).toBeGreaterThan(1);
  expect(decisionsStatusLine(r, cfg, { today: TODAY })).toMatch(/^Decisions: 1 active .*rules out of sync$/);
});

test('foreign rule file is a fix row', async () => {
  const r = await installedRepo();
  put(r, '.claude/rules/harness-decision-mine.md', 'mine\n');
  expect(run(r).lines).toContain("fix .claude/rules/harness-decision-mine.md is named like a harness decision rule but isn't harness's: rename it");
});

test('dead, changed, expired, oversized and fallback ref are notes', async () => {
  const r = await installedRepo(); put(r, 'src/env/a.ts'); const sha = commit(r);
  writeDecision(r, decision('2026-11-03-dead', { verified_at: sha, paths: ['nope/**'] }));
  writeDecision(r, decision('2026-11-03-chg', { verified_at: sha }));
  writeDecision(r, decision('2026-01-01-old', { verified_at: sha, verified_on: '2026-01-01' }));
  writeDecision(r, decision('2026-11-03-big', { verified_at: sha, body: '**Rule:** ' + Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n\n') }));
  writeDecision(r, decision('2026-11-03-gone', { verified_at: 'b'.repeat(40) }));
  commit(r); put(r, 'src/env/a.ts', 'y'); commit(r);
  syncNow(r); commit(r);
  const { lines, bad } = run(r);
  expect(bad).toBe(0);
  expect(lines).toContain('note decision 2026-11-03-dead is stale: nope/** matches no tracked file: fix its paths by hand, or run harness remember retire 2026-11-03-dead');
  expect(lines.some((l) => l.startsWith(`note decision 2026-11-03-chg is stale: 1 linked file changed since ${g(r, "log", "-1", "--format=%h", "--", "docs/decisions/2026-11-03-chg.md").slice(0, 7)} (src/env/a.ts): check it still holds, then run harness remember confirm 2026-11-03-chg`))).toBe(true);
  expect(lines).toContain('note decision 2026-01-01-old expired: last confirmed 2026-01-01, over 90 days ago, so its rule no longer loads after the next sync: run harness remember confirm 2026-01-01-old or harness remember retire 2026-01-01-old');
  expect(lines.some((l) => /^note decision 2026-11-03-big is oversized: its rule is \d+ lines, cap 20, so it is cut: shorten it by hand, then run harness remember sync$/.test(l))).toBe(true);
  expect(lines).toContain("note decision 2026-11-03-gone: verified_at bbbbbbb is not in this clone; compared from the decision file's last commit");
  expect(decisionsStatusLine(r, cfg, { today: TODAY })).toMatch(/^Decisions: 5 active \(\d stale, 1 expired\), rules (in|out of) sync$/);
});

test('a git timeout gives the staleness note and does not throw', async () => {
  const r = await installedRepo(); writeDecision(r, decision('2026-11-03-a')); syncNow(r);
  const git: Git = () => ({ ok: false, out: '', reason: 'timeout' });
  expect(run(r, { git }).lines).toContain("note couldn't check decision staleness (timeout)");
  expect(decisionsStatusLine(r, cfg, { today: TODAY, git })).toBe('Decisions: 1 active (0 stale, 0 expired), rules in sync');
});

test('the Context: total does not move when a decision is added (drift 9)', async () => {
  const r = await installedRepo(); put(r, 'src/env/a.ts'); const sha = commit(r);
  const total = () => contextSet(r, loadConfig(r).config, contextDirs()).total;
  const before = total();
  writeDecision(r, decision('2026-11-03-a', { verified_at: sha })); syncNow(r);
  expect(total()).toBe(before);
});
