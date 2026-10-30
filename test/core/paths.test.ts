import { expect, test } from 'vitest';
import { isTestFile, matches, pairKey, toRepoPath } from '../../src/core/paths.js';

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
