import { describe, expect, test } from 'vitest';
import type { Where } from '../../../src/checks/guard.js';
import { isShell } from '../../../src/hooks/edit-target.js';
import { prTargets } from '../../../src/checks/pr-size/detect.js';
import { makeRepo } from '../../install/helpers.js';

const w: Where = { root: '/nonexistent-harness-root', env: {} };
const creates = (c: string) => prTargets(c, w).filter((t) => t.kind === 'create');
const pushes = (c: string) => prTargets(c, w).filter((t) => t.kind === 'push');

describe('gh pr create', () => {
  test.each([
    'gh pr create', '/usr/local/bin/gh pr create', 'C:/x/gh.exe pr create', 'timeout 60 gh pr create', 'env GH_TOKEN=x gh pr create',
    'cd x && gh pr create', 'bash -c "gh pr create --fill"', "echo 'gh pr create' | sh", '$GH pr create', '$(which gh) pr create',
    'eval "gh pr create"', 'gh pr -R o/r create', 'gh pr new', 'eval "gh pr new"',
  ])('%s is one create', (c) => {
    expect(creates(c)).toHaveLength(1);
    expect(creates(c)[0]).toEqual({ kind: 'create' });
  });

  test('package script', () => {
    const root = makeRepo({ 'package.json': JSON.stringify({ scripts: { ship: 'gh pr create --base dev' } }) }, { git: false });
    expect(prTargets('npm run ship', { root, env: {} })).toEqual([{ kind: 'create', base: 'dev' }]);
  });

  test.each([['-B dev'], ['--base dev'], ['--base=dev']])('%s gives base dev', (f) => {
    expect(prTargets(`gh pr create ${f}`, w)).toEqual([{ kind: 'create', base: 'dev' }]);
  });

  test('head, value flags, odd values', () => {
    expect(prTargets('gh pr create --head o:feat', w)).toEqual([{ kind: 'create', head: 'feat' }]);
    expect(prTargets('gh pr create --title "use --base main" --base feat/a', w)).toContainEqual({ kind: 'create', base: 'feat/a' });
    expect(prTargets('gh pr create -t dev --base x', w)).toEqual([{ kind: 'create', base: 'x' }]);
    expect(prTargets('gh pr create --base=--output=x', w)).toEqual([{ kind: 'create', base: '--output=x' }]);
  });

  test.each(['echo gh pr create', 'grep "gh pr create" f', 'git commit -m "gh pr create"', 'gh pr view', 'gh pr list', 'gh pr edit --base x', 'gh issue create'])('%s is not a create', (c) => {
    expect(creates(c)).toEqual([]);
  });
});

describe('git push', () => {
  const refs = (c: string) => pushes(c)[0];
  test('forms', () => {
    expect(pushes('git push')).toEqual([{ kind: 'push', all: false, refs: [] }]);
    expect(refs('git push -u origin feat')).toEqual({ kind: 'push', all: false, refs: [{ src: 'feat', dst: 'feat' }] });
    expect(refs('git push origin HEAD:feat')).toMatchObject({ refs: [{ src: 'HEAD', dst: 'feat' }] });
    expect(refs('git push origin +feat')).toMatchObject({ refs: [{ src: 'feat', dst: 'feat' }] });
    expect(refs('git push origin refs/heads/a:refs/heads/b')).toMatchObject({ refs: [{ src: 'a', dst: 'b' }] });
    expect(refs('git push --all origin')).toMatchObject({ all: true });
    expect(refs('git -C sub push origin feat')).toMatchObject({ refs: [{ src: 'feat', dst: 'feat' }] });
    expect(refs('git push -o ci.skip origin feat')).toMatchObject({ refs: [{ src: 'feat', dst: 'feat' }] });
  });
  test.each(['git pull', 'git status', 'echo git push'])('%s has no targets', (c) => {
    expect(prTargets(c, w)).toEqual([]);
  });
});

describe('fix round 1', () => {
  test('--recover takes a value', () => {
    expect(prTargets('gh pr create --recover key --base dev', w)).toEqual([{ kind: 'create', base: 'dev' }]);
    expect(prTargets('gh pr create --recover --base=x', w)).toEqual([{ kind: 'create' }]);
  });
  test('attached short forms and --head=', () => {
    expect(prTargets('gh pr create -Bdev -Ho:feat', w)).toEqual([{ kind: 'create', base: 'dev', head: 'feat' }]);
    expect(prTargets('gh pr create --head=o:feat', w)).toEqual([{ kind: 'create', head: 'feat' }]);
  });
  test('backtick command name', () => {
    expect(creates('`which gh` pr create')).toEqual([{ kind: 'create' }]);
  });
  test('--mirror and --branches set all', () => {
    expect(pushes('git push --mirror origin')[0]).toMatchObject({ all: true });
    expect(pushes('git push --branches origin')[0]).toMatchObject({ all: true });
  });
  test('empty dst falls back to src; deletes and tag-only pushes are no push target', () => {
    expect(pushes('git push origin feat:')[0]).toMatchObject({ refs: [{ src: 'feat', dst: 'feat' }] });
    for (const c of ['git push --delete origin feat', 'git push -d origin feat', 'git push -fd origin feat', 'git push origin :old', 'git push --tags', 'git push origin --tags', 'git push origin refs/tags/v1', 'git push origin v1:refs/tags/v1'])
      expect(pushes(c), c).toEqual([]);
    expect(pushes('git push origin feat --tags')[0]).toMatchObject({ refs: [{ src: 'feat', dst: 'feat' }] });
    expect(pushes('git push origin feat :old')[0]).toMatchObject({ refs: [{ src: 'feat', dst: 'feat' }] });
    expect(pushes('git push origin x/refs/tags/y')[0]).toMatchObject({ refs: [{ src: 'x/refs/tags/y', dst: 'x/refs/tags/y' }] });
    expect(pushes('git push origin HEAD:x/refs/tags/y')[0]).toMatchObject({ refs: [{ src: 'HEAD', dst: 'x/refs/tags/y' }] });
  });
  test('Monitor and PowerShell are shell tools whose text is read with the given Where', () => {
    expect(isShell('Monitor')).toBe(true);
    expect(isShell('PowerShell')).toBe(true);
    const root = makeRepo({ 'package.json': JSON.stringify({ scripts: { ship: 'gh pr create --base dev' } }) }, { git: false });
    expect(prTargets('npm run ship', { root, env: {} })).toEqual([{ kind: 'create', base: 'dev' }]);
    expect(prTargets('npm run ship', w)).toEqual([]);
  });
});

describe('--pr-size-raise', () => {
  const raises = (c: string) => prTargets(c, w).filter((t) => t.kind === 'raise');
  test.each([
    ['node .harness/hooks/dispatch.mjs --pr-size-raise --lines 600', { kind: 'raise', lines: '600' }],
    ['node ".harness\\hooks\\dispatch.mjs" --pr-size-raise --lines 600 --files 30', { kind: 'raise', lines: '600', files: '30' }],
    ['cd x && node .harness/hooks/dispatch.mjs --pr-size-raise --lines 600', { kind: 'raise', lines: '600' }],
  ])('%s is one raise', (c, t) => {
    expect(raises(c)).toEqual([t]);
  });

  test('an unknown word drops the values, so the entry fails by itself', () => {
    expect(raises('node .harness/hooks/dispatch.mjs --pr-size-raise --lines 600 --bogus')).toEqual([{ kind: 'raise' }]);
  });

  test.each(['echo node .harness/hooks/dispatch.mjs --pr-size-raise', '$X --pr-size-raise --lines 600', 'node other.mjs --pr-size-raise --lines 600'])('%s is no raise', (c) => {
    expect(raises(c)).toEqual([]);
  });
});
