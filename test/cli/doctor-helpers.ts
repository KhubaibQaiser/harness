import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../../src/cli/doctor.js';
import { init, type Prompt } from '../../src/cli/init.js';
import { MIN_CLAUDE_CODE } from '../../src/core/min-claude.js';
import { writeHookEnv } from '../../src/core/hook-env.js';
import { makeRepo } from '../install/helpers.js';

export const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { vitest: '^1.0.0', '@vitest/coverage-v8': '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
};
export const prompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
export const installed = async (prefix?: string) => {
  const root = makeRepo(REPO, prefix ? { prefix } : {});
  await init(['--yes'], { env: { PATH: bin('npm'), HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist'), platform: 'linux' });
  writeHookEnv(root); // as if a hook had run
  return root;
};
// node must be on PATH for the dispatcher self-test.
export const withNode = (p?: string) => [p, dirname(process.execPath)].filter(Boolean).join(delimiter);
export const bin = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), 'h-bin-'));
  writeFileSync(join(d, name), '#!/bin/sh\n');
  chmodSync(join(d, name), 0o755);
  writeFileSync(join(d, `${name}.cmd`), '@echo off\n'); // what findOnPath looks for on Windows
  return d;
};
// The machine probes and the user/managed settings never come from this host: CI's Ubuntu restricts user namespaces.
export const HOME = mkdtempSync(join(tmpdir(), 'h-home-'));
export const SRT_STUB = fileURLToPath(new URL('../../build.mjs', import.meta.url));
export const srtProbe = { which: (c: string) => (c === 'srt' ? SRT_STUB : `/usr/bin/${c}`), version: () => '0.0.83\n' };
export const hermetic = (o: { read?: (p: string) => string | null; home?: string; managed?: string } = {}) => ({ read: o.read ?? (() => null), home: o.home ?? HOME, managed: o.managed ?? join(HOME, 'no-managed.json'), srt: srtProbe, bwrapVersion: () => 'bubblewrap 0.9.0' });
export const run = (root: string, o: { claude?: string | null; path?: string; platform?: NodeJS.Platform; read?: (p: string) => string | null; home?: string; managed?: string; env?: NodeJS.ProcessEnv } = {}) => {
  let out = '';
  const code = doctor([], { root, env: { PATH: withNode(o.path), ...o.env }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => (o.claude === undefined ? MIN_CLAUDE_CODE : o.claude), platform: o.platform, ...hermetic(o) });
  return { code, out, lines: out.trim().split('\n') };
};
export const setConfig = (root: string, edit: (s: string) => string) => {
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, edit(readFileSync(p, 'utf8')));
};
