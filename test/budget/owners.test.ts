import { expect, test } from 'vitest';
import { harnessShare, ownersFrom } from '../../src/budget/owners.js';
import type { Catalog } from '../../src/catalog/schema.js';
import type { Manifest } from '../../src/install/manifest.js';

const catalog = { version: 1, items: [
  { id: 'review-rubric', source: { type: 'own' } },
  { id: 'shadcn', source: { type: 'github' } },
] } as unknown as Catalog;
const manifest: Manifest = { version: '1', createdAt: '', files: [
  { rel: '.claude/skills/review-rubric/SKILL.md', kind: 'create', hash: 'h', item: 'review-rubric' },
  { rel: '.claude/skills/shadcn/SKILL.md', kind: 'create', hash: 'h', item: 'shadcn' },
  { rel: '.claude/skills/fe-style/SKILL.md', kind: 'create', hash: 'h', item: 'preset:khubaib-frontend' },
  { rel: '.harness/config.yaml', kind: 'create', hash: 'h' },
  { rel: 'CLAUDE.md', kind: 'update', hash: 'h', blocks: ['\n@AGENTS.md\n'] },
  { rel: 'gone.md', kind: 'delete', hash: 'h' },
] };

test('owners come from the manifest items', () => {
  const o = ownersFrom(manifest, catalog);
  expect(o.get('.claude/skills/review-rubric/SKILL.md')).toBe('harness');
  expect(o.get('.claude/skills/shadcn/SKILL.md')).toBe('catalog:shadcn');
  expect(o.get('.claude/skills/fe-style/SKILL.md')).toBe('preset:khubaib-frontend');
  expect(o.get('.harness/config.yaml')).toBe('harness');
});

test('a merged file (blocks, no item) stays the repo\'s; a deleted file has no owner', () => {
  const o = ownersFrom(manifest, catalog);
  expect(o.get('CLAUDE.md')).toBe('repo');
  expect(o.has('gone.md')).toBe(false);
});

test('no manifest gives no owners', () => {
  expect(ownersFrom(null, catalog).size).toBe(0);
});

test('harnessShare is true for everything but repo', () => {
  expect(['harness', 'catalog:x', 'preset:y', 'repo'].map((o) => harnessShare(o as never))).toEqual([true, true, true, false]);
});
