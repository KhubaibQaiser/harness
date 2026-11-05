import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionCtx } from '../../src/report/acc.js';
import { installedSkills, skillSpecs, skillsAcc } from '../../src/report/metrics/skills.js';
import { parseRecords, type TRec } from '../../src/report/transcript.js';
import { assistant, attachment } from '../fixtures/transcripts/make.js';

const R = '/repo';
const recs = (...rs: object[]): TRec[] => rs.flatMap((r) => parseRecords(JSON.stringify({ timestamp: '2026-11-01T00:00:00.000Z', ...r })));
const skillUse = (name: string, id = 't1') => assistant({ content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }] });
const listing = (...names: string[]) => attachment('skill_listing', { names });
const specs = (installed: { name: string; paths?: string[] }[], packages: { dir: string; frameworks: string[] }[] = [], selected: { id: string; frameworks: string[] }[] = []) => skillSpecs(R, installed, packages, selected);
interface Sess { rs: TRec[]; edited: string[]; turns?: number; compactions?: number }
const run = (sp: ReturnType<typeof skillSpecs>, ...sessions: Sess[]) => {
  const a = skillsAcc(sp);
  sessions.forEach((x, i) => {
    const s: SessionCtx = { id: `s${i}`, turns: x.turns ?? 1, compactions: x.compactions ?? 0, edited: x.edited };
    x.rs.forEach((r) => a.rec!(s, r));
    a.endSession!(s);
  });
  return Object.fromEntries(a.result().map((r) => [r.name, r]));
};

describe('relevance', () => {
  it('paths globs: src/a.tsx yes, src/a.ts no', () => {
    const r = run(specs([{ name: 'ui', paths: ['src/**/*.tsx'] }]), { rs: [], edited: [`${R}/src/a.tsx`] }, { rs: [], edited: [`${R}/src/a.ts`] });
    expect(r.ui).toMatchObject({ label: 'paths', relevantIn: 1, sessions: 2 });
  });
  it('engineering-principles ignores test-only edits', () => {
    const r = run(specs([{ name: 'engineering-principles' }]), { rs: [], edited: [`${R}/src/x.ts`] }, { rs: [], edited: [`${R}/src/x.test.ts`] }, { rs: [], edited: [`${R}/README.md`] });
    expect(r['engineering-principles']).toMatchObject({ label: 'proxy', relevantIn: 1 });
  });
  it('frontend-react needs a tsx or jsx edit', () => {
    const r = run(specs([{ name: 'frontend-react' }]), { rs: [], edited: [`${R}/a.jsx`] }, { rs: [], edited: [`${R}/a.ts`] });
    expect(r['frontend-react']!.relevantIn).toBe(1);
  });
  it('frontend-nextjs only under app/ or pages/ of a next package', () => {
    const pk = [{ dir: 'web', frameworks: ['next'] }, { dir: 'lib', frameworks: [] }];
    const r = run(specs([{ name: 'frontend-nextjs' }], pk), ...['web/app/p.ts', 'web/src/pages/p.ts', 'web/src/util.ts', 'lib/app/p.ts', 'app/p.ts'].map((f) => ({ rs: [], edited: [`${R}/${f}`] })));
    expect(r['frontend-nextjs']!.relevantIn).toBe(2);
  });
  it('frontend-react-native matches react-native or expo packages', () => {
    const pk = [{ dir: 'm', frameworks: ['expo'] }];
    const r = run(specs([{ name: 'frontend-react-native' }], pk), { rs: [], edited: [`${R}/m/a.ts`] }, { rs: [], edited: [`${R}/x/a.ts`] });
    expect(r['frontend-react-native']!.relevantIn).toBe(1);
  });
  it('plugin skills get the stack label only for a selected id with frameworks; others have no relevance', () => {
    const sp = specs([{ name: 'p:s' }, { name: 'q:s' }, { name: 'review-rubric' }], [{ dir: '', frameworks: ['react'] }], [{ id: 'p', frameworks: ['react'] }, { id: 'q', frameworks: [] }]);
    expect(sp.map((s) => s.label)).toEqual(['stack', 'none', 'none']);
    const r = run(sp, { rs: [], edited: [`${R}/a.ts`] });
    expect(r['p:s']!.relevantIn).toBe(1);
    expect(r['review-rubric']!.relevantIn).toBe(0);
  });
});

describe('skillsAcc', () => {
  const sp = () => specs([{ name: 'engineering-principles' }]);
  const edit = [`${R}/src/x.ts`];
  it('a skill missing from a session listing is dropped; no listing is unknown', () => {
    expect(run(sp(), { rs: recs(listing('other')), edited: [] })['engineering-principles']).toMatchObject({ dropped: true, listedIn: 0 });
    expect(run(sp(), { rs: [], edited: [] })['engineering-principles']).toMatchObject({ dropped: false, listedIn: 0 });
    expect(run(sp(), { rs: recs(listing('engineering-principles')), edited: [] })['engineering-principles']).toMatchObject({ dropped: false, listedIn: 1 });
  });
  it('Skill tool use in a relevant session is invokedRelevant, elsewhere invokedOther', () => {
    const r = run(sp(), { rs: recs(skillUse('engineering-principles')), edited: edit }, { rs: recs(skillUse('engineering-principles')), edited: [] })['engineering-principles']!;
    expect(r).toMatchObject({ relevantIn: 1, invokedRelevant: 1, invokedOther: 1, typedOrCarried: 0 });
  });
  it('an invoked attachment alone is typedOrCarried, not invokedRelevant', () => {
    const r = run(sp(), { rs: recs(attachment('invoked_skills', { skills: [{ name: 'engineering-principles' }] })), edited: edit })['engineering-principles']!;
    expect(r).toMatchObject({ relevantIn: 1, invokedRelevant: 0, typedOrCarried: 1 });
  });
  it('a malformed tool use is unknown, never a fire', () => {
    const bad = assistant({ content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'engineering-principles' } }] });
    const r = run(sp(), { rs: recs(bad), edited: edit })['engineering-principles']!;
    expect(r).toMatchObject({ relevantIn: 1, invokedRelevant: 0, unknown: 1 });
  });
  it('zero relevant sessions gives relevantIn 0', () => {
    expect(run(sp(), { rs: recs(skillUse('engineering-principles')), edited: [] })['engineering-principles']).toMatchObject({ relevantIn: 0, invokedOther: 1 });
  });
  it('splits by turn bucket and by compaction', () => {
    const c = recs({ type: 'system', subtype: 'compact_boundary' });
    const r = run(sp(),
      { rs: recs(skillUse('engineering-principles')), edited: edit, turns: 5 },
      { rs: [...recs(skillUse('engineering-principles', 'a')), ...c], edited: edit, turns: 50, compactions: 1 },
      { rs: [...c, ...recs(skillUse('engineering-principles', 'b'))], edited: edit, turns: 200, compactions: 1 },
      { rs: c, edited: edit, turns: 20, compactions: 1 })['engineering-principles']!;
    expect(r.byBucket).toEqual({ '1-10': { r: 1, i: 1 }, '11-30': { r: 1, i: 0 }, '31-100': { r: 1, i: 1 }, '100+': { r: 1, i: 1 } });
    expect(r.byCompact).toEqual({ pre: { r: 4, i: 2 }, post: { r: 3, i: 1 } });
  });
});

describe('installedSkills', () => {
  it('reads name and paths from SKILL.md frontmatter', () => {
    const d = mkdtempSync(join(tmpdir(), 'sk-'));
    try {
      for (const [dir, body] of [['a', '---\nname: alpha\npaths:\n  - "src/**/*.ts"\n---\nbody'], ['b', '---\ndescription: x\npaths: "a/*.md, b/*.md"\n---\n'], ['c', 'no frontmatter']] as const) {
        mkdirSync(join(d, '.claude/skills', dir), { recursive: true });
        writeFileSync(join(d, '.claude/skills', dir, 'SKILL.md'), body);
      }
      expect(installedSkills(d).sort((x, y) => x.name.localeCompare(y.name))).toEqual([{ name: 'alpha', paths: ['src/**/*.ts'] }, { name: 'b', paths: ['a/*.md', 'b/*.md'] }, { name: 'c' }]);
      expect(installedSkills(join(d, 'none'))).toEqual([]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
