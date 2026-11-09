import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { stripComments } from '../../src/budget/text.js';
import { appliesTo, loadPreset, presetContext, presetReason, presetRows } from '../../src/catalog/presets.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { alwaysLoadedText, estimateTokens } from '../../src/budget/measure.js';
import { mergeAgentsPreset } from '../../src/install/merge.js';

const load = (n: string) => {
  const r = loadPreset(`test/fixtures/presets/${n}.yaml`);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.loaded;
};
const { catalog } = loadCatalog('catalog');
const dirs = { templates: 'templates' };

test('appliesTo: always, any_dep, frameworks and project_types must all hold', () => {
  const f = { deps: ['react'], frameworks: ['react'] };
  expect(appliesTo({ always: true }, { deps: [], frameworks: [] }, 'api')).toBe(true);
  expect(appliesTo({ any_dep: ['vue', 'react'] }, f, 'web')).toBe(true);
  expect(appliesTo({ any_dep: ['vue'] }, f, 'web')).toBe(false);
  expect(appliesTo({ frameworks: ['next'] }, f, 'web')).toBe(false);
  expect(appliesTo({ frameworks: ['react'], project_types: ['mobile'] }, f, 'web')).toBe(false);
  expect(appliesTo({ frameworks: ['react'], project_types: ['web'] }, f, 'web')).toBe(true);
});

const S = ['superpowers', 'ponytail'];
const WEB = ['web-design-guidelines', 'impeccable'];
const cases: [string[], string, string[], string[]][] = [
  [['next', 'react'], 'web', ['engineering-principles', 'frontend-react', 'frontend-nextjs'], [...S, 'react-best-practices', ...WEB]],
  [['expo', 'react', 'react-native'], 'mobile', ['engineering-principles', 'frontend-react', 'frontend-react-native'], [...S, 'react-best-practices', 'vercel-react-native-skills']],
  [['react', 'react-native'], 'mobile', ['engineering-principles', 'frontend-react', 'frontend-react-native'], [...S, 'react-best-practices', 'vercel-react-native-skills']],
  [['react'], 'web', ['engineering-principles', 'frontend-react'], [...S, 'react-best-practices', ...WEB]],
  [['expo', 'next', 'react', 'react-native'], 'web', ['engineering-principles', 'frontend-react', 'frontend-nextjs', 'frontend-react-native'], [...S, 'react-best-practices', 'vercel-react-native-skills', ...WEB]],
  [[], 'api', ['engineering-principles'], S],
];
test.each(cases)('stacks %j (%s)', (frameworks, type, skills, pre) => {
  const rows = presetRows(load('stacks'), catalog, { deps: frameworks, frameworks }, type, [], dirs);
  expect(rows.map((r) => r.id)).toEqual([...pre, 'core-rules', ...skills]);
  expect(rows.every((r) => r.ticked && r.include === 'recommended' && r.reason === presetReason('stacks'))).toBe(true);
  expect(rows.map((r) => r.id)).not.toContain('caveman');
  expect(rows.find((r) => r.id === 'core-rules')!.context).toMatch(/^~\d+ tokens \(estimate\)$/);
});

test('a preselect the reviewer already picked gets no second row', () => {
  const rows = presetRows(load('stacks'), catalog, { deps: [], frameworks: [] }, 'api', ['ponytail'], dirs);
  expect(rows.map((r) => r.id)).toEqual(['superpowers', 'core-rules', 'engineering-principles']);
});

test('presetContext: one entry per id, equal to the estimate of its text', () => {
  const l = load('tiny');
  const base = join(l.base, 'templates');
  const text = (f: string) => readFileSync(join(base, f), 'utf8');
  const e = presetContext(l, ['core-rules', 'alpha', 'beta']);
  expect(e.map((x) => x.id)).toEqual(['core-rules', 'alpha', 'beta']);
  // As the installed row cuts it: up to the end marker; the newline after it is the repo's. Markers count 0 (spec 3.4).
  const after = mergeAgentsPreset(null, text('core.md')).after;
  expect(after.endsWith('-->\n')).toBe(true);
  expect(e[0]).toMatchObject({ tokens: estimateTokens(stripComments(after.slice(0, -1))), text: stripComments(after.slice(0, -1)) });
  expect(e[1].tokens).toBe(estimateTokens(alwaysLoadedText('skill', text('skills/alpha/SKILL.md'))));
});
