import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect } from 'vitest';
import { realpathSync, rmSync } from 'node:fs';
import { makeRepo } from '../install/helpers.js';

// Temp names with a space and a non-ASCII letter, to catch quoting and encoding bugs in every path the harness builds.
export const PREFIX = 'harness e2e ü-';

const pj = (o: object) => JSON.stringify(o, null, 2) + '\n';
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
const VITEST_CFG = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n";

export interface Fixture {
  name: string;
  files: Record<string, string>;
  /** A source file under a TDD path (JS fixtures only) and the test file whose result JSON unlocks it. */
  tdd?: { file: string; test: string };
  /** A file the first edit touches in a non-TDD fixture. */
  first: string;
  /** False for the no-tests fixture: no node -e steps are written, the preset's own (empty) steps stay. */
  steps: boolean;
}

export const npmVitest = (): Fixture => ({
  name: 'npm + Vitest',
  files: {
    'package.json': pj({ name: 'n', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.0.0' } }),
    'package-lock.json': '{}\n',
    'vitest.config.ts': VITEST_CFG,
    '.gitignore': 'node_modules\n',
    'src/a.ts': 'export const a = 1;\n',
  },
  tdd: { file: 'src/a.ts', test: 'src/a.test.ts' },
  first: 'src/a.ts',
  steps: true,
});

export const pnpmMonorepo = (): Fixture => ({
  name: 'pnpm monorepo + Vitest',
  files: {
    'package.json': pj({ name: 'root', packageManager: 'pnpm@9.0.0' }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    '.gitignore': 'node_modules\n',
    'packages/a/package.json': pj({ name: 'a', devDependencies: { vitest: '^2.0.0' } }),
    'packages/b/package.json': pj({ name: 'b', scripts: { test: 'vitest' }, devDependencies: { vitest: '^2.0.0' } }),
    'packages/b/vitest.config.mts': VITEST_CFG,
    'packages/b/src/a.ts': 'export const a = 1;\n',
  },
  tdd: { file: 'packages/b/src/a.ts', test: 'packages/b/src/a.test.ts' },
  first: 'packages/b/src/a.ts',
  steps: true,
});

export const yarnJest = (): Fixture => ({
  name: 'yarn + Jest',
  files: {
    'package.json': pj({ name: 'y', scripts: { test: 'jest' }, devDependencies: { jest: '^29.0.0' } }),
    'yarn.lock': '',
    'jest.config.js': 'module.exports = {};\n',
    '.gitignore': 'node_modules\n',
    'src/a.ts': 'export const a = 1;\n',
  },
  tdd: { file: 'src/a.ts', test: 'src/a.test.ts' },
  first: 'src/a.ts',
  steps: true,
});

export const bunVitest = (): Fixture => ({
  name: 'bun + Vitest',
  files: {
    'package.json': pj({ name: 'bn', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.0.0' } }),
    'bun.lock': '',
    'vitest.config.ts': VITEST_CFG,
    '.gitignore': 'node_modules\n',
    'src/a.ts': 'export const a = 1;\n',
  },
  tdd: { file: 'src/a.ts', test: 'src/a.test.ts' },
  first: 'src/a.ts',
  steps: true,
});

export const pythonPytestRuff = (): Fixture => ({
  name: 'Python + pytest + ruff',
  files: {
    'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n[tool.ruff]\nline-length = 100\n',
    'app/main.py': 'def main():\n    return 1\n',
  },
  first: 'app/main.py',
  steps: true,
});

export const noTests = (): Fixture => ({
  name: 'repo with no tests',
  files: {
    'package.json': pj({ name: 'x', scripts: { build: 'tsc' } }),
    'src/index.ts': 'export {};\n',
  },
  first: 'src/index.ts',
  steps: false,
});

/** Other tools' hooks, CLAUDE.md and AGENTS.md, all with CRLF line endings. */
export const existingCrlf = (): Fixture => ({
  name: 'existing setup with CRLF',
  files: {
    'CLAUDE.md': '# Mine\r\n\r\nMy rules.\r\n',
    'AGENTS.md': '# Agents\r\n',
    'package.json': crlf(pj({ name: 'crlf', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.0.0' } })),
    'package-lock.json': '{}\r\n',
    'vitest.config.ts': crlf(VITEST_CFG),
    '.gitignore': 'node_modules\r\n',
    '.claude/settings.json': crlf(pj({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] } })),
    '.claude/settings.local.json': crlf(pj({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }] } })),
    'src/a.ts': 'export const a = 1;\r\n',
  },
  first: 'src/a.ts',
  steps: true,
});

/** A vitest config the installer cannot edit safely: a custom `root` changes where outputFile resolves. */
export const unsafeVitest = (): Fixture => ({
  name: 'unsafe vitest config',
  files: {
    'package.json': pj({ name: 'u', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.0.0' } }),
    'package-lock.json': '{}\n',
    'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { root: './src' } });\n",
    '.gitignore': 'node_modules\n',
    'src/a.ts': 'export const a = 1;\n',
  },
  first: 'src/a.ts',
  steps: true,
});

export const standard = [npmVitest, pnpmMonorepo, yarnJest, bunVitest, pythonPytestRuff, noTests];

/** Builds the fixture as a git repo (one commit) in a temp dir named with a space and ü. Returns the realpath. */
export function build(f: Fixture): string {
  return realpathSync(makeRepo(f.files, { prefix: PREFIX }));
}

export const cleanup = (root: string): void => rmSync(root, { recursive: true, force: true });

export const DISPATCH = '.harness/hooks/dispatch.mjs';

/** Pipes hook JSON into a repo's installed dispatcher. `hook` returns the parsed output, or null for "no output". */
export function hookRunner(env: NodeJS.ProcessEnv) {
  const hook = (root: string, input: Record<string, unknown>) => {
    const r = spawnSync('node', [join(root, DISPATCH)], { cwd: root, encoding: 'utf8', env, input: JSON.stringify({ session_id: 's1', cwd: root, ...input }) });
    expect(r.status).toBe(0);
    return r.stdout ? (JSON.parse(r.stdout) as any) : null;
  };
  const pre = (root: string, tool_name: string, tool_input: Record<string, unknown>) => hook(root, { hook_event_name: 'PreToolUse', tool_name, tool_input });
  const verdict = (d: any): { decision: string; reason: string } =>
    d?.hookSpecificOutput ? { decision: d.hookSpecificOutput.permissionDecision, reason: d.hookSpecificOutput.permissionDecisionReason } : { decision: d ? d.decision : 'allow', reason: d?.reason ?? '' };
  return { hook, pre, verdict };
}
