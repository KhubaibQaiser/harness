import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { isAnyTestFile, isTestFile, TEST_FILE_GLOBS, matches, pairKey, toRepoPath } from '../../src/core/paths.js';

test('toRepoPath returns null outside the root', () => expect(toRepoPath('/r', '/tmp/x.ts')).toBeNull());
test('toRepoPath handles absolute, relative, and .. escapes', () => {
  expect(toRepoPath('/r', '/r/src/a.ts')).toBe('src/a.ts');
  expect(toRepoPath('/r', 'src/a.ts')).toBe('src/a.ts');
  expect(toRepoPath('/r', 'src/../b.ts')).toBe('b.ts');
  expect(toRepoPath('/r', '../x.ts')).toBeNull();
  expect(toRepoPath('/r', '/r')).toBeNull();
});
test('matches uses dot-aware globs', () => {
  expect(matches('.github/a.yml', ['**/*.yml'])).toBe(true);
  expect(matches('src/a.ts', ['lib/**'])).toBe(false);
  expect(matches('src/a.ts', [])).toBe(false);
});
test('isTestFile', () => {
  expect(isTestFile('src/a.test.ts')).toBe(true);
  expect(isTestFile('src/a.spec.tsx')).toBe(true);
  expect(isTestFile('src/__tests__/a.ts')).toBe(true);
  expect(isTestFile('src/a.ts')).toBe(false);
});
test('source and test share a pair key', () => {
  expect(pairKey('src/a/foo.ts')).toBe(pairKey('src/a/foo.test.ts'));
  expect(pairKey('src/a/foo.ts')).toBe(pairKey('src/a/__tests__/foo.test.ts'));
  expect(pairKey('src/a/foo.ts')).not.toBe(pairKey('src/a/bar.ts'));
});

test('toRepoPath resolves symlinks in root and target', () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'h-sym-')));
  mkdirSync(join(real, 'repo/src'), { recursive: true });
  const link = join(real, 'link');
  symlinkSync(join(real, 'repo'), link);
  expect(toRepoPath(link, join(link, 'src/a.ts'))).toBe('src/a.ts'); // root symlink, file symlink form
  expect(toRepoPath(join(real, 'repo'), join(link, 'src/a.ts'))).toBe('src/a.ts'); // root real, file symlink form
  expect(toRepoPath(link, join(real, 'repo/src/a.ts'))).toBe('src/a.ts'); // root symlink, file real form
  expect(toRepoPath(link, join(link, 'src/new/deeper/b.ts'))).toBe('src/new/deeper/b.ts'); // not yet existing
  symlinkSync(tmpdir(), join(real, 'repo/out'));
  expect(toRepoPath(join(real, 'repo'), join(real, 'repo/out/x.ts'))).toBeNull(); // in-repo symlink pointing outside
});

// git reports the canonical root (true case, Windows long names); the file path may come in another spelling
// (a lowercased path on macOS, an 8.3 short name like C:\Users\RUNNER~1 from %TEMP% on Windows).
const tmpRoot = mkdtempSync(join(tmpdir(), 'h-Case-'));
const canonical = realpathSync.native(tmpRoot);
test('toRepoPath maps a tmpdir-spelled path under the canonical (git) root', () => {
  expect(toRepoPath(canonical, join(tmpRoot, 'src/a.ts'))).toBe('src/a.ts');
});
test.skipIf(!existsSync(canonical.toLowerCase()))('toRepoPath maps a path in another case on a case-insensitive file system', () => {
  mkdirSync(join(canonical, 'Src'));
  expect(toRepoPath(canonical, join(canonical.toLowerCase(), 'src/a.ts'))).toBe('Src/a.ts');
});

test('TEST_FILE_GLOBS are pinned to isTestFile and isAnyTestFile, plus test/, tests/ and Go', () => {
  const yes = ['a.test.ts', 'src/a.spec.tsx', 'src/__tests__/a.ts', 'test/a.ts', 'src/test/fixtures/a.json', 'tests/x/a.ts', 'pkg/test_a.py', 'pkg/a_test.py', 'pkg/tests/a.py', 'pkg/a_test.go', 'tests/conftest.py'];
  const no = ['src/a.ts', 'src/latest.ts', 'src/contest.ts', 'src/testing.ts', 'src/a_test.ts', 'pkg/a.py', 'pkg/atest.go', 'src/tests.ts', 'docs/test.md'];
  for (const p of yes) expect(matches(p, TEST_FILE_GLOBS), p).toBe(true);
  for (const p of no) expect(matches(p, TEST_FILE_GLOBS), p).toBe(false);
  // The two notions can't drift: anything either one calls a test is matched.
  for (const p of [...yes, ...no]) if (isTestFile(p) || isAnyTestFile(p)) expect(matches(p, TEST_FILE_GLOBS), p).toBe(true);
});
