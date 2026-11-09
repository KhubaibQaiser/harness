import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { GLOBAL_STATE, presetInstall } from '../../src/cli/preset.js';
import { NO_TTY } from '../../src/cli/prompt.js';
import { PRESET_START } from '../../src/install/merge.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'harness-preset-global-'));
const copyTiny = () => {
  const d = tmp();
  cpSync('test/fixtures/presets/tiny.yaml', join(d, 'tiny.yaml'));
  cpSync('test/fixtures/presets/tiny', join(d, 'tiny'), { recursive: true });
  return d;
};
/** Every file under `d` with its text: a dry run must leave this unchanged. */
const snapshot = (d: string): Record<string, string> =>
  Object.fromEntries(readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), 'utf8')]));
const run = async (args: string[], home: string, o: { tty?: boolean; answer?: (q: string) => boolean; env?: Record<string, string> } = {}) => {
  const lines: string[] = [];
  const asked: string[] = [];
  const code = await presetInstall(args, { root: tmp(), home, env: o.env ?? {}, tty: o.tty, out: (s) => lines.push(s), prompt: { confirm: async (q) => (asked.push(q), o.answer?.(q) ?? false), edit: async (_l, v) => v } });
  return { code, out: lines.join('\n'), asked };
};
const WRITES = ['.claude/CLAUDE.md', '.claude/skills/alpha/SKILL.md', '.claude/skills/beta/SKILL.md', '.claude/settings.json', '.claude/harness/presets/tiny.yaml', '.claude/harness/presets/tiny/templates/core.md'];

test('GLOBAL_STATE keeps the manifest, backups and lock under ~/.claude/harness', () => {
  expect(GLOBAL_STATE).toEqual({ dir: '.claude/harness', manifest: '.claude/harness/manifest.json', backup: '.claude/harness/backup', lock: '.claude/harness/apply.lock' });
});

test('--dry-run prints every global path, the diffs and the always-loaded total, and writes nothing', async () => {
  const home = tmp();
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# Mine\n');
  const before = snapshot(home);
  const r = await run([copyTiny(), '--global', '--dry-run'], home);
  expect(r.code).toBe(0);
  const lines = r.out.split('\n');
  expect(lines[0]).toBe('Global writes (each needs its own yes):');
  for (const w of WRITES) expect(r.out).toContain(`~/${w}`);
  expect(r.out).toContain(`+${PRESET_START}`);
  expect(r.out).toContain('+Fixture core block.');
  expect(r.out).toContain('"attribution": false');
  expect(r.out).not.toContain('"env"');
  expect(r.out).toMatch(/Always-loaded at user scope: ~\d+ tokens \(estimate\)/);
  expect(r.asked).toEqual([]);
  expect(snapshot(home)).toEqual(before);
});

test('in a terminal it asks once per path; a no is neither written nor recorded', async () => {
  const home = tmp();
  const r = await run([copyTiny(), '--global'], home, { tty: true, answer: (q) => !q.includes('beta') });
  expect(r.code).toBe(0);
  expect(r.asked.length).toBe(WRITES.length + 5); // the other tiny/ files are paths too
  expect(new Set(r.asked).size).toBe(r.asked.length);
  expect(existsSync(join(home, '.claude/skills/beta/SKILL.md'))).toBe(false);
  expect(readFileSync(join(home, '.claude/skills/alpha/SKILL.md'), 'utf8')).toContain('Use alpha.');
  expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toContain('Fixture core block.');
  expect(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))).toEqual({ attribution: false });
  const m = JSON.parse(readFileSync(join(home, GLOBAL_STATE.manifest), 'utf8'));
  const rels = m.files.map((f: { rel: string }) => f.rel);
  expect(rels).toContain('.claude/skills/alpha/SKILL.md');
  expect(rels).not.toContain('.claude/skills/beta/SKILL.md');
  expect(m.files.every((f: { item: string }) => f.item === 'preset:tiny')).toBe(true);
  expect(existsSync(join(home, '.harness'))).toBe(false);
});

test('no terminal and no flag exits 2 with the no-terminal message', async () => {
  const home = tmp();
  expect(await run([copyTiny(), '--global'], home, { tty: false })).toMatchObject({ code: 2, out: expect.stringContaining(NO_TTY) });
  expect(readdirSync(home)).toEqual([]);
});

test('--yes writes only the --take paths plus the manifest; --yes without --take exits 2', async () => {
  const home = tmp();
  const bare = await run([copyTiny(), '--global', '--yes'], home);
  expect(bare).toMatchObject({ code: 2, out: '--yes needs --take <path,...>: name each global write you approved.' });
  expect(readdirSync(home)).toEqual([]);
  const r = await run([copyTiny(), '--global', '--yes', '--take', '.claude/CLAUDE.md'], home);
  expect(r.code).toBe(0);
  expect(r.asked).toEqual([]);
  const files = Object.keys(snapshot(home)).map((p) => p.slice(home.length + 1).split('\\').join('/')).sort();
  expect(files).toEqual(['.claude/CLAUDE.md', '.claude/harness/manifest.json']);
});

test('--take naming a path that is not a global write exits 2 and writes nothing', async () => {
  const home = tmp();
  const r = await run([copyTiny(), '--global', '--yes', '--take', '.claude/other.md'], home);
  expect(r).toMatchObject({ code: 2, out: expect.stringContaining('.claude/other.md is not one of the global writes') });
  expect(readdirSync(home)).toEqual([]);
});

test('an existing ~/.claude/CLAUDE.md is backed up under ~/.claude/harness/backup/, never ~/.harness/', async () => {
  const home = tmp();
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# Mine\n');
  const r = await run([copyTiny(), '--global', '--yes', '--take', '.claude/CLAUDE.md'], home);
  expect(r.code).toBe(0);
  expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toMatch(/^# Mine\n/);
  const backups = Object.entries(snapshot(join(home, GLOBAL_STATE.backup)));
  expect(backups).toEqual([[expect.stringMatching(/[\\/]\.claude[\\/]CLAUDE\.md$/), '# Mine\n']]);
  expect(existsSync(join(home, '.harness'))).toBe(false);
});

test('a second install while the global manifest exists is refused', async () => {
  const home = tmp();
  expect((await run([copyTiny(), '--global', '--yes', '--take', '.claude/CLAUDE.md'], home)).code).toBe(0);
  const before = snapshot(home);
  const again = await run([copyTiny(), '--global', '--dry-run'], home);
  expect(again).toMatchObject({ code: 1, out: 'A global preset is already installed (tiny). Run harness uninstall --global first.' });
  expect(snapshot(home)).toEqual(before);
});

test('a left lock is refused with recovery steps that name ~/.claude/harness, not .harness or git', async () => {
  const home = tmp();
  mkdirSync(join(home, GLOBAL_STATE.dir), { recursive: true });
  writeFileSync(join(home, GLOBAL_STATE.lock), '.claude/CLAUDE.md\n');
  const r = await run([copyTiny(), '--global', '--yes', '--take', '.claude/CLAUDE.md'], home);
  expect(r.code).toBe(1);
  expect(r.out).toContain('~/.claude/harness/apply.lock');
  expect(r.out).toContain('~/.claude/harness/backup/');
  expect(r.out).not.toMatch(/`\.harness\/|git status/);
  expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(false);
});

test('CLAUDE_CONFIG_DIR set elsewhere is refused; set to ~/.claude it is fine', async () => {
  const home = tmp();
  const r = await run([copyTiny(), '--global', '--dry-run'], home, { env: { CLAUDE_CONFIG_DIR: '/elsewhere' } });
  expect(r).toMatchObject({ code: 1, out: 'CLAUDE_CONFIG_DIR is set to /elsewhere, so Claude Code would not read ~/.claude. Unset it, or install the preset at repo level.' });
  expect((await run([copyTiny(), '--global', '--dry-run'], home, { env: { CLAUDE_CONFIG_DIR: join(home, '.claude') } })).code).toBe(0);
});

test('a symlinked ~/.claude is refused, naming the path, and nothing is written', async () => {
  const home = tmp(), real = tmp();
  symlinkSync(real, join(home, '.claude'));
  const r = await run([copyTiny(), '--global', '--yes', '--take', '.claude/CLAUDE.md'], home);
  expect(r.code).toBe(1);
  expect(r.out).toContain('refusing symlink: .claude/CLAUDE.md');
  expect(r.out).toContain('Nothing was written.');
  expect(readdirSync(real)).toEqual([]);
});

test('a folder with two presets is refused for --global', async () => {
  const d = copyTiny();
  cpSync('test/fixtures/presets/stacks.yaml', join(d, 'stacks.yaml'));
  cpSync('test/fixtures/presets/stacks', join(d, 'stacks'), { recursive: true });
  const r = await run([d, '--global', '--dry-run'], tmp());
  expect(r).toMatchObject({ code: 2, out: 'A global install takes a folder with one preset; this one has 2.' });
});
