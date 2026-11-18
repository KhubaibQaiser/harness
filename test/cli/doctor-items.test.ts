import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { doctor } from '../../src/cli/doctor.js';
import { loadConfig } from '../../src/core/config.js';
import { MIN_CLAUDE_CODE } from '../../src/core/min-claude.js';
import { writeHookEnv } from '../../src/core/hook-env.js';
import { makeRepo } from '../install/helpers.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { applyChanges } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
import { planChanges } from '../../src/install/plan.js';
import { preset } from '../../src/install/preset.js';
import type { pluginList } from '../../src/install/plugin-install.js';
import { pkgDir, REPO, withNode, hermetic, setConfig } from './doctor-helpers.js';

// ---- item checks (Task 24) ----
type PL = ReturnType<typeof pluginList>;

const OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'review-rubric', 'agents-md'];

const itemsRepo = (ids: string[], catalogVersion = loadCatalog().catalog.version) => {
  const root = makeRepo({ ...REPO, 'AGENTS.md': '# Mine\n' });
  const facts = detect(root);
  const config = preset(facts).config;
  config.catalog_version = catalogVersion;
  config.items = [...OWN, ...ids].map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' }));
  const ai = { picks: JSON.stringify({ catalog_version: 1, findings: [], items: [] }), report: '# R\n\n## Limits\n\nx\n', product: '# P\n' };
  applyChanges(root, planChanges(root, config, facts, { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir: join(pkgDir, 'templates'), catalog: loadCatalog().catalog, ai }).changes, '1.0.0');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: root });
  writeHookEnv(root);
  return root;
};

const runItems = (root: string, list: PL | (() => PL)) => {
  let out = '';
  let calls = 0;
  const code = doctor([], { root, env: { PATH: withNode() }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic(), pluginList: () => (calls++, typeof list === 'function' ? list() : list) });
  return { code, out, calls };
};

const pinsOf = (root: string): string => Object.keys(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).extraKnownMarketplaces).find((k) => k.startsWith('harness-pins'))!;

let CAVE = ''; // caveman's id in the repo the test made last

const caveRepo = (ids: string[]) => { const root = itemsRepo(ids); CAVE = `caveman@${pinsOf(root)}`; return root; };

const cave = (o: Partial<{ id: string; version: string; enabled: boolean }> = {}) => ({ id: CAVE, version: '4.0.1', enabled: true, ...o });

const editJson = (root: string, rel: string, f: (j: any) => void) => {
  const j = JSON.parse(readFileSync(join(root, rel), 'utf8'));
  f(j);
  writeFileSync(join(root, rel), JSON.stringify(j, null, 2) + '\n');
};

test('items: catalog line is ok at the repo version, a note when the package is newer', () => {
  const v = loadCatalog().catalog.version;
  expect(runItems(itemsRepo([]), []).out).toContain(`ok catalog ${v}\n`);
  expect(runItems(itemsRepo([], 0), []).out).toContain(`note catalog ${v} is newer than this repo's 0: run /harness:update\n`);
});

test('items: a deleted item file is a fix', () => {
  const root = itemsRepo(['staff-reviewer']);
  rmSync(join(root, '.claude/agents/staff-reviewer.md'));
  expect(runItems(root, []).out).toContain('fix staff-reviewer is missing .claude/agents/staff-reviewer.md: run /harness:sync\n');
});

test('items: a removed plugin entry is a fix, and one claude call serves all plugin checks', () => {
  const root = caveRepo(['caveman']);
  editJson(root, '.claude/settings.json', (j) => delete j.enabledPlugins[CAVE]);
  const r = runItems(root, [cave()]);
  expect(r.out).toContain('fix caveman is missing .claude/settings.json: run /harness:sync\n');
  expect(r.calls).toBe(1);
});

test('items: enabled but not installed is a fix; installed is not', () => {
  const root = caveRepo(['caveman']);
  expect(runItems(root, []).out).toContain(`fix ${CAVE} is enabled in this repo but not installed: claude plugin install ${CAVE} --scope project\n`);
  expect(runItems(root, [cave()]).out).not.toContain('not installed');
});

test('items: plugin version drift is a note; an unset plugin_version is skipped', () => {
  const root = caveRepo(['caveman']);
  expect(runItems(root, [cave({ version: '3.0.0' })]).out).toContain(`note ${CAVE} is 3.0.0, the catalog pins 4.0.1: run claude plugin update ${CAVE} --scope project\n`);
  expect(runItems(root, [cave()]).out).not.toContain('the catalog pins');
  const noPin = loadCatalog().catalog.items.find((i) => i.kind === 'plugin' && !i.plugin_version && i.source.type !== 'own')!;
  const root2 = itemsRepo([noPin.id]);
  const id = `${(noPin.source as { plugin: string }).plugin}@${pinsOf(root2)}`;
  expect(runItems(root2, [{ id, version: '9.9.9', enabled: true }]).out).not.toContain('the catalog pins');
});

test('items: the same plugin enabled from two marketplaces is a note', () => {
  const root = caveRepo(['caveman']);
  const r = runItems(root, [cave(), cave({ id: 'caveman@other' })]);
  expect(r.out).toContain(`note caveman is enabled twice (caveman@other and ${pinsOf(root)}); only one copy's hooks run. Disable one.\n`);
  expect(runItems(root, [cave(), cave({ id: 'caveman@other', enabled: false })]).out).not.toContain('enabled twice');
});

test('items: a pins entry whose content no longer matches its name is a fix; an edited MCP server is a note', () => {
  const a = caveRepo(['caveman']);
  const name = pinsOf(a);
  const fix = `fix the ${name} marketplace was edited, so its name no longer matches its pins and can clash with other repos on this machine: undo the edit, or delete that entry and run /harness:sync\n`;
  expect(runItems(a, [cave()]).out).not.toContain('was edited');
  editJson(a, '.claude/settings.json', (j) => { j.extraKnownMarketplaces[name].source.plugins[0].source.sha = 'f'.repeat(40); });
  const r = runItems(a, [cave()]);
  expect(r.out).toContain(fix);
  expect(r.code).toBe(1);
  expect(r.out).not.toContain(`note the ${name} marketplace differs`);
  const b = itemsRepo(['mobile-mcp']);
  editJson(b, '.mcp.json', (j) => { j.mcpServers['mobile-mcp'].args = ['-y', 'evil']; });
  expect(runItems(b, []).out).toContain('note a harness MCP server differs from what harness installed: run /harness:sync\n');
});

test('items: a field hand-added to a pinned plugin entry is a fix', () => {
  const a = caveRepo(['caveman']);
  const name = pinsOf(a);
  editJson(a, '.claude/settings.json', (j) => { j.extraKnownMarketplaces[name].source.plugins[0].strict = false; });
  const r = runItems(a, [cave()]);
  expect(r.out).toContain(`fix the ${name} marketplace was edited, so its name no longer matches its pins`);
  expect(r.code).toBe(1);
});

test('items: two content-named pins entries are a fix naming both, and the plugin checks are skipped', () => {
  const root = caveRepo(['caveman']);
  const name = pinsOf(root);
  editJson(root, '.claude/settings.json', (j) => { j.extraKnownMarketplaces['harness-pins-aaaaaaaaaaaa'] = j.extraKnownMarketplaces[name]; });
  const r = runItems(root, []);
  expect(r.out).toMatch(new RegExp(`fix \`\\.claude/settings\\.json\` has two harness pins marketplaces, (${name} and harness-pins-aaaaaaaaaaaa|harness-pins-aaaaaaaaaaaa and ${name}); keep the one your plugin keys use and delete the other: run /harness:sync\n`));
  expect(r.out).not.toContain('enabled in this repo but not installed');
});

test('items: settings keys are escaped in doctor output', () => {
  const root = caveRepo(['caveman']);
  editJson(root, '.claude/settings.json', (j) => { j.enabledPlugins['x\u001b[31m\r\nfix fake@harness-pins-aaaaaaaaaaaa'] = false; });
  const r = runItems(root, [cave()]);
  expect(r.out).toContain('x\\u001b[31m\\r\\nfix fake@harness-pins-aaaaaaaaaaaa');
  expect(r.out).not.toMatch(/[\u001b\r]/);
});

// An install from before content names: the same files with the shared name.
const toLegacy = (root: string) => {
  const own = pinsOf(root);
  for (const rel of ['.claude/settings.json', '.harness/manifest.json']) writeFileSync(join(root, rel), readFileSync(join(root, rel), 'utf8').replaceAll(own, 'harness-pins'));
};

test('items: the shared harness-pins name is a fix until update renames it', () => {
  const root = caveRepo(['caveman']);
  const old = "fix `.claude/settings.json` uses the shared `harness-pins` marketplace name, so another repo's pins can replace this repo's plugins: run /harness:update to rename it, then /harness:sync --install-plugins; when no repo on this machine still uses harness-pins, run claude plugin marketplace remove harness-pins\n";
  expect(runItems(root, [cave()]).out).not.toContain('shared `harness-pins`');
  toLegacy(root);
  const r = runItems(root, [cave({ id: 'caveman@harness-pins' })]);
  expect(r.out).toContain(old);
  expect(r.code).toBe(1);
  expect(r.out).not.toContain('caveman is missing .claude/settings.json'); // its key is there under the old name
  expect(r.out).not.toContain('enabled in this repo but not installed');
});

test('items: on a legacy install, a really missing plugin key and missing item files are still fixes', () => {
  const root = caveRepo(['caveman', 'staff-reviewer']);
  toLegacy(root);
  editJson(root, '.claude/settings.json', (j) => { delete j.enabledPlugins['caveman@harness-pins']; });
  rmSync(join(root, '.claude/agents/staff-reviewer.md'));
  const r = runItems(root, []);
  expect(r.out).toContain('fix caveman is missing .claude/settings.json: run /harness:sync\n');
  expect(r.out).toContain('fix staff-reviewer is missing .claude/agents/staff-reviewer.md: run /harness:sync\n');
});

test('items: a plugin key naming a pins marketplace the repo no longer has is a note', () => {
  const root = caveRepo(['caveman']);
  editJson(root, '.claude/settings.json', (j) => { j.enabledPlugins['gamma@harness-pins-aaaaaaaaaaaa'] = false; });
  expect(runItems(root, [cave()]).out).toContain('note `gamma@harness-pins-aaaaaaaaaaaa` names the harness-pins-aaaaaaaaaaaa marketplace, which this repo no longer has: remove it from .claude/settings.json\n');
});

test('items: config checks that differ from the selected items are a note', () => {
  const root = itemsRepo([]);
  expect(runItems(root, []).out).not.toContain('checks differ');
  setConfig(root, (s) => s.replace(/(\n\s+tdd: )true/, '$1false'));
  expect(runItems(root, []).out).toContain('note config.yaml checks differ from the selected items (tdd); the items win on the next update. Use /harness:add or harness remove to change gates.\n');
});

test('items: a hand-set check no catalog item owns (checks.done) is kept by the plan, so update leaves it on (ship audit S7)', () => {
  const root = itemsRepo([]);
  setConfig(root, (s) => s.replace(/(\n\s+done: )false/, '$1true'));
  expect(runItems(root, []).out).not.toContain('checks differ');
  const config = loadConfig(root).config;
  expect(config.checks.done).toBe(true);
  const planned = planChanges(root, config, detect(root), { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir: join(pkgDir, 'templates'), catalog: loadCatalog().catalog });
  expect(planned.config.checks.done).toBe(true);
  expect(planned.changes.find((c) => c.rel === '.harness/config.yaml')).toBeUndefined();
});

test('items: a missing or unreadable claude prints one note and skips the plugin checks', () => {
  const root = itemsRepo(['caveman']);
  const r = runItems(root, null);
  expect(r.out.match(/^note claude is missing/gm)).toHaveLength(1);
  expect(r.out).not.toContain('not installed');
  expect(r.out).toMatch(/^ok catalog /m);
});
