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
writeFileSync(join(pkg, 'package.json'), '{"name":"@anthropic-ai/sandbox-runtime"}');
writeFileSync(join(pkg, 'dist/cli.js'), '');
const sys: AllowWriteSys = { root, home, env: { PATH: `${bin}::/usr/bin` }, platform: 'linux', srtReal: join(pkg, 'dist/cli.js'), tokenBase: tok };
const p = (e: string, s: Partial<AllowWriteSys> = {}) => allowWriteProblem(e, { ...sys, ...s });

const mkd = (...a: string[]) => { const d = join(base, ...a); mkdirSync(d, { recursive: true }); return d; };
const other = join(base, 'other');

describe('reference dirs compared in both forms', () => {
  test('PATH entry that is a symlink: its target is refused', () => {
    const real = mkd('pl-real');
    symlinkSync(real, join(base, 'pl-link'));
    expect(p(real, { home: other, env: { PATH: join(base, 'pl-link') } })).toBe('it is on PATH');
  });
  test('home that is a symlink: its real path and children are refused', () => {
    const real = mkd('hl-real');
    symlinkSync(real, join(base, 'hl-link'));
    const s = { home: join(base, 'hl-link') };
    expect(p(real, s)).toBe('it is your home folder');
    expect(p(join(real, '.claude/x'), s)).toBe('programs there run at login');
  });
  test('token base under a symlinked parent', () => {
    const real = mkd('tl-real/harness/gh');
    symlinkSync(join(base, 'tl-real'), join(base, 'tl-link'));
    expect(p(join(real, 'x'), { home: other, tokenBase: join(base, 'tl-link/harness/gh') })).toBe('it holds the GitHub token folder');
  });
  test('protected root that is a symlink', () => {
    const real = mkd('rl-real/.claude/hooks');
    symlinkSync(join(base, 'rl-real'), join(base, 'rl-link'));
    expect(p(real, { root: join(base, 'rl-link') })).toBe('it is a protected path');
  });
  test('srt binary reached through a symlink: its package folder is refused', () => {
    symlinkSync(join(pkg, 'dist/cli.js'), join(base, 'srt-shim'));
    expect(p(pkg, { home: other, srtReal: join(base, 'srt-shim') })).toBe('srt is installed there');
  });
});

describe('srt root', () => {
  test('no package.json: falls back to the binary dir', () => {
    const d = mkd('nopkg/bin');
    writeFileSync(join(d, 'srt'), '');
    expect(p(d, { home: other, srtReal: join(d, 'srt') })).toBe('srt is installed there');
    expect(p(mkd('nopkg/sib'), { home: other, srtReal: join(d, 'srt') })).toBeNull();
  });
  test('nested dist/package.json does not narrow the root', () => {
    const d = mkd('nest/node_modules/@x/srt/dist');
    const top = join(base, 'nest/node_modules/@x/srt');
    writeFileSync(join(top, 'package.json'), '{"name":"@anthropic-ai/sandbox-runtime"}');
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    writeFileSync(join(d, 'cli.js'), '');
    expect(p(join(top, 'lib'), { home: other, srtReal: join(d, 'cli.js') })).toBe('srt is installed there');
  });
});

describe('edges', () => {
  test('darwin folds case', () => {
    expect(p(join(home, '.CLAUDE'), { platform: 'darwin' })).toBe('programs there run at login');
    expect(p(join(home, '.CLAUDE'))).toBeNull();
  });
  test('/ and /usr and trailing slash', () => {
    expect(p('/')).toBe('it is your home folder');
    expect(p('/usr', { home: other, env: { PATH: '/usr/bin' } })).toBe('it is on PATH');
    expect(p(`${bin}/`, { home: other })).toBe('it is on PATH');
  });
});

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
