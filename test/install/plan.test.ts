import { cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadCatalog } from '../../src/catalog/load.js';
import type { Selected } from '../../src/core/config.js';
import { applyChanges, type Change } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
import { LEGACY_OWN, planChanges, selectedIds } from '../../src/install/plan.js';
import { preset } from '../../src/install/preset.js';
import { loadPreset } from '../../src/catalog/presets.js';
import { LIMITS_SENTENCE } from '../../src/ai/report.js';
import { makeRepo } from './helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = join(pkgDir, 'dist');
const templatesDir = join(pkgDir, 'templates');
const catalog = loadCatalog().catalog;
const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
};
const OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'staff-reviewer', 'review-rubric', 'pr-ship', 'agents-md'];
const sel = (id: string, selected = true): Selected => ({ id, include: 'recommended', selected, reason: 'r', addresses: [], pin: '' });
const AI = { picks: '{}\n', report: '# R\n\n## Findings\n\nx\n\n## Limits\n\nsome\n', product: '# P\n' };

function plan(root: string, ids: string[], over: { off?: string[]; sandbox?: 'always'; recorded?: string[]; mcpRecorded?: string[]; files?: ReturnType<typeof install>['files']; cat?: typeof catalog; ai?: boolean } = {}) {
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = [...ids.map((i) => sel(i)), ...(over.off ?? []).map((i) => sel(i, false))];
  if (over.sandbox) config.sandbox = over.sandbox;
  return planChanges(root, config, facts, { version: '1.0.0', distDir, templatesDir, catalog: over.cat ?? catalog, recordedFiles: over.files, recorded: over.recorded, mcpRecorded: over.mcpRecorded, ...(over.ai ? { ai: AI } : {}) });
}
const install = (root: string, changes: Change[]) => applyChanges(root, changes, '1.0.0');
const blocksOf = (m: ReturnType<typeof install>, rel: string) => m.files.find((f) => f.rel === rel)?.blocks;
const get = (cs: Change[], rel: string) => cs.find((c) => c.rel === rel);
const text = (c: Change | undefined) => (c?.kind === 'create' ? c.content : c?.kind === 'update' ? c.after : '');

test('selectedIds returns the selected ids, or the legacy own items without items', () => {
  const config = preset(detect(makeRepo(REPO))).config;
  expect(selectedIds(config)).toEqual(LEGACY_OWN);
  config.items = [sel('a'), sel('b', false)];
  expect(selectedIds(config)).toEqual(['a']);
});

test('legacy config without items keeps the beta files', () => {
  const root = makeRepo(REPO);
  const facts = detect(root);
  const withCat = planChanges(root, preset(facts).config, facts, { version: '1.0.0', distDir, templatesDir, catalog });
  const without = planChanges(root, preset(facts).config, facts, { version: '1.0.0', distDir, templatesDir });
  expect(withCat.changes).toEqual(without.changes);
  const rels = without.changes.map((c) => c.rel);
  expect(rels).toEqual(expect.arrayContaining(['.harness/hooks/dispatch.mjs', '.harness/config.yaml', '.claude/agents/staff-reviewer.md', '.claude/skills/review-rubric/SKILL.md', '.claude/settings.json', 'AGENTS.md', '.gitignore', 'vitest.config.ts']));
  expect(rels.some((r) => r === '.harness/facts.json' || r === '.mcp.json')).toBe(false);
  expect(without.changes.some((c) => 'item' in c)).toBe(false);
});

test('deselecting staff-reviewer plans its removal; an edited file is kept with a note', () => {
  const root = makeRepo(REPO);
  const files = install(root, plan(root, OWN).changes).files;
  const off = plan(root, OWN.filter((i) => i !== 'staff-reviewer'), { off: ['staff-reviewer'], files });
  expect(off.changes.find((c) => c.rel === '.claude/agents/staff-reviewer.md')).toMatchObject({ kind: 'delete' });
  writeFileSync(join(root, '.claude/agents/staff-reviewer.md'), 'mine\n');
  const kept = plan(root, OWN.filter((i) => i !== 'staff-reviewer'), { off: ['staff-reviewer'], files });
  expect(get(kept.changes, '.claude/agents/staff-reviewer.md')).toBeUndefined();
  expect(kept.notes.join('\n')).toContain('.claude/agents/staff-reviewer.md` was edited since harness wrote it');
});

test('own files carry their item', () => {
  const root = makeRepo(REPO);
  expect(get(plan(root, OWN).changes, '.claude/agents/staff-reviewer.md')).toMatchObject({ kind: 'create', item: 'staff-reviewer' });
});

test('deselecting permissions-baseline turns checks.protect off and keeps all 34 deny rules', () => {
  const root = makeRepo(REPO);
  const p = plan(root, OWN.filter((i) => i !== 'permissions-baseline'), { off: ['permissions-baseline'] });
  expect(text(get(p.changes, '.harness/config.yaml'))).toMatch(/protect: false/);
  const deny = JSON.parse(text(get(p.changes, '.claude/settings.json'))).permissions.deny;
  const frag = JSON.parse(readFileSync(join(templatesDir, 'settings.fragment.json'), 'utf8')).permissions.deny;
  expect(frag).toHaveLength(34);
  expect(deny).toEqual(frag);
});

test('own items set checks: unselecting tdd-gate turns tdd off and edits no test config', () => {
  const root = makeRepo(REPO);
  const on = plan(root, OWN);
  expect(text(get(on.changes, '.harness/config.yaml'))).toMatch(/tdd: true/);
  expect(get(on.changes, 'vitest.config.ts')).toBeDefined();
  const off = plan(root, OWN.filter((i) => i !== 'tdd-gate'), { off: ['tdd-gate'] });
  expect(text(get(off.changes, '.harness/config.yaml'))).toMatch(/tdd: false/);
  expect(get(off.changes, 'vitest.config.ts')).toBeUndefined();
});

test('checks.prSize is on exactly when pr-ship is selected (AI path)', () => {
  const root = makeRepo(REPO);
  expect(text(get(plan(root, OWN, { ai: true }).changes, '.harness/config.yaml'))).toMatch(/prSize: true/);
  expect(text(get(plan(root, OWN.filter((i) => i !== 'pr-ship'), { off: ['pr-ship'], ai: true }).changes, '.harness/config.yaml'))).toMatch(/prSize: false/);
});

test('items never change sandbox', () => {
  const root = makeRepo(REPO);
  const p = plan(root, OWN, { sandbox: 'always' });
  expect(text(get(p.changes, '.harness/config.yaml'))).toMatch(/sandbox: always/);
  expect(blocksOf(install(root, p.changes), '.claude/settings.json')!.some((b) => JSON.parse(b).set?.[0] === 'sandbox')).toBe(true);
});

test('plugins, external skills and mcp servers install with the selection and are removed with it', () => {
  const root = makeRepo(REPO);
  const ids = [...OWN, 'impeccable', 'shadcn', 'mobile-mcp'];
  const m = install(root, plan(root, ids).changes);
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  const market = Object.keys(settings.extraKnownMarketplaces)[0];
  expect(market).toMatch(/^harness-pins-[0-9a-f]{8}$/);
  expect(Object.keys(settings.enabledPlugins).sort()).toEqual([`impeccable@${market}`, `shadcn@${market}`]);
  // a second repo gets its own name; re-planning this one keeps its name and changes nothing in settings
  const other = makeRepo(REPO);
  expect(plan(other, ids).market).not.toBe(market);
  const again = plan(root, ids, { recorded: blocksOf(m, '.claude/settings.json'), mcpRecorded: blocksOf(m, '.mcp.json') });
  expect(again.market).toBe(market);
  expect(get(again.changes, '.claude/settings.json')).toBeUndefined();
  expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers).toHaveProperty('mobile-mcp');
  expect(m.files.find((f) => f.rel === '.mcp.json')).toMatchObject({ kind: 'create' });
  // everything deselected: the settings and .mcp.json are rewritten and their old blocks dropped
  const back = plan(root, OWN, { off: ['impeccable', 'shadcn', 'mobile-mcp'], recorded: blocksOf(m, '.claude/settings.json'), mcpRecorded: blocksOf(m, '.mcp.json') });
  const s = get(back.changes, '.claude/settings.json');
  expect(s?.kind === 'update' && s.dropped?.length).toBeGreaterThan(0);
  expect(JSON.parse(text(s)).enabledPlugins).toBeUndefined();
  expect(JSON.parse(text(get(back.changes, '.mcp.json'))).mcpServers).toBeUndefined();
  expect(back.dropped.length).toBeGreaterThan(2);
});

test('removing the last plugin rewrites settings', () => {
  const root = makeRepo(REPO);
  const m = install(root, plan(root, [...OWN, 'impeccable']).changes);
  const back = plan(root, OWN, { off: ['impeccable'], recorded: blocksOf(m, '.claude/settings.json') });
  expect(get(back.changes, '.claude/settings.json')).toMatchObject({ kind: 'update' });
});

test('ai files are written and recorded', () => {
  const root = makeRepo(REPO);
  const p = plan(root, OWN, { ai: true });
  for (const rel of ['.harness/facts.json', '.harness/picks.json', '.harness/report.md', '.harness/context/product.md']) expect(get(p.changes, rel)).toMatchObject({ kind: 'create' });
  expect(text(get(p.changes, '.harness/report.md')).trimEnd().endsWith(LIMITS_SENTENCE)).toBe(true);
  const m = install(root, p.changes);
  expect(m.files.map((f) => f.rel)).toEqual(expect.arrayContaining(['.harness/facts.json', '.harness/picks.json', '.harness/report.md', '.harness/context/product.md']));
  expect(existsSync(join(root, '.harness/facts.json'))).toBe(true);
  expect(plan(root, OWN).changes.some((c) => c.rel === '.harness/facts.json')).toBe(false);
});

const OFF = OWN.filter((i) => i !== 'staff-reviewer');
const SR = '.claude/agents/staff-reviewer.md';

test('deselecting an item restores a file the person had before init', () => {
  const root = makeRepo({ ...REPO, [SR]: 'my reviewer\n' });
  const files = install(root, plan(root, OWN).changes).files;
  expect(readFileSync(join(root, SR), 'utf8')).not.toBe('my reviewer\n');
  const c = get(plan(root, OFF, { off: ['staff-reviewer'], files }).changes, SR);
  expect(c).toMatchObject({ kind: 'update', after: 'my reviewer\n' });
});

test('a pre-existing file equal to the template survives a deselect', () => {
  const root = makeRepo({ ...REPO, [SR]: readFileSync(join(templatesDir, 'agents/staff-reviewer.md'), 'utf8') });
  const files = install(root, plan(root, OWN).changes).files;
  const p = plan(root, OFF, { off: ['staff-reviewer'], files });
  expect(get(p.changes, SR)).toBeUndefined();
});

test('a file with no manifest entry is never deleted', () => {
  const root = makeRepo({ ...REPO, [SR]: readFileSync(join(templatesDir, 'agents/staff-reviewer.md'), 'utf8') });
  const p = plan(root, OFF, { off: ['staff-reviewer'], files: [] });
  expect(get(p.changes, SR)).toBeUndefined();
  expect(p.notes.join('\n')).toContain('not recorded');
});

test('a file from an older release is deleted by its recorded hash', () => {
  const root = makeRepo(REPO);
  const old = makeRepo({}, { git: false });
  cpSync(templatesDir, old, { recursive: true });
  writeFileSync(join(old, 'agents/staff-reviewer.md'), 'older release\n');
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = OWN.map((i) => sel(i));
  const first = planChanges(root, config, facts, { version: '1.0.0', distDir, templatesDir: old, catalog });
  const files = install(root, first.changes).files;
  expect(readFileSync(join(root, SR), 'utf8')).toBe('older release\n');
  expect(get(plan(root, OFF, { off: ['staff-reviewer'], files }).changes, SR)).toMatchObject({ kind: 'delete' });
});

test('the AI-path config keeps the person\'s comments', () => {
  const root = makeRepo(REPO);
  const files = install(root, plan(root, OWN).changes).files;
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8').replace('checks:', '# my note\nchecks:'));
  const c = get(plan(root, OWN.filter((i) => i !== 'tdd-gate'), { off: ['tdd-gate'], files }).changes, '.harness/config.yaml');
  expect(text(c)).toContain('# my note');
  expect(text(c)).toMatch(/tdd: false/);
  expect(c).not.toHaveProperty('rewrite');
});

test('an id missing from the catalog keeps its plugin and server', () => {
  const root = makeRepo(REPO);
  const m = install(root, plan(root, [...OWN, 'impeccable', 'mobile-mcp']).changes);
  const small = { ...catalog, items: catalog.items.filter((i) => i.id !== 'impeccable' && i.id !== 'mobile-mcp') };
  const p = plan(root, [...OWN, 'impeccable', 'mobile-mcp'], { cat: small, recorded: blocksOf(m, '.claude/settings.json'), mcpRecorded: blocksOf(m, '.mcp.json'), files: m.files });
  expect(p.notes.join('\n')).toContain('"impeccable" is not in this catalog; left as is');
  expect(p.dropped).toEqual([]);
  expect(get(p.changes, '.claude/settings.json')).toBeUndefined();
  expect(get(p.changes, '.mcp.json')).toBeUndefined();
});

test('deselecting agents-md removes the AGENTS.md block and the CLAUDE.md import', () => {
  const root = makeRepo({ ...REPO, 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '# C\n' });
  const files = install(root, plan(root, OWN).changes).files;
  const p = plan(root, OWN.filter((i) => i !== 'agents-md'), { off: ['agents-md'], files });
  expect(text(get(p.changes, 'AGENTS.md'))).toBe('# Mine\n');
  expect(text(get(p.changes, 'CLAUDE.md'))).toBe('# C\n');
});

test('a comment inside checks survives a flipped check, and the person\'s config is not recorded as rewritten', () => {
  const root = makeRepo(REPO);
  const files = install(root, plan(root, OWN).changes).files;
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8').replace('  tdd: true', '  tdd: true # keep me'));
  const c = get(plan(root, OWN.filter((i) => i !== 'tdd-gate'), { off: ['tdd-gate'], files }).changes, '.harness/config.yaml');
  expect(text(c)).toMatch(/tdd: false # keep me/);
  expect(c).not.toHaveProperty('rewrite');
});

test('a deselected file whose backup is missing gets its own note', () => {
  const root = makeRepo({ ...REPO, [SR]: 'mine\n' });
  const files = install(root, plan(root, OWN).changes).files.map((f) => (f.rel === SR ? { ...f, backup: '.harness/backup/gone/x' } : f));
  const p = plan(root, OFF, { off: ['staff-reviewer'], files });
  expect(p.notes.join('\n')).toContain('backup is missing');
});

// The personal preset (Task 6a): the `stacks` fixture on a Next.js repo.
const loadedStacks = (() => {
  const r = loadPreset(join(pkgDir, 'test/fixtures/presets/stacks.yaml'));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.loaded;
})();
const PRESET_ITEMS = ['core-rules', 'engineering-principles', 'frontend-react', 'frontend-nextjs'];
const SKILLS = ['engineering-principles', 'frontend-react', 'frontend-nextjs'].map((n) => `.claude/skills/${n}/SKILL.md`);
function planPreset(root: string, ids: string[], over: { off?: string[]; files?: ReturnType<typeof install>['files']; recorded?: string[]; on?: boolean; loaded?: boolean } = {}) {
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = [...ids.map((i) => sel(i)), ...(over.off ?? []).map((i) => sel(i, false))];
  if (over.on !== false) config.preset = { id: 'stacks', version: '1', items: PRESET_ITEMS, git: loadedStacks.preset.git };
  return planChanges(root, config, facts, { version: '1.0.0', distDir, templatesDir, catalog, recordedFiles: over.files, recorded: over.recorded, ...(over.loaded === false ? {} : { preset: loadedStacks }) });
}
const PIDS = [...OWN, 'superpowers', 'impeccable'];

test('the preset plan holds the core block, the skills and the settings keys', () => {
  const root = makeRepo({ ...REPO, 'AGENTS.md': '# Mine\n' });
  const p = planPreset(root, PIDS);
  const agents = text(get(p.changes, 'AGENTS.md'));
  expect(agents).toContain('<!-- harness:start -->');
  expect(agents).toContain('<!-- harness:preset:start -->');
  for (const rel of SKILLS) expect(get(p.changes, rel)).toMatchObject({ kind: 'create', item: 'preset:stacks' });
  expect(get(p.changes, '.claude/skills/frontend-react-native/SKILL.md')).toBeUndefined();
  const s = JSON.parse(text(get(p.changes, '.claude/settings.json')));
  expect(s.attribution).toBe(false);
  expect(s.env).toEqual({ DO_NOT_TRACK: '1', SUPERPOWERS_DISABLE_TELEMETRY: 'true' });
  expect(p.changes.filter((c) => c.rel === '.claude/settings.json' || c.rel === 'AGENTS.md')).toHaveLength(2);
});

test('without a preset the plan has no preset files or keys', () => {
  const root = makeRepo(REPO);
  const p = planPreset(root, PIDS, { on: false, loaded: false });
  expect(p.changes.some((c) => 'item' in c && String(c.item).startsWith('preset:'))).toBe(false);
  expect(text(get(p.changes, 'AGENTS.md'))).not.toContain('harness:preset');
  expect(JSON.parse(text(get(p.changes, '.claude/settings.json')))).not.toHaveProperty('attribution');
});

test('agents-md off with the preset on gives one AGENTS.md change with only the preset block', () => {
  const root = makeRepo({ ...REPO, 'AGENTS.md': '# Mine\n', 'CLAUDE.md': '# C\n' });
  const files = install(root, planPreset(root, PIDS).changes).files;
  const p = planPreset(root, PIDS.filter((i) => i !== 'agents-md'), { off: ['agents-md'], files });
  expect(p.changes.filter((c) => c.rel === 'AGENTS.md')).toHaveLength(1);
  const after = text(get(p.changes, 'AGENTS.md'));
  expect(after).not.toContain('<!-- harness:start -->');
  expect(after).toContain('<!-- harness:preset:start -->');
  expect(after.startsWith('# Mine\n')).toBe(true);
  const claude = get(p.changes, 'CLAUDE.md');
  expect(claude === undefined || text(claude).includes('@AGENTS.md')).toBe(true);
  expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');
});

test('agents-md off and no AGENTS.md still writes the preset block and the CLAUDE.md import', () => {
  const root = makeRepo(REPO);
  const p = planPreset(root, PIDS.filter((i) => i !== 'agents-md'), { off: ['agents-md'] });
  expect(text(get(p.changes, 'AGENTS.md'))).toContain('<!-- harness:preset:start -->');
  expect(text(get(p.changes, 'AGENTS.md'))).not.toContain('<!-- harness:start -->');
  expect(text(get(p.changes, 'CLAUDE.md'))).toContain('@AGENTS.md');
});

test('turning the preset off removes its skills, settings keys and AGENTS.md block', () => {
  const root = makeRepo({ ...REPO, 'AGENTS.md': '# Mine\n' });
  const m = install(root, planPreset(root, PIDS).changes);
  const recorded = blocksOf(m, '.claude/settings.json');
  const p = planPreset(root, PIDS, { on: false, loaded: false, files: m.files, recorded });
  for (const rel of SKILLS) expect(get(p.changes, rel)?.kind).toBe('delete');
  const s = JSON.parse(text(get(p.changes, '.claude/settings.json')));
  expect(s).not.toHaveProperty('attribution');
  expect(s).not.toHaveProperty('env');
  expect(text(get(p.changes, 'AGENTS.md'))).not.toContain('harness:preset');
  expect(p.changes.find((c) => c.rel === '.claude/settings.json')).toMatchObject({ dropped: expect.arrayContaining([expect.stringContaining('attribution')]) });
});

test('an edited preset skill is kept with a note when the preset goes', () => {
  const root = makeRepo(REPO);
  const files = install(root, planPreset(root, PIDS).changes).files;
  writeFileSync(join(root, SKILLS[1]), 'mine\n');
  const p = planPreset(root, PIDS, { on: false, loaded: false, files });
  expect(get(p.changes, SKILLS[1])).toBeUndefined();
  expect(p.notes.join('\n')).toContain(`\`${SKILLS[1]}\` was edited since harness wrote it`);
});

test('a recorded preset without its loaded folder is left alone', () => {
  const root = makeRepo(REPO);
  const files = install(root, planPreset(root, PIDS).changes).files;
  const p = planPreset(root, PIDS, { loaded: false, files });
  for (const rel of SKILLS) expect(get(p.changes, rel)).toBeUndefined();
});

test('a preset that is configured but not loaded leaves AGENTS.md, settings and skills alone', () => {
  for (const agentsMd of [true, false]) {
    // AGENTS.md absent at install: harness creates it, the case the old branch deletes.
    const root = makeRepo(REPO);
    const m = install(root, planPreset(root, PIDS).changes);
    const ids = agentsMd ? PIDS : PIDS.filter((i) => i !== 'agents-md');
    const p = planPreset(root, ids, { off: agentsMd ? [] : ['agents-md'], files: m.files, recorded: blocksOf(m, '.claude/settings.json'), loaded: false });
    expect(p.changes.filter((c) => c.kind === 'delete')).toEqual([]);
    for (const rel of ['AGENTS.md', '.claude/settings.json', ...SKILLS]) expect(get(p.changes, rel), `${rel} agents-md=${agentsMd}`).toBeUndefined();
  }
});
