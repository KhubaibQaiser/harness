import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { stopDenyWritePaths } from '../../../src/checks/protect.js';
import { expandHome, renderSrtSettings, type SrtInputs, tempRoots, writableRoots } from '../../../src/checks/stop/srt-settings.js';
import { defaults } from '../../../src/core/config.js';
import { CREDENTIAL_ENV, credentialFiles } from '../../../src/core/credentials.js';
import { within } from '../../../src/core/paths.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'srt-home-')));
const mk = (o: Partial<SrtInputs> = {}, stop: Partial<SrtInputs['stop']> = {}): SrtInputs => ({
  root: '/repo', stop: { ...defaults().stop, ...stop }, home, tmp: ['/tmp'], tokenBase: null, denyWrite: [], denyRead: [], ...o,
});
const keys = (v: unknown, out: string[] = []): string[] => {
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) { out.push(k); keys(x, out); }
  else if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  return out;
};

describe('within', () => {
  test('equal, inside, and path boundary', () => {
    expect(within('/a/b', '/a/b', 'linux')).toBe(true);
    expect(within('/a/b/c', '/a/b', 'linux')).toBe(true);
    expect(within('/a/bc', '/a/b', 'linux')).toBe(false);
    expect(within('/a', '/a/b', 'linux')).toBe(false);
  });
  test('case folds on darwin and win32 only', () => {
    expect(within('/A/B/c', '/a/b', 'darwin')).toBe(true);
    expect(within('/A/B/c', '/a/b', 'linux')).toBe(false);
    expect(within('C:\\A\\b', 'c:\\a', 'win32')).toBe(true);
  });
});

describe('srt settings', () => {
  test('every key name from the srt README, and no allowRead anywhere', () => {
    const s = renderSrtSettings(mk({ tokenBase: '/run/u/harness/gh' }, { allowed_domains: ['a.io'] }));
    const k = keys(s);
    expect(new Set(k)).toEqual(new Set(['network', 'allowedDomains', 'allowLocalBinding', 'filesystem', 'allowWrite', 'denyWrite', 'denyRead', 'path', 'literal', 'credentials', 'files', 'envVars', 'mode', 'name']));
    expect(JSON.stringify(s)).not.toMatch(/allowRead/);
  });
  test('allowWrite = repo realpath, temp roots and allow_write, all literal', () => {
    const d = mkdtempSync(join(realpathSync(tmpdir()), 'srt-'));
    mkdirSync(join(d, 'cache'));
    const s = renderSrtSettings(mk({ tmp: ['/tmp', '/var/t'] }, { allow_write: [join(d, 'cache'), '~/c2'] }));
    expect(s.filesystem.allowWrite).toEqual([
      { path: '/repo', literal: true }, { path: '/tmp', literal: true }, { path: '/var/t', literal: true },
      { path: join(d, 'cache'), literal: true }, { path: join(home, 'c2'), literal: true }]);
  });
  test('denyWrite = stopDenyWritePaths() joined to the repo realpath, plus token base and extras', () => {
    const s = renderSrtSettings(mk({ tokenBase: '/run/u/harness/gh', denyWrite: ['/repo/.harness/state/srt-1.json'] }));
    expect(s.filesystem.denyWrite).toEqual([
      ...stopDenyWritePaths().map((p) => ({ path: join('/repo', p), literal: true })),
      { path: '/run/u/harness/gh', literal: true }, { path: '/repo/.harness/state/srt-1.json', literal: true }]);
  });
  test('denyRead = token base and extras', () => {
    expect(renderSrtSettings(mk({ tokenBase: '/t/gh', denyRead: ['/x'] })).filesystem.denyRead).toEqual([{ path: '/t/gh', literal: true }, { path: '/x', literal: true }]);
  });
  test('credentials from credentialFiles and CREDENTIAL_ENV, mode deny', () => {
    const c = renderSrtSettings(mk()).credentials;
    expect(c.files).toEqual(credentialFiles(home).files.map((path) => ({ path, mode: 'deny' })));
    expect(c.envVars).toEqual(CREDENTIAL_ENV.map((name) => ({ name, mode: 'deny' })));
  });
  test('allowedDomains from config, normalised and deduped; allowLocalBinding from allow_local', () => {
    const s = renderSrtSettings(mk({}, { allowed_domains: ['Registry.NpmJS.org.', ' registry.npmjs.org ', 'b.io'], allow_local: true }));
    expect(s.network).toEqual({ allowedDomains: ['registry.npmjs.org', 'b.io'], allowLocalBinding: true });
  });
  test('a repo path with [ * and a space stays literal', () => {
    const s = renderSrtSettings(mk({ root: '/r/a [x]*/my repo' }));
    expect(s.filesystem.allowWrite[0]).toEqual({ path: '/r/a [x]*/my repo', literal: true });
    expect(s.filesystem.denyWrite[0]!.path.startsWith('/r/a [x]*/my repo/')).toBe(true);
  });
  test('a null token base adds no entry', () => {
    const s = renderSrtSettings(mk());
    expect(s.filesystem.denyRead).toEqual([]);
    expect(s.filesystem.denyWrite).toHaveLength(stopDenyWritePaths().length);
  });
  test('a relative path anywhere throws, never skipped', () => {
    expect(() => renderSrtSettings(mk({ root: 'repo' }))).toThrow(/absolute/);
    expect(() => renderSrtSettings(mk({ tmp: ['t'] }))).toThrow(/absolute/);
    expect(() => renderSrtSettings(mk({ tokenBase: 'gh' }))).toThrow(/absolute/);
    expect(() => renderSrtSettings(mk({ denyWrite: ['x'] }))).toThrow(/absolute/);
    expect(() => renderSrtSettings(mk({ denyRead: ['x'] }))).toThrow(/absolute/);
    expect(() => renderSrtSettings(mk({}, { allow_write: ['rel'] }))).toThrow(/absolute/);
  });
  test('helpers', () => {
    expect(expandHome('~/x', '/h')).toBe('/h/x');
    expect(expandHome('/x', '/h')).toBe('/x');
    expect(tempRoots().every((p) => p.startsWith('/'))).toBe(true);
    expect(new Set(tempRoots()).size).toBe(tempRoots().length);
    expect(writableRoots({ root: '/repo', stop: defaults().stop, home, tmp: ['/tmp'] })).toEqual(['/repo', '/tmp']);
  });
});
