import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { contextSet, repoOnly, STATE_CARD_MAX_TOKENS, type ContextSet } from '../../src/budget/summary.js';
import { defaults, type HarnessConfig } from '../../src/core/config.js';
import { makeRepo } from '../install/helpers.js';

const dirs = { templates: join(__dirname, '../../templates'), plugin: join(__dirname, '../..') };
const BLOCK = '<!-- harness:start -->\nharness rule text\n<!-- harness:end -->\n';
const SKILL = '---\nname: review-rubric\ndescription: Grades a diff against the rubric.\n---\nBODY\n';
const SK = '.claude/skills/review-rubric/SKILL.md';
const cfg = (...ids: string[]): HarnessConfig => ({ ...defaults(), items: ids.map((id) => ({ id, include: 'recommended', selected: true })) as HarnessConfig['items'] });
const manifest = (files: object[]) => JSON.stringify({ version: '1', createdAt: '', files });
const installed = () => makeRepo({
  'AGENTS.md': `repo text\n${BLOCK}`, [SK]: SKILL, 'CLAUDE.md': '@AGENTS.md\n',
  '.harness/manifest.json': manifest([
    { rel: 'AGENTS.md', kind: 'update', hash: 'h', item: 'agents-md' }, { rel: SK, kind: 'create', hash: 'h', item: 'review-rubric' },
  ]),
}, { git: false });
const sum = (s: ContextSet) => s.always.reduce((n, e) => n + e.tokens, 0);

test('STATE_CARD_MAX_TOKENS is 300', () => expect(STATE_CARD_MAX_TOKENS).toBe(300));

test('no double count: each installed row once, total is the sum of the rows', () => {
  const s = contextSet(installed(), cfg('agents-md', 'review-rubric'), dirs);
  expect(s.always.filter((e) => e.label === 'AGENTS.md harness block')).toHaveLength(1);
  expect(s.always.filter((e) => e.path === SK)).toHaveLength(1);
  expect(s.always.filter((e) => e.id === 'review-rubric' || e.id === 'agents-md')).toHaveLength(0);
  expect(s.total).toBe(sum(s));
  expect(s.total).toBe(s.harness + s.catalog + s.repo);
  expect(s.budget).toBe(2000);
});

test('the plugin row is in always, owned by harness', () => {
  const p = contextSet(installed(), cfg(), dirs).always.find((e) => e.id === 'harness-plugin');
  expect(p).toMatchObject({ owner: 'harness', load: 'always', chars: 0, path: 'plugin:harness' });
  expect(p!.note).toBeUndefined(); // measured from harness's own files, not a catalog record
  // Only the skills that load a listing (doctor, status); the slash-only ones (disable-model-invocation) cost nothing.
  expect(p!.label).toBe('skills harness:doctor, harness:status + agents staff-reviewer');
  expect(p!.tokens).toBeGreaterThan(0);
});

const pick = (id: string, file: string) => readFileSync(join(__dirname, '../../catalog/items', file), 'utf8').replace(/^id: .*$/m, `id: ${id}`);
const catDir = (items: Record<string, string>) => makeRepo({ 'catalog.yaml': 'version: 1\n', ...Object.fromEntries(Object.entries(items).map(([id, y]) => [`items/${id}.yaml`, y])) }, { git: false });

test('a plugin pick with no number is unmeasured, and not in always', () => {
  const s = contextSet(installed(), cfg('p1'), dirs, undefined, { catalogDir: catDir({ p1: pick('p1', 'auth0.yaml').replace(/, ?"context_tokens": ?\d+/, '') }) });
  expect(s.unmeasured).toContain('plugin: p1');
  expect(s.always.some((e) => e.owner === 'catalog:p1')).toBe(false);
});

test('a pick that left a file in the repo is counted once, from the repo rows', () => {
  const root = makeRepo({
    '.claude/skills/ext/SKILL.md': '---\nname: ext\ndescription: An outside skill.\n---\nB\n',
    '.harness/manifest.json': manifest([{ rel: '.claude/skills/ext/SKILL.md', kind: 'create', hash: 'h', item: 'ext' }]),
  }, { git: false });
  const s = contextSet(root, cfg('ext'), dirs, undefined, { catalogDir: catDir({ ext: pick('ext', 'react-best-practices.yaml') }) });
  expect(s.always.filter((e) => e.owner === 'catalog:ext')).toHaveLength(1);
  expect(s.always.find((e) => e.owner === 'catalog:ext')!.path).toBe('.claude/skills/ext/SKILL.md');
  expect(s.unmeasured).not.toContain('plugin: ext');
});

test('a bad catalog: the note, the plugin row, repo files, and manifest files owned by harness', () => {
  const s = contextSet(installed(), cfg('agents-md', 'review-rubric', 'auth0'), dirs, undefined, { catalogDir: catDir({ x: ': : not yaml [' }) });
  expect(s.notes).toContain('the catalog has errors; catalog picks not measured, and harness\'s share includes them');
  expect(s.always.some((e) => e.id === 'harness-plugin')).toBe(true);
  expect(s.always.find((e) => e.path === SK)!.owner).toBe('harness');
  expect(s.always.some((e) => e.owner.startsWith('catalog:'))).toBe(false);
  expect(s.catalog).toBe(0);
  expect(s.harness).toBeGreaterThan(s.always.find((e) => e.id === 'harness-plugin')!.tokens);
  expect(s.total).toBe(sum(s));
});

test('no manifest: every file is repo', () => {
  const root = makeRepo({ 'CLAUDE.md': 'hello', [SK]: SKILL }, { git: false });
  const s = contextSet(root, cfg(), dirs);
  expect(s.always.filter((e) => e.id !== 'harness-plugin').every((e) => e.owner === 'repo')).toBe(true);
  expect(repoOnly(s).length).toBe(2);
  expect(s.repo).toBeGreaterThan(0);
});
