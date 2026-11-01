import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const script = resolve('scripts/install-local.mjs');
const run = (target: string, ...extra: string[]) =>
  spawnSync('node', [script, '--target', target, ...extra], { encoding: 'utf8' });
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'inst-'));
  cpSync('test/fixtures/install-repo', d, { recursive: true });
  mkdirSync(join(d, '.git'));
  return d;
};
const rd = (d: string, p: string) => readFileSync(join(d, p), 'utf8');
const FILES = ['.harness/hooks/dispatch.mjs', '.harness/config.yaml', '.claude/agents/staff-reviewer.md',
  '.claude/skills/review-rubric/SKILL.md', '.claude/settings.json', 'AGENTS.md', '.gitignore'];
const DISPATCH = 'node "${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"';

test('fixture install: old hooks gone, dispatcher + deny added, rest kept', () => {
  const d = repo();
  const r = run(d);
  expect(r.status).toBe(0);
  const s = JSON.parse(rd(d, '.claude/settings.json'));
  const text = rd(d, '.claude/settings.json');
  expect(text).not.toContain('guard.mjs');
  expect(text).not.toContain('stop-check.mjs');
  expect(text.endsWith('}\n')).toBe(true);
  expect(s.model).toBe('sonnet');
  expect(s.env).toEqual({ FOO: 'bar' });
  expect(s.permissions.allow).toEqual(['Bash(pnpm test:*)']);
  expect(s.permissions.deny.slice(0, 2)).toEqual(['Read(./secrets/**)', 'Read(./.env)']);
  expect(s.permissions.deny).toContain('Edit(./.claude/settings.json)');
  expect(s.permissions.deny.filter((x: string) => x === 'Read(./.env)')).toHaveLength(1);
  // Write group kept only its unrelated hook; Bash group dropped
  expect(s.hooks.PreToolUse.map((g: any) => g.matcher)).toEqual(['Write', 'Bash|Read|Grep|Edit|Write|MultiEdit|NotebookEdit']);
  expect(s.hooks.PreToolUse[0].hooks).toEqual([{ type: 'command', command: 'echo unrelated-pre', timeout: 5 }]);
  expect(s.hooks.PostToolUse).toHaveLength(2);
  expect(s.hooks.Stop).toHaveLength(1);
  expect(s.hooks.Stop[0].hooks[0].command).toBe(DISPATCH);
  expect(rd(d, '.gitignore')).toBe('node_modules/\ndist/\n.harness/state/\n.harness/logs/\n');
  for (const f of FILES) expect(existsSync(join(d, f))).toBe(true);
  expect(existsSync(join(d, '.cursor'))).toBe(false);
});

test('second run: all unchanged, bytes identical', () => {
  const d = repo();
  run(d);
  const before = FILES.map((f) => rd(d, f));
  const r = run(d);
  expect(r.status).toBe(0);
  const lines = r.stdout.trim().split('\n');
  expect(lines).toHaveLength(FILES.length);
  for (const l of lines) expect(l).toMatch(/^unchanged /);
  expect(FILES.map((f) => rd(d, f))).toEqual(before);
});

test('AGENTS.md: text outside markers is byte-identical, block replaced on rerun', () => {
  const d = repo();
  const orig = rd(d, 'AGENTS.md');
  run(d);
  const a = rd(d, 'AGENTS.md');
  expect(a.startsWith(orig + '\n<!-- harness:start -->')).toBe(true);
  // edit the block and add trailing text; rerun must restore the block and keep the outside text
  writeFileSync(join(d, 'AGENTS.md'), a.replace('## Harness workflow', 'STALE') + '\nTail text.\n');
  run(d);
  const b = rd(d, 'AGENTS.md');
  expect(b).toBe(a + '\nTail text.\n');
});

test('AGENTS.md missing: created with just the block', () => {
  const d = repo();
  require('node:fs').rmSync(join(d, 'AGENTS.md'));
  run(d);
  const a = rd(d, 'AGENTS.md');
  expect(a.startsWith('<!-- harness:start -->')).toBe(true);
  expect(a.trimEnd().endsWith('<!-- harness:end -->')).toBe(true);
});

test('single marker: fails, nothing written', () => {
  const d = repo();
  writeFileSync(join(d, 'AGENTS.md'), 'x\n<!-- harness:start -->\ny\n');
  const r = run(d);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/marker/);
  expect(existsSync(join(d, '.harness'))).toBe(false);
  expect(rd(d, '.claude/settings.json')).toContain('guard.mjs');
  expect(rd(d, 'AGENTS.md')).toBe('x\n<!-- harness:start -->\ny\n');
});

test('invalid settings JSON: fails, nothing written', () => {
  const d = repo();
  writeFileSync(join(d, '.claude/settings.json'), '{ nope');
  const r = run(d);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/settings\.json/);
  expect(rd(d, '.claude/settings.json')).toBe('{ nope');
  expect(existsSync(join(d, '.harness'))).toBe(false);
});

test('existing config.yaml is not overwritten', () => {
  const d = repo();
  mkdirSync(join(d, '.harness'));
  writeFileSync(join(d, '.harness/config.yaml'), 'mine: true\n');
  const r = run(d);
  expect(rd(d, '.harness/config.yaml')).toBe('mine: true\n');
  expect(r.stdout).toContain('unchanged .harness/config.yaml');
});

test('dry-run: prints plan, writes nothing', () => {
  const d = repo();
  const r = run(d, '--dry-run');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('create .harness/hooks/dispatch.mjs');
  expect(r.stdout).toContain('update .claude/settings.json');
  expect(r.stdout).toContain('update AGENTS.md');
  expect(existsSync(join(d, '.harness'))).toBe(false);
  expect(rd(d, '.claude/settings.json')).toContain('guard.mjs');
});

test('symlinked destination fails', () => {
  const d = repo();
  const o = mkdtempSync(join(tmpdir(), 'out-'));
  mkdirSync(join(d, '.harness'));
  require('node:fs').symlinkSync(o, join(d, '.harness/hooks'));
  const r = run(d);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/symlink/);
  expect(existsSync(join(o, 'dispatch.mjs'))).toBe(false);
});

test('non-repo target exits 2; missing --target exits 2', () => {
  const d = mkdtempSync(join(tmpdir(), 'nogit-'));
  expect(run(d).status).toBe(2);
  expect(spawnSync('node', [script], { encoding: 'utf8' }).status).toBe(2);
});

const S = '<!-- harness:start -->';
const E = '<!-- harness:end -->';
const noWrites = (d: string, settings = '{}') => {
  expect(existsSync(join(d, '.harness'))).toBe(false);
  expect(rd(d, '.claude/settings.json')).toBe(settings);
};

test.each([
  ['two full blocks', `${S}\na\n${E}\nmid\n${S}\nb\n${E}\n`],
  ['doubled start', `${S}\nuser text\n${S}\n${E}\n`],
  ['doubled end', `${S}\n${E}\n${E}\n`],
  ['end before start', `${E}\n${S}\n`],
])('AGENTS.md %s: fails, nothing written', (_n, text) => {
  const d = repo();
  writeFileSync(join(d, '.claude/settings.json'), '{}');
  writeFileSync(join(d, 'AGENTS.md'), text);
  const r = run(d);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/marker/);
  expect(r.stderr).not.toMatch(/\n\s+at /);
  expect(rd(d, 'AGENTS.md')).toBe(text);
  noWrites(d);
});

test.each([
  ['root array', '[]', /object/],
  ['hooks not object', '{"hooks":[]}', /hooks/],
  ['event not array', '{"hooks":{"Stop":{"a":1}}}', /Stop/],
  ['group not object', '{"hooks":{"Stop":[1]}}', /Stop/],
  ['deny not array', '{"permissions":{"deny":"x"}}', /deny/],
  ['permissions not object', '{"permissions":[]}', /permissions/],
])('settings %s: clear error, no stack, nothing written', (_n, json, re) => {
  const d = repo();
  writeFileSync(join(d, '.claude/settings.json'), json);
  const r = run(d);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(re);
  expect(r.stderr).not.toMatch(/\n\s+at /);
  noWrites(d, json);
});

test('unknown flag: usage, exit 2, no stack', () => {
  const r = run(repo(), '--bogus');
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/usage/i);
  expect(r.stderr).not.toMatch(/\n\s+at /);
});

test('missing dist: "run pnpm build first"', () => {
  const root = mkdtempSync(join(tmpdir(), 'nodist-'));
  mkdirSync(join(root, 'scripts'));
  cpSync(script, join(root, 'scripts/install-local.mjs'));
  const d = repo();
  const r = spawnSync('node', [join(root, 'scripts/install-local.mjs'), '--target', d], { encoding: 'utf8' });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('run pnpm build first');
  expect(existsSync(join(d, '.harness'))).toBe(false);
});
