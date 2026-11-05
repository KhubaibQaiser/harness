import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { run } from '../../src/cli/index.js';
import { makeRepo } from '../install/helpers.js';

// The notice set depends on the local Claude Code version; pin it so CI (no `claude` binary) and dev machines agree.
vi.mock('../../src/core/min-claude.js', async (orig) => ({ ...(await orig<object>()), claudeVersion: () => '9.9.9' }));

const root = makeRepo({ 'package.json': '{}' }, { git: false });
const picksFile = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'picks.json');
writeFileSync(picksFile, JSON.stringify({ catalog_version: 1, findings: [], items: [{ id: 'deep', include: 'recommended', reason: 'r', addresses: [] }, { id: 'base', include: 'optional', reason: 'r', addresses: [] }] }));
const go = (args: string[]) => {
  process.env.HARNESS_CATALOG_DIR = 'test/fixtures/catalog';
  process.env.HARNESS_PLAIN_INIT = '1';
  const lines: string[] = [];
  try {
    return { code: run(args, { root, env: {}, out: (l) => lines.push(l) }), lines };
  } finally {
    delete process.env.HARNESS_CATALOG_DIR;
    delete process.env.HARNESS_PLAIN_INIT;
  }
};

test('select round trip: checklist, then choose', () => {
  const a = go(['select', '--picks', picksFile]);
  expect(a.code).toBe(0);
  expect(JSON.parse(a.lines.join('\n')).map((r: { id: string }) => r.id)).toEqual(['deep', 'base']);
  const b = go(['select', '--picks', picksFile, '--choose', 'deep']);
  expect(b.code).toBe(0);
  const out = JSON.parse(b.lines.join('\n'));
  expect(out.ids).toEqual(['deep', 'extra', 'base']);
  expect(out.notices).toHaveLength(2);
  expect(out.selected.map((s: { id: string; selected: boolean }) => [s.id, s.selected])).toEqual([['deep', true], ['base', true], ['extra', true]]);
});

test('select prints errors with exit 2; bad usage and bad files exit 2', () => {
  const both = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'p.json');
  writeFileSync(both, JSON.stringify({ catalog_version: 1, findings: [], items: ['lead-a', 'lead-b'].map((id) => ({ id, include: 'optional', reason: 'r', addresses: [] })) }));
  expect(go(['select', '--picks', both, '--choose', 'lead-a,lead-b'])).toEqual({ code: 2, lines: ['lead-a and lead-b conflict; pick one.'] });
  expect(go(['select']).code).toBe(2);
  expect(go(['select', '--picks', '/nonexistent']).code).toBe(2);
});

test('select: --choose empty is a usage error; malformed picks exit 2; C1 in a path is escaped', () => {
  expect(go(['select', '--picks', picksFile, '--choose', '']).code).toBe(2);
  const bad = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'bad.json');
  writeFileSync(bad, '{"items":[null]}');
  const r = go(['select', '--picks', bad]);
  expect(r.code).toBe(2);
  const c1 = go(['select', '--picks', '/nonexistent/a\u009b.json']);
  expect(c1.lines.join()).not.toContain('\u009b');
  expect(c1.lines.join()).toContain('\\u009b');
});

test('a real own-item row has a non-empty context line', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'p.json');
  writeFileSync(f, JSON.stringify({ catalog_version: 1, findings: [], items: [{ id: 'review-rubric', include: 'recommended', reason: 'r', addresses: [] }] }));
  const lines: string[] = [];
  expect(run(['select', '--picks', f], { root, env: {}, out: (l) => lines.push(l) })).toBe(0);
  expect(JSON.parse(lines.join('\n'))[0].context).toMatch(/^~[1-9]\d* tokens \(estimate\)$/);
});

test('--choose rejects ids that are not in the picks; requires stay allowed', () => {
  const r = go(['select', '--picks', picksFile, '--choose', 'lead-a']);
  expect(r.code).toBe(2);
  expect(r.lines.join('\n')).toContain('"lead-a" was not in the picks');
  expect(go(['select', '--picks', picksFile, '--choose', 'deep']).code).toBe(0);
});

test('picks with an id outside the catalog is an error, not a silent drop', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'p.json');
  writeFileSync(f, JSON.stringify({ catalog_version: 1, findings: [], items: [{ id: 'nope', include: 'optional', reason: 'r', addresses: [] }] }));
  const r = go(['select', '--picks', f]);
  expect(r.code).toBe(2);
  expect(r.lines.join('\n')).toContain('unknown item "nope"');
});

const presetRoot = makeRepo({ 'package.json': '{}' }, { git: false });
mkdirSync(join(presetRoot, '.harness', 'presets'), { recursive: true });
cpSync('test/fixtures/presets', join(presetRoot, '.harness', 'presets'), { recursive: true });
// The fixture catalog has no ponytail, so the copied preset preselects a fixture item instead.
const tinyYaml = join(presetRoot, '.harness', 'presets', 'tiny.yaml');
writeFileSync(tinyYaml, readFileSync(tinyYaml, 'utf8').replace('- ponytail', '- extra'));
const goPreset = (args: string[]) => {
  process.env.HARNESS_CATALOG_DIR = 'test/fixtures/catalog';
  process.env.HARNESS_PLAIN_INIT = '1';
  const lines: string[] = [];
  try {
    return { code: run(args, { root: presetRoot, env: {}, out: (l) => lines.push(l) }), lines };
  } finally {
    delete process.env.HARNESS_CATALOG_DIR;
    delete process.env.HARNESS_PLAIN_INIT;
  }
};
const answersFile = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'answers.json');
writeFileSync(answersFile, JSON.stringify({ project: { type: 'web' } }));

test('select --preset: rows, choose splits preset items, errors exit 2', () => {
  const rows = goPreset(['select', '--picks', picksFile, '--preset', 'tiny', '--answers', answersFile]);
  expect(rows.code).toBe(0);
  expect(JSON.parse(rows.lines.join('\n')).map((r: { id: string }) => r.id)).toEqual(['deep', 'base', 'extra', 'core-rules', 'alpha', 'beta']);
  const c = goPreset(['select', '--picks', picksFile, '--preset', 'tiny', '--answers', answersFile, '--choose', 'deep,core-rules,alpha']);
  expect(c.code).toBe(0);
  const out = JSON.parse(c.lines.join('\n'));
  expect(out.preset_items).toEqual(['core-rules', 'alpha']);
  expect(out.ids).toEqual(['deep', 'extra', 'base']);
  expect(goPreset(['select', '--picks', picksFile, '--preset', 'tiny']).code).toBe(2);
  expect(goPreset(['select', '--picks', picksFile, '--preset', 'tiny']).lines[0]).toContain('Usage:');
  expect(goPreset(['select', '--picks', picksFile, '--preset', 'nope', '--answers', answersFile])).toEqual({ code: 2, lines: ['preset: "nope" is not a shipped or repo preset (harness preset list shows them)'] });
});

test('select --preset: a bad preset or project type exits 2 instead of dropping or crashing', () => {
  const presets = join(presetRoot, '.harness', 'presets');
  const args = (id: string) => ['select', '--picks', picksFile, '--preset', id, '--answers', answersFile];
  writeFileSync(join(presets, 'typo.yaml'), readFileSync(tinyYaml, 'utf8').replace('id: tiny', 'id: typo').replace('- extra', '- extrx'));
  cpSync(join(presets, 'tiny'), join(presets, 'typo'), { recursive: true });
  expect(goPreset(args('typo'))).toEqual({ code: 2, lines: ['preset: preselect "extrx" is not in the catalog'] });
  writeFileSync(join(presets, 'nocore.yaml'), readFileSync(tinyYaml, 'utf8').replace('id: tiny', 'id: nocore'));
  cpSync(join(presets, 'tiny'), join(presets, 'nocore'), { recursive: true });
  rmSync(join(presets, 'nocore', 'templates', 'core.md'));
  const r = goPreset(args('nocore'));
  expect(r.code).toBe(2);
  expect(r.lines.join('\n')).toContain('core.md not found');
  const banana = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'a.json');
  writeFileSync(banana, JSON.stringify({ project: { type: 'banana' } }));
  const b = goPreset(['select', '--picks', picksFile, '--preset', 'tiny', '--answers', banana]);
  expect(b.code).toBe(2);
  expect(b.lines[0]).toContain('project.type');
});
