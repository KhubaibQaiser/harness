import { expect, test } from 'vitest';
import { realIO, type RepoIO } from '../../src/budget/imports.js';
import { onDemand, unmeasuredSources } from '../../src/budget/on-demand.js';
import { measureRepo } from '../../src/budget/sources.js';
import { estimateTokens } from '../../src/budget/measure.js';
import { makeRepo } from '../install/helpers.js';

const run = (files: Record<string, string>, io: RepoIO = realIO) => {
  const root = makeRepo(files, { git: false });
  return onDemand(root, io, new Map(), () => false);
};
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
  const { entries } = run(f);
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
  expect(r.notes).toEqual(expect.arrayContaining(['.claude/settings.json: not valid JSON, not read', '.mcp.json: not valid JSON, not read']));
});

test('measureRepo fills onDemand, unmeasured and keeps earlier entries', () => {
  const root = makeRepo({ 'CLAUDE.md': '@/etc/x\n', '.claude/rules/api.md': rule('src/**'), '.mcp.json': '{"mcpServers":{"g":{}}}' }, { git: false });
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(r.onDemand.map((e) => e.path)).toContain('.claude/rules/api.md');
  expect(r.unmeasured).toEqual(expect.arrayContaining(['external import: /etc/x', 'mcp: g']));
  expect(r.notes).toContain('not a git repository or git not found: nested CLAUDE.md files not listed');
});
