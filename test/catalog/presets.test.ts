import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { checkPreset, findPreset, identityProblems, identityProblemsIn, listPresets, loadPreset, presetDirs, shippedPresetsDir, suggestBranches, slug, PREFIX_RE } from '../../src/catalog/presets.js';
import type { LoadedPreset } from '../../src/catalog/presets.js';
import type { Catalog, CatalogItem } from '../../src/catalog/schema.js';

afterEach(() => vi.unstubAllEnvs());

const fx = (n: string) => join('test/fixtures/presets', n);
const cit = (id: string, stance: CatalogItem['stance'] = 'optional'): CatalogItem => ({
  id, kind: 'plugin', title: id, source: { type: 'github', repo: 'a/b', plugin: id, sha: 'a'.repeat(40) }, license: 'MIT', min_claude_code: '2.1.0',
  applies_when: { always: true }, conflicts_with: [], requires: [], cost: { context: 'low', setup: 'none' }, stance, stance_reason: stance === 'discouraged' ? 'r' : '',
  side_effects: [], why: 'w', evidence: [],
});
const catalog: Catalog = { version: 1, items: [cit('ponytail'), cit('superpowers'), cit('caveman', 'discouraged')] };

const itemYaml = (id: string, kind: string, source: string) => `id: ${id}\nkind: ${kind}\ntitle: "${id}"\nsource: ${source}\nlicense: MIT\nmin_claude_code: 2.1.0\napplies_when: {always: true}\ncost: {context: low, setup: none}\nstance: default\nwhy: w\n`;
const skillSrc = (n: string) => `{type: own, files: [{from: skills/${n}/SKILL.md, to: .claude/skills/${n}/SKILL.md}]}`;
const presetYaml = (o: { preselect?: string; skills?: string; tel?: string; prefixes?: string; extra?: string; desc?: string } = {}) =>
  `id: x\ntitle: X\ndescription: ${o.desc ?? 'd'}\ncore: core-rules\npreselect: ${o.preselect ?? '[ponytail]'}\nskills: ${o.skills ?? '[x]'}\nsettings:\n  attribution: off\n  telemetry_off: ${o.tel ?? '[]'}\ngit:\n  branch_prefixes: ${o.prefixes ?? '[feature/]'}\n  no_ai_trailer: true\n  pr_size_warning: true\n${o.extra ?? ''}`;
const skillMd = (body = '- Use X.\n', fm = 'name: x\ndescription: d') => `---\n${fm}\n---\n${body}`;

/** A preset `x` with core-rules and one skill `x`; `files` overrides or adds paths (relative to the presets dir). */
function mk(files: Record<string, string | null> = {}, d = mkdtempSync(join(tmpdir(), 'harness-preset-'))): string {
  const all: Record<string, string | null> = {
    'x.yaml': presetYaml(),
    'x/items/core-rules.yaml': itemYaml('core-rules', 'rule', '{type: own}'),
    'x/items/x.yaml': itemYaml('x', 'own-skill', skillSrc('x')),
    'x/templates/core.md': 'core\n',
    'x/templates/skills/x/SKILL.md': skillMd(),
    ...files,
  };
  for (const [f, t] of Object.entries(all)) {
    if (t === null) continue;
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), t);
  }
  return d;
}
/** Every error load and check report for the preset. */
function errs(d: string, opts?: { builtOnly?: boolean }): string[] {
  const r = loadPreset(join(d, 'x.yaml'));
  return r.ok ? checkPreset(r.loaded, catalog, opts) : r.errors;
}
const one = (files: Record<string, string | null>, msg: string) => expect(errs(mk(files))).toEqual([expect.stringContaining(msg)]);

test('mk baseline is clean', () => expect(errs(mk())).toEqual([]));

test('loads the tiny fixture', () => {
  const r = loadPreset(fx('tiny.yaml'));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  expect(r.loaded.items.map((i) => i.id)).toEqual(['core-rules', 'alpha', 'beta']);
  expect(r.loaded.preset.settings.attribution).toBe('off');
  expect(r.loaded.preset.settings.telemetry_off).toEqual([]);
  expect(checkPreset(r.loaded, catalog)).toEqual([]);
});
test('the stacks fixture loads', () => {
  const r = loadPreset(fx('stacks.yaml'));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  expect(r.loaded.preset.skills).toHaveLength(4);
});

test('re-exports the branch helpers', () => {
  expect(slug('A b')).toBe('a-b');
  expect(suggestBranches(['fix/'], 'A b')).toEqual(['fix/a-b']);
  expect(PREFIX_RE.test('fix/')).toBe(true);
});

test('preselect checks', () => {
  one({ 'x.yaml': presetYaml({ preselect: '[zzz]' }) }, 'preselect "zzz" is not in the catalog');
  one({ 'x.yaml': presetYaml({ preselect: '[caveman]' }) }, 'preselect "caveman" is discouraged in the catalog');
});
test('skill item and template checks', () => {
  one({ 'x.yaml': presetYaml({ skills: '[x, y]' }) }, 'skills "y": no item at x/items/y.yaml');
  one({ 'x/templates/skills/x/SKILL.md': null }, 'x: template skills/x/SKILL.md not found');
  one({ 'x/items/ponytail.yaml': itemYaml('ponytail', 'own-skill', skillSrc('x')), 'x.yaml': presetYaml({ skills: '[x, ponytail]' }) }, 'item "ponytail" clashes with a catalog id');
});
test('skill body checks', () => {
  one({ 'x/templates/skills/x/SKILL.md': skillMd('- Use X.\n', 'name: x') }, 'skills/x/SKILL.md: frontmatter needs name and description');
  one({ 'x/templates/skills/x/SKILL.md': skillMd('- a\n'.repeat(151)) }, 'skills/x/SKILL.md: body has 151 lines; the limit is 150');
  expect(errs(mk({ 'x/templates/skills/x/SKILL.md': skillMd('- a\n'.repeat(150)) }))).toEqual([]);
  one({ 'x/templates/skills/x/SKILL.md': skillMd('- a\n- Use X. [docs]\n') }, 'skills/x/SKILL.md:6: a docs-labelled line needs a link: [docs: https://…]');
  expect(errs(mk({ 'x/templates/skills/x/SKILL.md': skillMd('- Use X. [docs: https://react.dev/a]\n') }))).toEqual([]);
});
test('git and settings checks', () => {
  one({ 'x.yaml': presetYaml({ prefixes: '[]' }) }, 'branch_prefixes: must be a non-empty list');
  one({ 'x.yaml': presetYaml({ prefixes: '[feature]' }) }, 'branch_prefixes[0]: must match ^[a-z0-9-]+/$');
  one({ 'x.yaml': presetYaml({ tel: '[ponytail]', preselect: '[superpowers]' }) }, 'telemetry_off "ponytail" is not in preselect');
  one({ 'x.yaml': presetYaml({ tel: '[ponytail]' }) }, 'telemetry_off "ponytail": harness knows no opt-out variable for it');
  one({ 'x.yaml': presetYaml({ extra: 'extra: 1\n' }) }, 'unknown key "extra"');
});
test('errors are escaped', () => one({ 'x.yaml': presetYaml({ preselect: '["a\\u001bb"]' }) }, 'preselect "a\\u001bb" is not in the catalog'));

function stubShipped(files: Record<string, string>): string {
  const shipped = mkdtempSync(join(tmpdir(), 'harness-cat-'));
  mkdirSync(join(shipped, 'presets'), { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(join(shipped, 'presets', f), t);
  vi.stubEnv('HARNESS_CATALOG_DIR', shipped);
  vi.stubEnv('HARNESS_PLAIN_INIT', '1');
  return join(shipped, 'presets');
}

test('shipped-id clash only with builtOnly, and only outside the shipped dir', () => {
  const sd = stubShipped({ 'x.yaml': 'id: x\n' });
  const d = mk();
  expect(errs(d, { builtOnly: true })).toEqual([expect.stringContaining('preset id "x" is already a shipped preset')]);
  expect(errs(d)).toEqual([]);
  const inside = loadPreset(join(mk({}, sd), 'x.yaml'));
  if (!inside.ok) throw new Error('load');
  expect(checkPreset(inside.loaded, catalog, { builtOnly: true })).toEqual([]);
});

test('identity', () => {
  expect(identityProblemsIn('react@19.0.0 expo@~52.0.0 @tanstack/react-query', 'a')).toEqual([]);
  expect(identityProblemsIn('mail jane@example.com', 'rules[0]')).toEqual([expect.stringContaining('rules[0]')]);
  expect(identityProblemsIn('git config user.email', 'a')).toHaveLength(1);
  const load = (files: Record<string, string | null>): LoadedPreset => {
    const r = loadPreset(join(mk(files), 'x.yaml'));
    if (!r.ok) throw new Error(r.errors.join('\n'));
    return r.loaded;
  };
  expect(identityProblems(load({}))).toEqual([]);
  expect(identityProblems(load({ 'x/templates/core.md': 'ask jane@example.com\n' }))).toHaveLength(1);
  expect(identityProblems(load({ 'x.yaml': presetYaml({ desc: '"by jane@example.com"' }) }))).toHaveLength(1);
});

test('listPresets and findPreset', () => {
  const sd = stubShipped({ 'a.yaml': 'id: a\ndescription: shipped one\n' });
  const root = mkdtempSync(join(tmpdir(), 'harness-root-'));
  mkdirSync(join(root, '.harness', 'presets'), { recursive: true });
  writeFileSync(join(root, '.harness', 'presets', 'b.yaml'), 'id: b\ndescription: repo one\n');
  expect(shippedPresetsDir()).toBe(sd);
  expect(presetDirs(root)).toEqual([sd, join(root, '.harness', 'presets')]);
  expect(listPresets(root).map((p) => `${p.id}:${p.where}:${p.description}`)).toEqual(['a:shipped:shipped one', 'b:repo:repo one']);
  expect(findPreset('a', root)).toBe(join(sd, 'a.yaml'));
  expect(findPreset('b', root)).toBe(join(root, '.harness', 'presets', 'b.yaml'));
  expect(findPreset('zzz', root)).toBeNull();
  expect(findPreset('../x', root)).toBeNull();
});

test('identity check is linear on hostile input', () => {
  for (const t of ['a'.repeat(80_000), 'a@' + 'b.'.repeat(40_000)]) {
    const t0 = performance.now();
    identityProblemsIn(t, 'a');
    expect(performance.now() - t0).toBeLessThan(100);
  }
});

test('size cap and symlinks', () => {
  one({ 'x/templates/core.md': 'a'.repeat(300 * 1024) }, 'core.md: larger than 256 KB');
  one({ 'x/templates/skills/x/SKILL.md': 'a'.repeat(300 * 1024) }, 'larger than 256 KB');
  const d = mk();
  symlinkSync(join(d, 'x'), join(d, 'x', 'templates', 'loop'));
  writeFileSync(join(d, 'outside.md'), 'jane@example.com');
  symlinkSync(join(d, 'outside.md'), join(d, 'x', 'templates', 'link.md'));
  const r = loadPreset(join(d, 'x.yaml'));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  const p = identityProblems(r.loaded);
  expect(p).toHaveLength(2);
  expect(p.join()).toContain('symlink');
  writeFileSync(join(d, 'x', 'templates', 'big.md'), 'a'.repeat(300 * 1024));
  expect(identityProblems(r.loaded).join()).toContain('larger than 256 KB');
  expect(errs(mk({ 'x.yaml': presetYaml() })).length).toBe(0);
});
test('a symlinked item is refused', () => {
  const d = mk();
  writeFileSync(join(d, 'real.yaml'), itemYaml('y', 'own-skill', skillSrc('x')));
  symlinkSync(join(d, 'real.yaml'), join(d, 'x', 'items', 'y.yaml'));
  writeFileSync(join(d, 'x.yaml'), presetYaml({ skills: '[x, y]' }));
  expect(errs(d)).toEqual([expect.stringContaining('symlink')]);
});

test('skills need source.files', () => {
  one({ 'x/items/x.yaml': itemYaml('x', 'own-skill', '{type: own}') }, 'x: skill needs source.files');
});
test('item id, kind and duplicates', () => {
  one({ 'x/items/x.yaml': itemYaml('y', 'own-skill', skillSrc('x')) }, 'x/items/x.yaml: id must be x');
  one({ 'x/items/x.yaml': itemYaml('x', 'rule', '{type: own}') }, 'x/items/x.yaml: kind must be own-skill');
  one({ 'x/items/core-rules.yaml': itemYaml('core-rules', 'own-skill', skillSrc('x')) }, 'x/items/core-rules.yaml: kind must be rule');
  one({ 'x.yaml': presetYaml({ skills: '[x, x]' }) }, 'skills "x" is listed twice');
  one({ 'x.yaml': presetYaml({ preselect: '[ponytail, ponytail]' }) }, 'preselect "ponytail" is listed twice');
  one({ 'x.yaml': presetYaml({ skills: '[core-rules]' }) }, 'skills "core-rules" is listed twice');
});
test('prototype names are not telemetry vars, labels are escaped, missing file is unreadable', () => {
  one({ 'x.yaml': presetYaml({ preselect: '[ponytail]', tel: '[constructor]' }) }, 'telemetry_off "constructor" is not in preselect');
  const r = loadPreset(join(mk(), 'nope.yaml'));
  expect(r.ok ? [] : r.errors).toEqual([expect.stringContaining('cannot read')]);
  one({ 'x/items/x.yaml': itemYaml('x', 'own-skill', '{type: own, files: [{from: "skills/a\\u001bb/SKILL.md", to: .claude/s.md}]}') }, 'template skills/a\\u001bb/SKILL.md not found');
});
test('listPresets skips an id that differs from its file name', () => {
  stubShipped({ 'a.yaml': 'id: other\n', 'b.yaml': 'id: b\n' });
  expect(listPresets(mkdtempSync(join(tmpdir(), 'harness-root-'))).map((p) => p.id)).toEqual(['b']);
});

/** Move d/sub out of the presets dir and leave a symlink to it. */
function symlinked(d: string, sub: string): void {
  const out = mkdtempSync(join(tmpdir(), 'harness-out-'));
  renameSync(join(d, sub), join(out, 'moved'));
  symlinkSync(join(out, 'moved'), join(d, sub));
}
test('a symlinked preset, items or templates dir is refused', () => {
  for (const sub of ['x', 'x/items', 'x/templates']) {
    const d = mk();
    symlinked(d, sub);
    const e = errs(d);
    expect(e.length, sub).toBeGreaterThan(0);
    expect(e.join(), sub).toContain('symlink');
  }
  const d = mk();
  const r = loadPreset(join(d, 'x.yaml'));
  if (!r.ok) throw new Error('load');
  symlinked(d, 'x');
  expect(identityProblems(r.loaded).join()).toContain('symlink');
});
test('a symlinked skills dir under templates is refused', () => {
  const d = mk();
  symlinked(d, 'x/templates/skills');
  expect(errs(d).join()).toContain('skills/x/SKILL.md: outside the presets folder');
});
test('listPresets skips symlinked and oversized yaml', () => {
  const sd = stubShipped({ 'a.yaml': 'id: a\n', 'big.yaml': 'id: big\n# ' + 'a'.repeat(300 * 1024) });
  writeFileSync(join(sd, '..', 'real.yaml'), 'id: link\n');
  symlinkSync(join(sd, '..', 'real.yaml'), join(sd, 'link.yaml'));
  expect(listPresets(mkdtempSync(join(tmpdir(), 'harness-root-'))).map((p) => p.id)).toEqual(['a']);
});
