import * as nodeFs from 'node:fs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { GLOBAL_STATE, presetInstall } from '../../src/cli/preset.js';
import { NO_TTY } from '../../src/cli/prompt.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { PRESET_START } from '../../src/install/merge.js';
import { hashText } from '../../src/install/text.js';

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
  expect(r.out).toMatch(/Always-loaded at user scope, if you take every write: ~\d+ tokens \(estimate\)/);
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
  const first = await run([copyTiny(), '--global', '--yes', '--take', '.claude/CLAUDE.md'], home);
  expect(first.code).toBe(0);
  expect(first.out.split('\n').at(-1)).toBe('Installed tiny under ~/.claude: 1 of 11 writes, listed in ~/.claude/harness/manifest.json. Remove them with `harness uninstall --global`.');
  const before = snapshot(home);
  const again = await run([copyTiny(), '--global', '--dry-run'], home);
  expect(again).toMatchObject({ code: 1, out: 'A global preset is already installed (tiny): ~/.claude/harness/manifest.json exists. Run `harness uninstall --global` first, or keep the installed preset.' });
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
  const m = await run([copyTiny(), '--global', '--dry-run'], home, { env: { HARNESS_CLAUDE_CONFIG_DIR: '/elsewhere' } });
  expect(m).toMatchObject({ code: 1, out: 'HARNESS_CLAUDE_CONFIG_DIR is set to /elsewhere, so Claude Code would not read ~/.claude. Unset it, or install the preset at repo level.' });
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

test('a skill file outside .claude/skills/<name>/ is refused before any prompt, and home is unchanged', async () => {
  for (const to of ['Library/LaunchAgents/x.plist', '.claude/hooks/x', '.claude/harness/manifest.json', '.claude/CLAUDE.md']) {
    const d = copyTiny();
    const p = join(d, 'tiny/items/alpha.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('to: .claude/skills/alpha/SKILL.md', `to: ${to}`));
    const home = tmp();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude/CLAUDE.md'), '# Mine\n');
    const before = snapshot(home);
    const r = await run([d, '--global', '--yes', '--take', to], home);
    expect(r.code, to).toBe(1);
    expect(r.out, to).toContain(`"${to}" must be under .claude/skills/alpha/`);
    expect(r.asked, to).toEqual([]);
    expect(snapshot(home), to).toEqual(before);
    expect(existsSync(join(home, 'Library')), to).toBe(false);
  }
});

test('CLAUDE_CONFIG_DIR written as a literal ~/.claude is the home folder', async () => {
  const r = await run([copyTiny(), '--global', '--dry-run'], tmp(), { env: { CLAUDE_CONFIG_DIR: '~/.claude' } });
  expect(r.code).toBe(0);
  expect(r.out).toContain('if you take every write');
});

/** Every folder and file under `d` (files with their text): an uninstall must bring this back exactly. */
const tree = (d: string): Record<string, string | null> =>
  Object.fromEntries(readdirSync(d, { recursive: true, withFileTypes: true }).map((e) => [join(e.parentPath, e.name).slice(d.length + 1), e.isFile() ? readFileSync(join(e.parentPath, e.name), 'utf8') : null]));
const un = async (args: string[], home: string, o: { tty?: boolean; answer?: boolean } = {}) => {
  const lines: string[] = [];
  const asked: string[] = [];
  const code = await uninstall(args, { root: tmp(), home, env: {}, tty: o.tty, out: (s) => lines.push(s), prompt: { confirm: async (q) => (asked.push(q), o.answer ?? false), edit: async (_l, v) => v } });
  return { code, out: lines.join('\n'), asked };
};
/** Installs tiny globally with every write taken. */
const installAll = async (home: string) => {
  const preview = await run([copyTiny(), '--global', '--dry-run'], home);
  const take = preview.out.split('\n').filter((l) => l.startsWith('  ~/')).map((l) => l.slice(4));
  const r = await run([copyTiny(), '--global', '--yes', '--take', take.join(',')], home);
  expect(r.code, r.out).toBe(0);
  return take;
};

test('install records the folders it created, and not the ones that were there', async () => {
  const home = tmp();
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  await installAll(home);
  const m = JSON.parse(readFileSync(join(home, GLOBAL_STATE.manifest), 'utf8'));
  expect(m.dirs).toContain('.claude/skills/alpha');
  expect(m.dirs).toContain('.claude/harness/presets/tiny/templates');
  expect(m.dirs).not.toContain('.claude');
  expect(m.dirs).not.toContain('.claude/skills');
});

test('install then uninstall --global leaves home byte-identical: edited files restored, empty folders kept', async () => {
  const home = tmp();
  mkdirSync(join(home, '.claude/skills'), { recursive: true }); // an empty folder the person already had
  mkdirSync(join(home, 'empty'));
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# Mine\n');
  writeFileSync(join(home, '.claude/settings.json'), '{"theme":"dark"}\n');
  const before = tree(home);
  await installAll(home);
  expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toContain('attribution');
  const r = await un(['--global', '--yes'], home);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Restored `~/.claude/CLAUDE.md`');
  expect(r.out).toContain('Removed `~/.claude/skills/alpha/SKILL.md`');
  expect(tree(home)).toEqual(before);
  expect(existsSync(join(home, '.claude/harness'))).toBe(false);
  expect(Object.keys(tree(home)).some((p) => p.split(/[\\/]/).includes('.harness'))).toBe(false);
});

test('install then uninstall --global on an empty home leaves no ~/.claude', async () => {
  const home = tmp();
  await installAll(home);
  expect((await un(['--global', '--yes'], home)).code).toBe(0);
  expect(readdirSync(home)).toEqual([]);
});

test('files edited after install: blocks removed, edits kept, an edited skill kept unless --force', async () => {
  const home = tmp();
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# Mine\n');
  writeFileSync(join(home, '.claude/settings.json'), '{"theme":"dark"}\n');
  await installAll(home);
  writeFileSync(join(home, '.claude/CLAUDE.md'), readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8') + 'Later line.\n');
  const s = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ ...s, model: 'x' }, null, 2) + '\n');
  writeFileSync(join(home, '.claude/skills/alpha/SKILL.md'), 'my edit\n');
  const r = await un(['--global', '--yes'], home);
  expect(r.code, r.out).toBe(0);
  const md = readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8');
  expect(md).toContain('# Mine');
  expect(md).toContain('Later line.');
  expect(md).not.toContain(PRESET_START);
  expect(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))).toEqual({ theme: 'dark', model: 'x' });
  expect(readFileSync(join(home, '.claude/skills/alpha/SKILL.md'), 'utf8')).toBe('my edit\n');
  expect(r.out).toContain('Kept `~/.claude/skills/alpha/SKILL.md` because you edited them.');
  expect(r.out.split('\n').filter((l) => l.startsWith('Note:') || l.startsWith('Kept')).every((l) => !/`\.claude\//.test(l))).toBe(true);
  expect(existsSync(join(home, '.claude/skills/beta'))).toBe(false);
  expect(existsSync(join(home, GLOBAL_STATE.manifest))).toBe(false);
  expect(existsSync(join(home, '.claude/harness'))).toBe(false);

  const again = tmp();
  await installAll(again);
  writeFileSync(join(again, '.claude/skills/alpha/SKILL.md'), 'my edit\n');
  expect((await un(['--global', '--yes', '--force'], again)).code).toBe(0);
  expect(readdirSync(again)).toEqual([]);
});

test('uninstall --global with no global manifest exits 1', async () => {
  const r = await un(['--global', '--yes'], tmp());
  expect(r).toMatchObject({ code: 1, out: 'No global preset is installed (no ~/.claude/harness/manifest.json).' });
});

test('uninstall --global --dry-run lists the removals and writes nothing; no terminal and no --yes exits 2; a no keeps everything', async () => {
  const home = tmp();
  await installAll(home);
  const before = tree(home);
  const dry = await un(['--global', '--dry-run'], home);
  expect(dry.code).toBe(0);
  expect(dry.out).toContain('Would remove `~/.claude/CLAUDE.md`');
  expect(dry.out).toContain('Dry run: nothing was written.');
  expect(await un(['--global'], home, { tty: false })).toMatchObject({ code: 2, out: NO_TTY });
  const no = await un(['--global'], home, { tty: true, answer: false });
  expect(no).toMatchObject({ code: 0, out: 'Cancelled. Nothing was removed.' });
  expect(no.asked).toEqual(['Remove the global preset from ~/.claude? (y/N)']);
  expect(tree(home)).toEqual(before);
});

const editManifest = (home: string, f: (m: { dirs?: unknown; files: Record<string, unknown>[] }) => void) => {
  const p = join(home, GLOBAL_STATE.manifest);
  const m = JSON.parse(readFileSync(p, 'utf8'));
  f(m);
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
};

test('a tampered global manifest is refused whole, naming the entry, and home is unchanged', async () => {
  const cases: [string, (m: { dirs?: unknown; files: Record<string, unknown>[] }) => void][] = [
    ['"Documents"', (m) => { m.dirs = 'Documents'; }],
    ['"a"', (m) => { m.dirs = 'a'; }],
    ['5', (m) => { m.dirs = [...(m.dirs as string[]), 5]; }],
    ['"Documents"', (m) => { m.dirs = [...(m.dirs as string[]), 'Documents']; }],
    ['"Documents/x.txt"', (m) => { m.files.push({ rel: 'Documents/x.txt', kind: 'create', hash: hashText('precious\n') }); }],
    ['".claude/x\\\\..\\\\..\\\\Documents"', (m) => { m.dirs = [...(m.dirs as string[]), '.claude/x\\..\\..\\Documents']; }],
    ['".claude/harness/backup//x"', (m) => { m.files[0].backup = '.claude/harness/backup//x'; }],
    ['".claude/a\\u0000b"', (m) => { m.dirs = [...(m.dirs as string[]), '.claude/a\u0000b']; }],
    ['".claude/skills/a\\u001bb"', (m) => { m.files[0].rel = '.claude/skills/a\u001bb'; }],
    ['".claude/harness/manifest.json"', (m) => { m.files[0].rel = '.claude/harness/manifest.json'; }],
    ['".claude/harness/apply.lock"', (m) => { m.files[0].rel = '.claude/harness/apply.lock'; }],
    ['".claude/harness/backup/x/y"', (m) => { m.files[0].rel = '.claude/harness/backup/x/y'; }],
  ];
  for (const [named, edit] of cases) {
    const home = tmp();
    mkdirSync(join(home, 'Documents'));
    mkdirSync(join(home, 'a'));
    writeFileSync(join(home, 'Documents/x.txt'), 'precious\n');
    await installAll(home);
    editManifest(home, edit);
    const before = tree(home);
    const r = await un(['--global', '--yes'], home);
    expect(r.code, named).toBe(1);
    expect(r.out, named).toBe(`\`~/.claude/harness/manifest.json\` lists ${named}, which is not a path under ~/.claude, so nothing was removed.`);
    expect(tree(home), named).toEqual(before);
  }
});

test('a re-run after a crash that left the manifest is byte-identical: settings are not re-serialised', async () => {
  const home = tmp();
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/CLAUDE.md'), '# Mine\n');
  writeFileSync(join(home, '.claude/settings.json'), '{"theme":"dark"}\n');
  const before = tree(home);
  await installAll(home);
  const manifest = readFileSync(join(home, GLOBAL_STATE.manifest), 'utf8');
  expect((await un(['--global', '--yes'], home)).code).toBe(0);
  // The crash: files restored and backups gone, but the manifest still there.
  mkdirSync(join(home, GLOBAL_STATE.dir), { recursive: true });
  writeFileSync(join(home, GLOBAL_STATE.manifest), manifest);
  const r = await un(['--global', '--yes'], home);
  expect(r.code, r.out).toBe(0);
  expect(tree(home)).toEqual(before);
});

test('a lock left by an interrupted uninstall --global is refused with the global recovery steps', async () => {
  const home = tmp();
  await installAll(home);
  writeFileSync(join(home, GLOBAL_STATE.lock), '.claude/harness/manifest.json\n');
  const before = tree(home);
  const r = await un(['--global', '--yes'], home);
  expect(r.code).toBe(1);
  expect(r.out).toContain('A previous global preset install or uninstall was interrupted');
  expect(tree(home)).toEqual(before);
});

test('the cleanup after the restore runs under the lock: a crash there leaves it, and the next run stops', async () => {
  const home = tmp();
  await installAll(home);
  const lock = join(home, GLOBAL_STATE.lock), manifest = join(home, GLOBAL_STATE.manifest);
  // Crash on the manifest delete, after the files were restored.
  const fs = { ...nodeFs, rmSync: (p: nodeFs.PathLike, o?: nodeFs.RmOptions) => { if (p === manifest) { expect(existsSync(lock)).toBe(true); throw new Error('crash'); } nodeFs.rmSync(p, o); } };
  await expect(uninstall(['--global', '--yes'], { root: tmp(), home, env: {}, fs, out: () => {}, prompt: { confirm: async () => true, edit: async (_l, v) => v } })).rejects.toThrow('crash');
  expect(existsSync(lock)).toBe(true);
  expect((await un(['--global', '--yes'], home)).out).toContain('install or uninstall was interrupted');
});
