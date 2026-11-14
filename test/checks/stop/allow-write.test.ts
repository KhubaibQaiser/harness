import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { allowWriteMessage, allowWriteProblem, type AllowWriteSys } from '../../../src/checks/stop/allow-write.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'aw-')));
const home = join(base, 'home');
const root = join(base, 'repo');
const bin = join(home, '.local/bin');
const pkg = join(base, 'srt/node_modules/@x/srt');
const tok = join(base, 'tok/harness/gh');
for (const d of [home, root, bin, join(pkg, 'dist'), tok, join(home, 'cache')]) mkdirSync(d, { recursive: true });
writeFileSync(join(pkg, 'package.json'), '{}');
writeFileSync(join(pkg, 'dist/cli.js'), '');
const sys: AllowWriteSys = { root, home, env: { PATH: `${bin}::/usr/bin` }, platform: 'linux', srtReal: join(pkg, 'dist/cli.js'), tokenBase: tok };
const p = (e: string, s: Partial<AllowWriteSys> = {}) => allowWriteProblem(e, { ...sys, ...s });

describe('allowWriteProblem', () => {
  test('protected: equal or inside', () => {
    expect(p(join(root, '.claude/hooks'))).toBe('it is a protected path');
    expect(p(join(root, '.claude/hooks/x'))).toBe('it is a protected path');
    expect(p(join(root, 'cache'))).toBeNull();
  });
  test('home: equal or above', () => {
    expect(p(home)).toBe('it is your home folder');
    expect(p(base)).toBe('it is your home folder');
  });
  test('login-start: equal, inside, or above', () => {
    for (const e of ['.claude', '.claude/x', 'Library/LaunchAgents', 'Library/LaunchAgents/a', '.config/systemd/user', '.config/autostart', 'Library', '.config'])
      expect(p(join(home, e))).toBe('programs there run at login');
    expect(p('~/.claude')).toBe('programs there run at login');
    expect(p(join(home, 'Library/Caches'))).toBeNull();
    expect(p(join(home, '.cache'))).toBeNull();
  });
  test('PATH: equal or above, empty segments ignored', () => {
    expect(p(bin, { home: join(base, 'other') })).toBe('it is on PATH');
    expect(p(join(home, '.local'))).toBe('it is on PATH');
    expect(p(join(bin, 'sub'))).toBeNull();
    expect(p(join(home, 'cache'), { env: { PATH: '' } })).toBeNull();
    expect(p(join(home, 'cache'), { env: { PATH: ':' }, root: join(home, 'cache') })).toBeNull();
  });
  test('srt: equal, inside, above package root', () => {
    for (const e of [pkg, join(pkg, 'dist'), join(base, 'srt')]) expect(p(e, { home: join(base, 'other') })).toBe('srt is installed there');
    expect(p(join(base, 'srt2'))).toBeNull();
  });
  test('token base: equal or inside', () => {
    expect(p(tok, { home: join(base, 'other') })).toBe('it holds the GitHub token folder');
    expect(p(join(tok, 'x'), { home: join(base, 'other') })).toBe('it holds the GitHub token folder');
    expect(p(join(base, 'tok'))).toBeNull();
  });
  test('a symlink to a refused folder is refused by its realpath', () => {
    const link = join(home, 'cache/link');
    symlinkSync(bin, link);
    expect(p(link)).toBe('it is on PATH');
  });
  test('a plain cache folder passes; relative paths throw', () => {
    expect(p(join(home, 'cache'))).toBeNull();
    expect(() => p('rel/x')).toThrow(/absolute/);
  });
  test('message', () => {
    expect(allowWriteMessage('~/x', 'it is on PATH')).toBe("stop.allow_write can't list ~/x: it is on PATH. Choose a folder only your tests write, such as a cache folder.");
  });
});
