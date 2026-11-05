import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
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
