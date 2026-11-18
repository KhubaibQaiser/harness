import type { FsLike } from '../../src/install/apply.js';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, type Prompt } from '../../src/cli/init.js';
import { update } from '../../src/cli/update.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { applyChanges, readManifest } from '../../src/install/apply.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { detect } from '../../src/install/detect.js';
import { planChanges } from '../../src/install/plan.js';
import { preset } from '../../src/install/preset.js';
import { sha256 } from '../../src/install/text.js';
import { betaSettings, makeRepo } from '../install/helpers.js';
import { execFileSync } from 'node:child_process';

export const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const templatesDir = join(pkgDir, 'templates');
export const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
  'AGENTS.md': '# Mine\n',
};
export const fake = (answers: boolean[] = []): Prompt & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, async confirm(q) { asked.push(q); return answers.length ? answers.shift()! : false; }, async edit(_l, v) { return v; } };
};
/** A copy of dist whose dispatcher differs, standing in for the next release. */
export const newDist = () => {
  const d = mkdtempSync(join(tmpdir(), 'harness-dist-'));
  cpSync(join(pkgDir, 'dist'), d, { recursive: true });
  const p = join(d, 'hooks', 'dispatch.mjs');
  writeFileSync(p, readFileSync(p, 'utf8') + '\n// v2\n');
  return d;
};
/** Commits everything, as a user does before update (update refuses uncommitted changes to files it touches). */
export const commitAll = (root: string) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
};
export const installed = async (files: Record<string, string> = REPO) => {
  const root = makeRepo(files);
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt: fake(), version: '1.0.0', templatesDir, distDir: join(pkgDir, 'dist') , platform: 'linux' });
  commitAll(root);
  return root;
};
export const up = async (root: string, args: string[], over: { distDir?: string; version?: string; prompt?: Prompt; fetchImpl?: typeof fetch; fs?: FsLike } = {}) => {
  let out = '';
  const code = await update(args, { env: { HARNESS_PLAIN_INIT: '1' }, root, out: (s) => (out += s + '\n'), prompt: over.prompt ?? fake(), version: over.version ?? '1.1.0', templatesDir, distDir: over.distDir ?? join(pkgDir, 'dist'), fetchImpl: over.fetchImpl, fs: over.fs });
  return { code, out };
};
export const DISPATCH = '.harness/hooks/dispatch.mjs';
export const snapshot = (root: string) => [DISPATCH, '.harness/manifest.json', 'AGENTS.md', '.claude/settings.json'].map((r) => readFileSync(join(root, r), 'utf8'));
export const un = async (root: string) => {
  let out = '';
  const code = await uninstall(['--yes'], { env: {}, root, out: (s) => (out += s + '\n'), prompt: fake() });
  return { code, out };
};
/** Makes the installed settings.json and its manifest blocks the beta release's, as an install from that release left them. */
export const betaInstall = (root: string, pre: object) => {
  const { s, blocks } = betaSettings(pre);
  const text = JSON.stringify(s, null, 2) + '\n';
  writeFileSync(join(root, '.claude/settings.json'), text);
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const f = m.files.find((x: { rel: string }) => x.rel === '.claude/settings.json');
  f.blocks = blocks;
  f.hash = sha256(text);
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  commitAll(root);
  return blocks;
};
export const SETTINGS = '.claude/settings.json';
export const settingsBlocks = (root: string) => readManifest(root)!.files.find((f) => f.rel === SETTINGS)!.blocks!;
// The recommend flow's install: the plan carries the selected items, and update and uninstall follow the manifest.
export const OWN_IDS = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'staff-reviewer', 'review-rubric', 'pr-ship', 'agents-md'];
export const aiInstalled = (files: Record<string, string>, ids: string[]) => {
  const root = makeRepo(files);
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = ids.map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' }));
  const ai = { picks: '{}\n', report: '# R\n\n## Limits\n\nx\n', product: '# P\n' };
  const plan = planChanges(root, config, facts, { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir, catalog: loadCatalog().catalog, ai });
  applyChanges(root, plan.changes, '1.0.0');
  commitAll(root);
  return root;
};
