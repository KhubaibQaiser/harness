import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadCatalog } from '../../src/catalog/load.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { applyChanges, readManifest } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
import { planChanges } from '../../src/install/plan.js';
import { preset } from '../../src/install/preset.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const templatesDir = join(pkgDir, 'templates');
const WF = '.github/workflows/harness-gitleaks.yml';
const tpl = readFileSync(join(templatesDir, 'ci/gitleaks.yml'), 'utf8');
const ci = readFileSync(join(pkgDir, '.github/workflows/ci.yml'), 'utf8');
const AI = { picks: '{"catalog_version":1,"findings":[],"items":[]}', report: '# R\n\n## Limits\n\nx\n', product: '# P\n' };

function plan(root: string, ids: string[]) {
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = ids.map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' }));
  return planChanges(root, config, facts, { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir, catalog: loadCatalog().catalog, ai: AI, recordedFiles: readManifest(root)?.files });
}

test('the workflow pins the same gitleaks version and checksum as this repo\'s CI', () => {
  const sum = (t: string) => /echo "([0-9a-f]{64}) {2}\$f" \| sha256sum -c -/.exec(t)?.[1];
  const ver = (t: string) => /\bv=(\d+\.\d+\.\d+)\n/.exec(t)?.[1];
  expect(sum(tpl)).toBe('551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb');
  expect(sum(tpl)).toBe(sum(ci));
  expect(ver(tpl)).toBe('8.30.1');
  expect(ver(tpl)).toBe(ver(ci));
  expect(tpl).toContain('83d9cd684c87d95d656c1458ef04895a7f1cbd8e'); // the v8.30.1 tag commit, recorded beside the checksum
  expect(tpl).toContain('persist-credentials: false');
  expect(tpl).toContain('fetch-depth: 0');
  expect(tpl).toContain('./gitleaks git --redact');
  for (const s of ['--ignore-gitleaks-allow', '--config "$RUNNER_TEMP/gitleaks.toml"', '--gitleaks-ignore-path "$RUNNER_TEMP/gitleaksignore"', 'GIT_ATTR_SOURCE="$(git hash-object -t tree /dev/null)"', 'GIT_ATTR_NOSYSTEM=1', "printf '[extend]\\nuseDefault = true\\n'"]) expect(tpl, s).toContain(s);
  expect(tpl).toMatch(/permissions:\n {2}contents: read\n/);
  for (const u of tpl.matchAll(/uses: (\S+)/g)) expect(u[1]).toMatch(/@[0-9a-f]{40}$/);
});

test('plan and apply write the workflow; uninstall removes it', async () => {
  const root = makeRepo({ 'package.json': '{"name":"app"}\n', '.gitignore': 'node_modules\n' });
  const p = plan(root, ['gitleaks-ci']);
  expect(p.changes).toContainEqual(expect.objectContaining({ kind: 'create', rel: WF, content: tpl.replace(/\r\n/g, '\n'), item: 'gitleaks-ci' }));
  applyChanges(root, p.changes, '1.0.0');
  expect(readFileSync(join(root, WF), 'utf8')).toBe(tpl.replace(/\r\n/g, '\n'));
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: root });
  let out = '';
  const code = await uninstall([], { env: {}, root, out: (s) => (out += s + '\n'), prompt: { async confirm() { return true; }, async edit(_l, v) { return v; } } });
  expect(code, out).toBe(0);
  expect(existsSync(join(root, WF))).toBe(false);
});

test('a plan without gitleaks-ci drops the workflow it wrote', () => {
  const root = makeRepo({ 'package.json': '{"name":"app"}\n' });
  applyChanges(root, plan(root, ['gitleaks-ci']).changes, '1.0.0');
  expect(plan(root, ['stop-gate']).changes).toContainEqual(expect.objectContaining({ kind: 'delete', rel: WF }));
});

test('gitleaks-commit turns on the secret-scan check and nothing else', () => {
  const root = makeRepo({ 'package.json': '{"name":"app"}\n' });
  const c = plan(root, ['gitleaks-commit']).config.checks;
  expect(Object.entries(c).filter(([, v]) => v).map(([k]) => k)).toEqual(['secretScan']);
});

test('the recommend guidance picks gitleaks-ci for api and infra, optional elsewhere', () => {
  const it = loadCatalog().catalog.items.find((i) => i.id === 'gitleaks-ci')!;
  expect(it.kind).toBe('ci');
  expect(it.stance).toBe('optional');
  expect(it.applies_when).toEqual({ always: true });
  expect(it.side_effects).toEqual(['downloads-binary']);
  const guide = readFileSync(join(pkgDir, 'skills/init/recommend.md'), 'utf8');
  expect(guide).toContain('- gitleaks-ci: recommend it (`include: recommended`) when the project type is `api` or `infra`; elsewhere list it as optional.');
});
