import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { loadCatalog } from '../../src/catalog/load.js';
import { MIN_CLAUDE_CODE } from '../../src/core/min-claude.js';
import { TELEMETRY_ENV, checkPreset, identityProblems, loadPreset } from '../../src/catalog/presets.js';
import type { LoadedPreset } from '../../src/catalog/presets.js';
import { alwaysLoadedText, estimateTokens } from '../../src/budget/measure.js';
import { mergeAgentsPreset } from '../../src/install/merge.js';

const DIR = 'catalog/presets';
const BASE = join(DIR, 'khubaib-frontend');
const SPEC = readFileSync('docs/specs/2026-11-05-personal-preset-design.md', 'utf8');
const SKILLS = ['engineering-principles', 'frontend-react', 'frontend-nextjs', 'frontend-react-native'];

function load(): LoadedPreset {
  const r = loadPreset(join(DIR, 'khubaib-frontend.yaml'));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.loaded;
}
const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
const frontmatter = (name: string) => parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(join(BASE, 'templates/skills', name, 'SKILL.md'), 'utf8'))![1]) as { name: string; description: string };

test('preset check passes with no identity problems', () => {
  const l = load();
  expect(checkPreset(l, loadCatalog().catalog)).toEqual([]);
  expect(identityProblems(l)).toEqual([]);
});

test('YAML values', () => {
  const { preset } = load();
  expect(preset.id).toBe('khubaib-frontend');
  expect(preset.title).toBe('Khubaib frontend');
  expect(preset.preselect).toEqual(['superpowers', 'ponytail', 'react-best-practices', 'vercel-react-native-skills', 'web-design-guidelines', 'impeccable']);
  expect(preset.skills).toEqual(SKILLS);
  expect(preset.settings).toEqual({ attribution: 'off', telemetry_off: ['impeccable', 'superpowers'] });
  expect(preset.git).toEqual({ branch_prefixes: ['feature/', 'fix/', 'hotfix/', 'chore/', 'refactor/', 'docs/', 'ci/'], no_ai_trailer: true, pr_size_warning: true });
});

test('item kinds, core id and min_claude_code', () => {
  const { preset, items } = load();
  expect(preset.core).toBe('core-rules');
  expect(Object.fromEntries(items.map((i) => [i.id, i.kind]))).toEqual({ 'core-rules': 'rule', ...Object.fromEntries(SKILLS.map((n) => [n, 'own-skill'])) });
  for (const i of items) expect(i.min_claude_code, i.id).toBe(MIN_CLAUDE_CODE);
});

test('caveman is nowhere in the preset', () => {
  for (const f of [join(DIR, 'khubaib-frontend.yaml'), ...files(BASE)]) expect(readFileSync(f, 'utf8').toLowerCase(), f).not.toContain('caveman');
});

test('applies_when per skill', () => {
  const aw = Object.fromEntries(load().items.map((i) => [i.id, i.applies_when]));
  expect(aw['engineering-principles']).toEqual({ always: true });
  expect(aw['frontend-react']).toEqual({ frameworks: ['react', 'next', 'react-native', 'expo'] });
  expect(aw['frontend-nextjs']).toEqual({ frameworks: ['next'] });
  expect(aw['frontend-react-native']).toEqual({ frameworks: ['react-native', 'expo'] });
});

test('core.md is the spec section 5 block, line for line', () => {
  const inner = /<!-- harness:preset:start -->\n([\s\S]*?)<!-- harness:preset:end -->/.exec(SPEC)![1];
  const core = readFileSync(join(BASE, 'templates/core.md'), 'utf8');
  expect(core.trim().split('\n')).toEqual(inner.trim().split('\n'));
  expect(core.split('\n').find((l) => l.startsWith('- '))).toContain('This overrides any skill that says to decide on its own.');
});

test('skill descriptions are the spec section 7 text', () => {
  for (const name of SKILLS) {
    const row = new RegExp(`^\\| \`${name}\` \\| (.+?Use when.+?) \\| `, 'm').exec(SPEC);
    expect(row, `spec section 7 has no "Use when" row for ${name}`).not.toBeNull();
    expect(frontmatter(name)).toEqual({ name, description: row![1] });
  }
});

test('telemetry opt-out variables', () => {
  expect(TELEMETRY_ENV.impeccable).toEqual({ name: 'DO_NOT_TRACK', value: '1' });
  expect(TELEMETRY_ENV.superpowers).toEqual({ name: 'SUPERPOWERS_DISABLE_TELEMETRY', value: 'true' });
});

const body = (name: string) => readFileSync(join(BASE, 'templates/skills', name, 'SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');

test('no skill body is a placeholder', () => {
  for (const name of SKILLS) expect(body(name), name).not.toContain('Body: see Task 2b.');
});

test('frontend-react quotes F3 verbatim', () => {
  const f3 = /^\| F3 \| Client state \| (".+") \|$/m.exec(SPEC)![1];
  expect(body('frontend-react')).toContain(f3);
});

test('frontend-react has the P7 Tailwind sizing rule', () => {
  const b = body('frontend-react');
  expect(b).toContain('h-[98px]');
  expect(b).toMatch(/closest built-in or breakpoint class/);
});

test('always-loaded totals match spec section 5 (estimate, core counted with its markers)', () => {
  const core = estimateTokens(mergeAgentsPreset(null, readFileSync(join(BASE, 'templates/core.md'), 'utf8')).after);
  const t = Object.fromEntries(SKILLS.map((n) => [n, estimateTokens(alwaysLoadedText('skill', readFileSync(join(BASE, 'templates/skills', n, 'SKILL.md'), 'utf8')))]));
  const base = core + t['engineering-principles'];
  expect([base + t['frontend-react'] + t['frontend-nextjs'], base + t['frontend-react'] + t['frontend-nextjs'] + t['frontend-react-native'], base + t['frontend-react'], base]).toEqual([357, 415, 299, 241]);
  for (const n of [357, 415, 299, 241]) expect(SPEC, `spec section 5 shows ~${n}`).toContain(`| ~${n} |`);
});
