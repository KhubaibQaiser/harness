import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
