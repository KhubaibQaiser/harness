import { describe, expect, test } from 'vitest';
import type { Owner } from '../../src/budget/owners.js';
import { preloadedSkills, recommend } from '../../src/budget/recommend.js';
import type { SourceEntry } from '../../src/budget/sources.js';
import { ownerTotals, type ContextSet } from '../../src/budget/summary.js';
import { makeRepo } from '../install/helpers.js';

const row = (path: string, tokens: number, owner: Owner, o: Partial<SourceEntry> = {}): SourceEntry =>
  ({ id: path, path, label: path, owner, load: 'always', tokens, chars: tokens * 4, text: 'x'.repeat(tokens * 4), ...o });
const skill = (name: string, tokens: number, owner: Owner, o: Partial<SourceEntry> = {}): SourceEntry =>
  row(`.claude/skills/${name}/SKILL.md`, tokens, owner, { label: `skill ${name}`, skill: { description: 10, body: 'steps\n' }, ...o });
const set = (always: SourceEntry[], budget = 1000): ContextSet =>
  ({ always, onDemand: [], unmeasured: [], notes: [], ...ownerTotals(always), budget, method: 'estimate', model: null });
const lines = (n: number) => 'line\n'.repeat(n);
const kinds = (s: ContextSet, pre = new Set<string>()) => recommend(s, pre).map((r) => [r.kind, r.target]);

describe('name-only', () => {
  test('targets harness, preset and catalog skills, largest first, while over 80% of the budget', () => {
    const s = set([skill('small', 100, 'catalog:c'), skill('big', 500, 'harness'), skill('mid', 300, 'preset:p'), skill('mine', 700, 'repo')], 2000);
    // total 1,600 is exactly 80% of 2,000: nothing
    expect(kinds(s).filter(([k]) => k === 'name-only')).toEqual([]);
    const over = set([...s.always, row('CLAUDE.md', 1, 'repo')], 2000); // 1601: one name-only brings it under
    const recs = recommend(over, new Set());
    expect(recs[0]).toMatchObject({ n: 1, kind: 'name-only', owner: 'harness', target: 'big', saves: 497, apply: true });
    expect(recs[0].line).toBe('Show skill big by name only (saves ~497). Apply: harness context apply 1');
    expect(recs.filter((r) => r.kind === 'name-only').map((r) => r.target)).toEqual(['big']);
  });
  test('keeps going while the total stays over the line', () => {
    const s = set([skill('a', 500, 'harness'), skill('b', 400, 'preset:p'), skill('c', 300, 'catalog:c')], 600); // 1,200 → 702 → 304, under 480
    expect(kinds(s).filter(([k]) => k === 'name-only')).toEqual([['name-only', 'a'], ['name-only', 'b']]);
  });
  test('never a repo skill, a skill already shown by name, or a preloaded one', () => {
    const s = set([skill('mine', 900, 'repo'), skill('done', 900, 'harness', { text: 'name: done', tokens: 3 }), skill('review-rubric', 900, 'harness')], 100);
    expect(kinds(s, new Set(['review-rubric'])).filter(([k]) => k === 'name-only')).toEqual([]);
  });
  test('review-rubric is never name-only while staff-reviewer preloads it', () => {
    const root = makeRepo({ '.claude/agents/staff-reviewer.md': '---\nname: staff-reviewer\ndescription: d\nskills:\n  - review-rubric\n---\nbody\n' });
    const pre = preloadedSkills(root);
    expect([...pre]).toEqual(['review-rubric']);
    const s = set([skill('review-rubric', 900, 'harness'), skill('pr-ship', 50, 'harness')], 100);
    expect(kinds(s, pre).filter(([k]) => k === 'name-only')).toEqual([['name-only', 'pr-ship']]);
  });
});

test('remove targets a catalog plugin pick, with the settings.local.json hint', () => {
  const s = set([row('catalog:seo', 60, 'catalog:seo', { id: 'seo', label: 'seo', text: undefined, chars: 0 })], 2000);
  const [r] = recommend(s, new Set());
  expect(r).toMatchObject({ n: 1, kind: 'remove', owner: 'catalog:seo', target: 'seo', saves: 60, apply: true });
  expect(r.line).toBe('Remove plugin seo (saves ~60). Apply: harness context apply 1. To turn it off for yourself only, disable it in .claude/settings.local.json.');
});

test('long-file: a repo CLAUDE.md or AGENTS.md over 200 lines, its imports included', () => {
  expect(kinds(set([row('CLAUDE.md', 1, 'repo', { text: lines(200) })], 1e6))).toEqual([]);
  const recs = recommend(set([row('CLAUDE.md', 1, 'repo', { text: lines(150) }), row('AGENTS.md', 1, 'repo', { label: 'AGENTS.md (imported by CLAUDE.md)', text: lines(51) })], 1e6), new Set());
  expect(recs.map((r) => [r.kind, r.target])).toEqual([['long-file', 'CLAUDE.md']]);
  expect(recs[0]).toMatchObject({ owner: 'repo', saves: null, apply: false });
  expect(recs[0].line).toBe('CLAUDE.md is 201 lines; move the parts that only matter for some folders into path-scoped rules. /harness:context-optimize proposes the diff.');
});

test('scope-rule: a repo rule with no paths, not one harness owns or a memory file imports', () => {
  const s = set([row('.claude/rules/style.md', 5, 'repo'), row('.claude/rules/h.md', 5, 'harness'), row('.claude/rules/i.md', 5, 'repo', { label: '.claude/rules/i.md (imported by CLAUDE.md)' })], 1e6);
  const recs = recommend(s, new Set());
  expect(recs.map((r) => [r.kind, r.target])).toEqual([['scope-rule', '.claude/rules/style.md']]);
  expect(recs[0].line).toMatch(/ \/harness:context-optimize proposes the diff\.$/);
});

test('move-to-skill: a repo always-loaded source over 25% of the budget', () => {
  expect(kinds(set([row('notes.md', 250, 'repo', { label: 'notes.md (imported by CLAUDE.md)' })], 1000))).toEqual([]);
  const recs = recommend(set([row('notes.md', 251, 'repo', { label: 'notes.md (imported by CLAUDE.md)' })], 1000), new Set());
  expect(recs.map((r) => [r.kind, r.target])).toEqual([['move-to-skill', 'notes.md']]);
  expect(recs[0].line).toMatch(/ \/harness:context-optimize proposes the diff\.$/);
});

test('long-description: a repo skill description over 1,536 characters', () => {
  expect(kinds(set([skill('ok', 5, 'repo', { skill: { description: 1536, body: '' } })], 1e6))).toEqual([]);
  expect(kinds(set([skill('h', 5, 'harness', { skill: { description: 1537, body: '' } })], 1e6))).toEqual([]);
  const recs = recommend(set([skill('long', 5, 'repo', { skill: { description: 1537, body: '' } })], 1e6), new Set());
  expect(recs.map((r) => [r.kind, r.target])).toEqual([['long-description', 'long']]);
  expect(recs[0].line).toMatch(/ \/harness:context-optimize proposes the diff\.$/);
});

test('user-only: a repo skill whose body pushes, opens a PR, publishes or deploys', () => {
  expect(kinds(set([skill('a', 5, 'repo', { skill: { description: 1, body: 'it git pushed once' } })], 1e6))).toEqual([]);
  expect(kinds(set([skill('off', 0, 'repo', { text: '', skill: { description: 1, body: 'git push' } })], 1e6))).toEqual([]);
  expect(kinds(set([skill('h', 5, 'harness', { skill: { description: 1, body: 'git push' } })], 1e6))).toEqual([]);
  for (const cmd of ['git push origin', 'gh pr create --fill', 'npm publish', 'pnpm publish', 'yarn publish', 'deploy to prod']) {
    const recs = recommend(set([skill('ship', 5, 'repo', { skill: { description: 1, body: `run ${cmd}\n` } })], 1e6), new Set());
    expect(recs.map((r) => [r.kind, r.target]), cmd).toEqual([['user-only', 'ship']]);
    expect(recs[0].line).toMatch(/ \/harness:context-optimize proposes the diff\.$/);
  }
});

test('name-only and remove first by saving, then the user-file kinds in table order; numbers are stable', () => {
  const s = set([
    skill('ship', 5, 'repo', { skill: { description: 1600, body: 'git push' } }),
    row('CLAUDE.md', 400, 'repo', { text: lines(300) }),
    row('.claude/rules/style.md', 5, 'repo'),
    skill('big', 300, 'harness'),
    row('catalog:seo', 400, 'catalog:seo', { id: 'seo', label: 'seo', text: undefined, chars: 0 }),
  ], 1000);
  const a = recommend(s, new Set());
  expect(a.map((r) => [r.n, r.kind, r.target])).toEqual([
    [1, 'remove', 'seo'], [2, 'name-only', 'big'], [3, 'long-file', 'CLAUDE.md'], [4, 'scope-rule', '.claude/rules/style.md'],
    [5, 'move-to-skill', 'CLAUDE.md'], [6, 'long-description', 'ship'], [7, 'user-only', 'ship'],
  ]);
  expect(recommend(s, new Set())).toEqual(a);
});

test('measureRepo keeps a skill row\'s full description length and body for the recommendations', async () => {
  const { measureRepo } = await import('../../src/budget/sources.js');
  const desc = 'd'.repeat(1600);
  const root = makeRepo({ '.claude/skills/ship/SKILL.md': `---\nname: ship\ndescription: ${desc}\nwhen_to_use: now\n---\nrun git push\n` });
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(r.always.find((e) => e.label === 'skill ship')?.skill).toEqual({ description: 1604, body: 'run git push\n' });
});
