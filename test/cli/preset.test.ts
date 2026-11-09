import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { preset, presetInstall } from '../../src/cli/preset.js';
import { NO_TTY } from '../../src/cli/prompt.js';
import { run } from '../../src/cli/index.js';

afterEach(() => vi.unstubAllEnvs());

const tmp = () => mkdtempSync(join(tmpdir(), 'harness-cli-preset-'));
const go = (args: string[], root = '/') => {
  const lines: string[] = [];
  const code = preset(args, { root, env: {}, out: (s) => lines.push(s) }) as number;
  return { code, out: lines.join('\n') };
};
const copyTiny = (name = 'tiny') => {
  const d = tmp();
  cpSync('test/fixtures/presets/tiny.yaml', join(d, `${name}.yaml`));
  cpSync('test/fixtures/presets/tiny', join(d, 'tiny'), { recursive: true });
  return d;
};
/** A fake package catalog whose presets/ holds a copy of tiny. */
function shipTiny() {
  const c = tmp();
  cpSync('catalog', c, { recursive: true });
  rmSync(join(c, 'presets'), { recursive: true, force: true }); // only tiny, not the shipped presets
  cpSync(copyTiny(), join(c, 'presets'), { recursive: true });
  vi.stubEnv('HARNESS_CATALOG_DIR', c);
  vi.stubEnv('HARNESS_PLAIN_INIT', '1');
  return join(c, 'presets');
}

test('list prints id and description, or No presets.', () => {
  const root = tmp();
  vi.stubEnv('HARNESS_CATALOG_DIR', tmp());
  vi.stubEnv('HARNESS_PLAIN_INIT', '1');
  expect(go(['list'], root)).toEqual({ code: 0, out: 'No presets.' });
  const sd = shipTiny();
  expect(go(['list'], root).out).toBe('tiny  Smallest valid preset.');
  expect(sd).toBeTruthy();
});

test('check: ok on tiny, one error per line on a broken copy, usage otherwise', () => {
  const d = copyTiny();
  expect(go(['check', d])).toEqual({ code: 0, out: 'ok' });
  writeFileSync(join(d, 'tiny/templates/core.md'), 'ask jane@example.com\n');
  const bad = go(['check', d]);
  expect(bad.code).toBe(1);
  expect(bad.out.split('\n')).toEqual([expect.stringContaining('contains an email address')]);
  expect(go(['check']).code).toBe(2);
  expect(go(['nope']).code).toBe(2);
  expect(go(['check', join(d, 'missing')]).code).toBe(1);
});

test('check: a file is not a folder, and control characters in errors are escaped', () => {
  const d = copyTiny();
  expect(go(['check', join(d, 'tiny.yaml')])).toEqual({ code: 1, out: expect.stringContaining('not a folder') });
  writeFileSync(join(d, 'tiny.yaml'), readFileSync(join(d, 'tiny.yaml'), 'utf8').replace('- ponytail', '- "a\\u001b[31m\\u202eb"'));
  const r = go(['check', d]);
  expect(r.code).toBe(1);
  expect(r.out).not.toMatch(/[\u0000-\u001f\u202e]/u);
  expect(r.out).toContain('a');
});

test('check reports the shipped-id clash outside catalog/presets, not inside', () => {
  const sd = shipTiny();
  const out = go(['check', copyTiny()]);
  expect(out.code).toBe(1);
  expect(out.out).toContain('preset id "tiny" is already a shipped preset');
  expect(go(['check', sd])).toEqual({ code: 0, out: 'ok' });
});

test('run routes preset', () => {
  const lines: string[] = [];
  expect(run(['preset', 'bogus'], { root: '/', env: {}, out: (s) => lines.push(s) })).toBe(2);
  expect(lines[0]).toContain('harness preset check <dir>');
});

const install = async (args: string[], root: string, o: { tty?: boolean; yes?: boolean } = {}) => {
  const lines: string[] = [];
  const asked: string[] = [];
  const code = await presetInstall(args, { root, env: {}, tty: o.tty, out: (s) => lines.push(s), prompt: { confirm: async (q) => (asked.push(q), o.yes ?? false), edit: async (_l, v) => v } });
  return { code, out: lines.join('\n'), asked };
};

test('install --dry-run lists the files and writes nothing; --yes copies, then list shows repo', async () => {
  const d = copyTiny();
  const root = tmp();
  const dry = await install([d, '--dry-run'], root);
  expect(dry.code).toBe(0);
  expect(dry.out).toContain('.harness/presets/tiny.yaml');
  expect(dry.out).toContain('.harness/presets/tiny/templates/core.md');
  expect(existsSync(join(root, '.harness'))).toBe(false);
  const r = await install([d, '--yes'], root);
  expect(r.code).toBe(0);
  expect(readFileSync(join(root, '.harness/presets/tiny/templates/core.md'), 'utf8')).toBe(readFileSync(join(d, 'tiny/templates/core.md'), 'utf8'));
  expect(go(['list'], root).out).toContain('tiny  Smallest valid preset.  (repo)');
});

test('install with no flag asks; yes copies, no copies nothing, no terminal exits 2', async () => {
  const d = copyTiny();
  const a = tmp(), b = tmp(), c = tmp();
  expect((await install([d], a, { yes: true })).asked).toHaveLength(1);
  expect(existsSync(join(a, '.harness/presets/tiny.yaml'))).toBe(true);
  expect((await install([d], b, { yes: false })).code).toBe(0);
  expect(existsSync(join(b, '.harness'))).toBe(false);
  expect(await install([d], c, { tty: false })).toMatchObject({ code: 2, out: NO_TTY });
  expect(existsSync(join(c, '.harness'))).toBe(false);
});

test('install refuses a folder that fails check, and an existing install', async () => {
  const d = copyTiny();
  writeFileSync(join(d, 'tiny/templates/core.md'), 'ask jane@example.com\n');
  const root = tmp();
  const bad = await install([d, '--yes'], root);
  expect(bad.code).toBe(1);
  expect(bad.out).toContain('contains an email address');
  expect(existsSync(join(root, '.harness'))).toBe(false);
  const ok = copyTiny();
  mkdirSync(join(root, '.harness/presets/tiny'), { recursive: true });
  const dup = await install([ok, '--yes'], root);
  expect(dup).toMatchObject({ code: 1, out: '.harness/presets/tiny/ already exists; remove it first.' });
  expect(existsSync(join(root, '.harness/presets/tiny.yaml'))).toBe(false);
  expect((await install([], root)).code).toBe(2);
});

test('install refuses a symlink anywhere in the preset (the check gate), naming it, and writes nothing', async () => {
  const outside = tmp();
  writeFileSync(join(outside, 'secret.txt'), 'x');
  const cases: [string, (d: string) => void][] = [
    ['link.md', (d) => symlinkSync(join(outside, 'secret.txt'), join(d, 'tiny/templates/link.md'))],
    ['linkdir', (d) => symlinkSync(outside, join(d, 'tiny/templates/linkdir'))],
    ['tiny', (d) => { cpSync(join(d, 'tiny'), join(outside, 'tiny'), { recursive: true }); rmSync(join(d, 'tiny'), { recursive: true }); symlinkSync(join(outside, 'tiny'), join(d, 'tiny')); }],
    ['tiny.yaml', (d) => { cpSync(join(d, 'tiny.yaml'), join(outside, 'tiny.yaml')); rmSync(join(d, 'tiny.yaml')); symlinkSync(join(outside, 'tiny.yaml'), join(d, 'tiny.yaml')); }],
  ];
  for (const [name, mk] of cases) {
    const d = copyTiny();
    mk(d);
    const root = tmp();
    const r = await install([d, '--yes'], root);
    expect(r.code, name).toBe(1);
    expect(r.out, name).toContain(name === 'tiny.yaml' ? 'tiny.yaml: not a regular file (symlinks are not followed)' : `${name}: symlink not followed`);
    expect(existsSync(join(root, '.harness')), name).toBe(false);
  }
});

test('built CLI: install from a subdirectory writes to the repo root, and list shows it', () => {
  const root = tmp();
  spawnSync('git', ['init', '-q'], { cwd: root });
  const sub = join(root, 'sub');
  mkdirSync(sub);
  const cli = join(process.cwd(), 'dist/cli.mjs');
  const r = spawnSync('node', [cli, 'preset', 'install', copyTiny(), '--yes'], { cwd: sub, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(existsSync(join(root, '.harness/presets/tiny.yaml'))).toBe(true);
  expect(existsSync(join(sub, '.harness'))).toBe(false);
  const l = spawnSync('node', [cli, 'preset', 'list'], { cwd: sub, encoding: 'utf8' });
  expect(l.stdout).toContain('tiny  Smallest valid preset.  (repo)');
});

const retarget = (d: string, skill: string, to: string) => {
  const p = join(d, `tiny/items/${skill}.yaml`);
  writeFileSync(p, readFileSync(p, 'utf8').replace(`to: .claude/skills/${skill}/SKILL.md`, `to: ${to}`));
};

test('check refuses a skill file outside its own .claude/skills/<name>/ folder, naming the path', () => {
  for (const to of ['.git/hooks/pre-commit', '.claude/settings.json', '.claude/skills/beta/SKILL.md', '.claude/skills/alpha', '.claude/skills/alpha/./SKILL.md', '.claude/skills/alpha//SKILL.md']) {
    const d = copyTiny();
    retarget(d, 'alpha', to);
    const r = go(['check', d]);
    expect(r.code, to).toBe(1);
    expect(r.out, to).toContain('must be under .claude/skills/alpha/');
    expect(r.out, to).toContain(JSON.stringify(to).slice(1, -1));
  }
  for (const to of ['.claude/skills/alpha/../beta/SKILL.md', '.claude/skills/alpha/x\\y.md']) { // the schema's relPath refuses these first
    const d = copyTiny();
    retarget(d, 'alpha', to);
    expect(go(['check', d]), to).toMatchObject({ code: 1, out: expect.stringContaining('alpha.yaml: source.files[0].to: must be a relative path') });
  }
  const ok = copyTiny();
  retarget(ok, 'alpha', '.claude/skills/alpha/refs/more.md');
  expect(go(['check', ok]).out).toBe('ok');
});
