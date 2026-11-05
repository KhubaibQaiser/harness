import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { preset } from '../../src/cli/preset.js';
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
