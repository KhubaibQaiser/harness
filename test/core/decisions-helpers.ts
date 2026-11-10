// Shared by the decision sync tests: an installed temp repo and one-call sync.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { init, type Prompt } from '../../src/cli/init.js';
import { defaults } from '../../src/core/config.js';
import { serializeDecision, type TeamDecision } from '../../src/core/decision-file.js';
import { commitDecisions, planSync, readDecisions } from '../../src/core/decisions.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(__dirname, '..', '..');
export const TODAY = '2026-11-10';
const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
  'AGENTS.md': '# Mine\n',
};
const prompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };

export async function installedRepo(version = '1.0.0'): Promise<string> {
  const root = makeRepo(REPO);
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version, templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  return root;
}

export const decision = (id: string, over: Partial<TeamDecision> = {}): Omit<TeamDecision, 'rel'> => ({
  id, title: `Title ${id}`, status: 'active', paths: ['src/env/**'], verified_at: '4f0c2a9e1b7d3c5a6e8f0a1b2c3d4e5f6a7b8c9d', verified_on: '2026-11-03', body: '**Rule:** Do it.\n', ...over,
});

export function writeDecision(root: string, d: Omit<TeamDecision, 'rel'>): void {
  const p = join(root, 'docs/decisions', `${d.id}.md`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, serializeDecision(d));
}

/** What `remember sync` does: read, plan, commit. */
export function syncNow(root: string, today = TODAY) {
  const plan = planSync(root, readDecisions(root, today), defaults().decisions, today);
  commitDecisions(root, [], plan, { now: () => new Date(`${today}T12:00:00Z`) });
  return plan;
}
