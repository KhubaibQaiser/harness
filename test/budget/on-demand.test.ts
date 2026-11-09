import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Owner } from '../../src/budget/owners.js';
import { realIO, type RepoIO } from '../../src/budget/imports.js';
import { onDemand, unmeasuredSources } from '../../src/budget/on-demand.js';
import { measureRepo } from '../../src/budget/sources.js';
import { estimateTokens } from '../../src/budget/measure.js';
import { makeRepo } from '../install/helpers.js';

const run = (files: Record<string, string>, io: RepoIO = realIO, owners = new Map<string, Owner>(), skip: (rel: string) => boolean = () => false) => {
  const root = makeRepo(files, { git: false });
  return onDemand(root, io, owners, skip);
};
const SKILL_MIN = '---\nname: s\ndescription: d\n---\nB\n';
const rule = (paths: string, body = 'BODY') => `---\npaths: ${paths}\n---\n${body}\n`;

test('a rule with paths is on demand with its globs', () => {
  const { entries } = run({ '.claude/rules/api.md': rule('src/api/**') });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ label: '.claude/rules/api.md (paths: src/api/**)', paths: ['src/api/**'], load: 'on-demand', tokens: estimateTokens('BODY\n') });
});

test('a rule without paths is not on demand', () => {
  expect(run({ '.claude/rules/a.md': 'plain\n' }).entries).toEqual([]);
});

test('three harness-decision rules are one group', () => {
  const f: Record<string, string> = {};
  for (const n of [1, 2, 3]) f[`.claude/rules/harness-decision-${n}.md`] = rule('src/**', 'x'.repeat(8));
  const owners = new Map<string, Owner>(Object.keys(f).map((k) => [k, 'harness']));
  const { entries } = run(f, realIO, owners);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ label: 'team decisions: 3 rules', owner: 'harness' });
  expect(entries[0].tokens).toBe(3 * estimateTokens('x'.repeat(8) + '\n'));
});

test('a nested CLAUDE.md is found through lsFiles', () => {
  const io: RepoIO = { ...realIO, lsFiles: () => ['CLAUDE.md', '.claude/CLAUDE.md', 'pkg/CLAUDE.md', 'src/a.ts'] };
  const { entries, notes } = run({ 'CLAUDE.md': 'root', 'pkg/CLAUDE.md': 'x'.repeat(8) }, io);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ label: 'nested CLAUDE.md: 1', tokens: 2 });
  expect(notes).toEqual([]);
});

test('lsFiles returning null gives the note and does not throw', () => {
  const io: RepoIO = { ...realIO, lsFiles: () => null };
  expect(run({ 'CLAUDE.md': 'x' }, io).notes).toEqual(['not a git repository or git not found: nested CLAUDE.md files not listed']);
});

test('skill and agent bodies count the file minus its frontmatter', () => {
  const body = 'B'.repeat(40) + '\n';
  const { entries } = run({
    '.claude/skills/s/SKILL.md': `---\nname: s\ndescription: d\n---\n${body}`,
    '.claude/agents/a.md': `---\nname: a\ndescription: d\n---\n${body}`,
  });
  const g = entries.find((e) => e.label === 'skill and agent bodies: 2');
  expect(g?.tokens).toBe(2 * estimateTokens(body));
});

test('plugins and mcp servers are listed, harness-pins and disabled ones are not', () => {
  const root = makeRepo({
    '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'some-plugin@market': true, 'x@harness-pins': true, 'off@m': false } }),
    '.mcp.json': JSON.stringify({ mcpServers: { github: {} } }),
  }, { git: false });
  expect(unmeasuredSources(root, realIO)).toEqual(['mcp: github', 'plugin: some-plugin@market']);
});

test('malformed settings and .mcp.json never throw and add a note', () => {
  const root = makeRepo({ '.claude/settings.json': '[1]', '.mcp.json': '{nope' }, { git: false });
  expect(unmeasuredSources(root, realIO)).toEqual([]);
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(r.notes).toEqual(expect.arrayContaining(['.claude/settings.json: not a JSON object, not read', '.mcp.json: not valid JSON, not read']));
});

test('measureRepo fills onDemand, unmeasured and keeps earlier entries', () => {
  const root = makeRepo({ 'CLAUDE.md': '@/etc/x\n', '.claude/rules/api.md': rule('src/**'), '.mcp.json': '{"mcpServers":{"g":{}}}' }, { git: false });
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(r.onDemand.map((e) => e.path)).toContain('.claude/rules/api.md');
  expect(r.unmeasured).toEqual(expect.arrayContaining(['external import: /etc/x', 'mcp: g']));
  expect(r.notes).toContain('not a git repository or git not found: nested CLAUDE.md files not listed');
});

test('a repo-owned decision rule is not folded into the harness group', () => {
  const f = { '.claude/rules/harness-decision-1.md': rule('a/**'), '.claude/rules/harness-decision-2.md': rule('b/**') };
  const { entries } = run(f, realIO, new Map<string, Owner>([['.claude/rules/harness-decision-1.md', 'harness']]));
  expect(entries.map((e) => [e.label, e.owner])).toEqual([['team decisions: 1 rules', 'harness'], ['team decisions: 1 rules', 'repo']]);
});

test('a paths rule that CLAUDE.md imports is only in always', () => {
  const root = makeRepo({ 'CLAUDE.md': '@.claude/rules/api.md\n', '.claude/rules/api.md': rule('src/**') }, { git: false });
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(r.always.some((e) => e.path === '.claude/rules/api.md')).toBe(true);
  expect(r.onDemand).toEqual([]);
});

const skillFiles = (extra: Record<string, string> = {}) => ({
  '.claude/skills/off/SKILL.md': '---\nname: off\ndescription: d\n---\nOFFBODY\n',
  '.claude/skills/uio/SKILL.md': '---\nname: uio\ndescription: d\n---\nUIOBODY\n',
  '.claude/commands/cmd.md': 'CMDBODY\n',
  '.claude/settings.json': JSON.stringify({ skillOverrides: { off: 'off', uio: 'user-invocable-only', cmd: 'off' } }),
  ...extra,
});

test('skillOverrides off drops a skill body; user-invocable-only and commands stay', () => {
  const root = makeRepo(skillFiles(), { git: false });
  const r = measureRepo(root, { owners: new Map(), preset: null });
  const g = r.onDemand.find((e) => e.label === 'skill and agent bodies: 2');
  expect(g?.tokens).toBe(estimateTokens('UIOBODY\n') + estimateTokens('CMDBODY\n'));
});

test('a group over 40,000 characters carries the cut note', () => {
  const { entries } = run({ '.claude/skills/s/SKILL.md': `---\nname: s\ndescription: d\n---\n${'x'.repeat(40_001)}` });
  expect(entries[0].note).toMatch(/40,000/);
});

test('a broken settings.json gives one note and one read', () => {
  const root = makeRepo({ '.claude/settings.json': '{bad', '.claude/skills/s/SKILL.md': SKILL_MIN }, { git: false });
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(r.notes.filter((n) => n.includes('settings.json'))).toEqual(['.claude/settings.json: not valid JSON, not read']);
});

test('an ignored settings.json is listed once', () => {
  const root = makeRepo({ '.harnessignore': '.claude/settings.json\n', '.claude/settings.json': '{}' }, { git: false });
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(r.unmeasured.filter((u) => u.startsWith('.claude/settings.json'))).toEqual(['.claude/settings.json: ignored']);
});

test('an ignored skill body is listed as not measured and not counted', () => {
  const { entries, unmeasured } = run({ '.claude/skills/s/SKILL.md': SKILL_MIN }, realIO, new Map(), (rel) => rel.includes('skills/s'));
  expect(entries).toEqual([]);
  expect(unmeasured).toContain('.claude/skills/s/SKILL.md: ignored');
});

test('a nested CLAUDE.md that links out of the repo is listed as outside, not read', () => {
  const outside = mkdtempSync(join(tmpdir(), 'cb5-out-'));
  writeFileSync(join(outside, 'secret.md'), 'S'.repeat(100));
  const root = makeRepo({ 'CLAUDE.md': 'r' }, { git: false });
  mkdirSync(join(root, 'pkg'));
  symlinkSync(join(outside, 'secret.md'), join(root, 'pkg', 'CLAUDE.md'));
  const read: string[] = [];
  const io: RepoIO = { ...realIO, lsFiles: () => ['pkg/CLAUDE.md'], read: (p) => { read.push(p); return realIO.read(p); } };
  const r = onDemand(root, io, new Map(), () => false);
  expect(r.entries).toEqual([]);
  expect(r.unmeasured).toContain('pkg/CLAUDE.md: outside the repo');
  expect(read.some((p) => p.includes('pkg'))).toBe(false);
});

test('two links to the same paths rule give one on-demand row', () => {
  const root = makeRepo({ '.claude/rules/api.md': '---\npaths: src/api/**\n---\nAPI rule\n' }, { git: false });
  symlinkSync('api.md', join(root, '.claude/rules/api-link.md'));
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(r.onDemand.filter((e) => e.label.includes('(paths: src/api/**)'))).toHaveLength(1);
});
