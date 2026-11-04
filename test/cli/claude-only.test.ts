import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { insideClaude, refuseOutsideClaude } from '../../src/cli/claude-only.js';
import { run } from '../../src/cli/index.js';
import { init, type Prompt } from '../../src/cli/init.js';
import { update } from '../../src/cli/update.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = { version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') };
const prompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const msg = (cmd: string) => `Run /harness:${cmd} inside Claude Code. The harness supports Claude Code only for now.`;

test('each AI command refuses without CLAUDECODE', async () => {
  for (const cmd of ['init', 'update', 'add', 'sync'] as const) expect(refuseOutsideClaude(cmd, {}, false)).toBe(msg(cmd));
  const root = makeRepo({ 'package.json': '{}\n' });
  for (const [name, fn] of [['init', init], ['update', update]] as const) {
    let out = '';
    expect(await fn(['--yes'], { ...base, env: {}, root, out: (s) => (out += s + '\n'), prompt })).toBe(2);
    expect(out.trim()).toBe(msg(name));
  }
});

test('any non-empty CLAUDECODE counts as inside, for the gate and for tdd off', async () => {
  expect(insideClaude({ CLAUDECODE: '0' })).toBe(true);
  expect(insideClaude({ CLAUDECODE: '' })).toBe(false);
  expect(refuseOutsideClaude('init', { CLAUDECODE: '0' }, false)).toBeNull();
  const root = mkdtempSync(join(tmpdir(), 'h-claude-only-'));
  mkdirSync(join(root, '.harness'));
  let out = '';
  expect(run(['tdd', 'off'], { root, env: { CLAUDECODE: '0' }, out: (s) => (out += s) })).toBe(1);
  expect(out).toContain('plain terminal');
});

test('HARNESS_PLAIN_INIT takes the plain path with no AI flags, whatever CLAUDECODE is; AI flags override it', () => {
  expect(refuseOutsideClaude('init', { HARNESS_PLAIN_INIT: '1' }, false)).toBeNull();
  expect(refuseOutsideClaude('update', { HARNESS_PLAIN_INIT: '1', CLAUDECODE: '1' }, false)).toBeNull();
  expect(refuseOutsideClaude('init', { HARNESS_PLAIN_INIT: '1' }, true)).toBe(msg('init'));
  expect(refuseOutsideClaude('init', { HARNESS_PLAIN_INIT: '1', CLAUDECODE: '1' }, true)).toBeNull();
});

test('update --check works without CLAUDECODE', async () => {
  const root = makeRepo({ 'package.json': '{}\n' });
  let out = '';
  const fetchImpl = (async () => new Response(JSON.stringify({ version: '1.2.3' }))) as unknown as typeof fetch;
  expect(await update(['--check'], { ...base, env: {}, root, out: (s) => (out += s), prompt, fetchImpl })).toBe(0);
  expect(out).not.toContain('inside Claude Code');
});

test('init refuses without HARNESS_PLAIN_INIT outside Claude Code', async () => {
  const root = makeRepo({ 'package.json': '{}\n' });
  let out = '';
  expect(await init(['--yes'], { ...base, env: {}, root, out: (s) => (out += s), prompt })).toBe(2);
  expect(out).toContain('inside Claude Code');
});
