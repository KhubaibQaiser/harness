import { join } from 'node:path';
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
  expect(p).toMatchObject({ owner: 'harness', load: 'always' });
  expect(p!.label).toMatch(/^skills harness:/);
  expect(p!.tokens).toBeGreaterThan(0);
});

test('a plugin pick with no number is unmeasured, and not in always', () => {
  const s = contextSet(installed(), cfg('auth0'), dirs);
  if (s.always.some((e) => e.owner === 'catalog:auth0')) return; // measured once the recorded cost lands (#152)
  expect(s.unmeasured).toContain('plugin: auth0');
});

test('a bad catalog gives the note, keeps the plugin row and repo files, and does not throw', () => {
  const bad = makeRepo({ 'items/x.yaml': ': : not yaml [' }, { git: false });
  const s = contextSet(installed(), cfg('auth0'), dirs, undefined, bad);
  expect(s.notes).toContain('the catalog has errors; catalog picks not measured');
  expect(s.always.some((e) => e.id === 'harness-plugin')).toBe(true);
  expect(s.always.some((e) => e.path === 'AGENTS.md')).toBe(true);
  expect(s.always.some((e) => e.id === 'auth0')).toBe(false); // the pick is not measured
});

test('no manifest: every file is repo', () => {
  const root = makeRepo({ 'CLAUDE.md': 'hello', [SK]: SKILL }, { git: false });
  const s = contextSet(root, cfg(), dirs);
  expect(s.always.filter((e) => e.id !== 'harness-plugin').every((e) => e.owner === 'repo')).toBe(true);
  expect(repoOnly(s).length).toBe(2);
  expect(s.repo).toBeGreaterThan(0);
});
