import { expect, test } from 'vitest';
import { unifiedDiff } from '../../src/install/diff.js';

const L = (...n: number[]) => n.map((i) => `l${i}`).join('\n') + '\n';

test('identical text gives an empty diff', () => {
  expect(unifiedDiff(L(1, 2), L(1, 2), 'a')).toBe('');
});

test('one inserted line, 3 lines of context, headers and hunk range', () => {
  const after = L(1, 2, 3, 4, 5, 6, 7, 8, 9).replace('l5\n', 'l5\nNEW\n');
  expect(unifiedDiff(L(1, 2, 3, 4, 5, 6, 7, 8, 9), after, 'f.txt')).toBe(
    ['--- a/f.txt', '+++ b/f.txt', '@@ -3,6 +3,7 @@', ' l3', ' l4', ' l5', '+NEW', ' l6', ' l7', ' l8'].join('\n') + '\n',
  );
});

test('replace and delete', () => {
  expect(unifiedDiff('a\nb\nc\n', 'a\nX\nc\n', 'f')).toBe(['--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' a', '-b', '+X', ' c'].join('\n') + '\n');
  expect(unifiedDiff('a\nb\n', 'a\n', 'f')).toContain('-b');
});

test('distant changes make separate hunks; near ones merge', () => {
  const a = L(...Array.from({ length: 30 }, (_, i) => i));
  const far = a.replace('l2\n', 'X\n').replace('l27\n', 'Y\n');
  expect(unifiedDiff(a, far, 'f').match(/^@@/gm)).toHaveLength(2);
  const near = a.replace('l2\n', 'X\n').replace('l6\n', 'Y\n');
  expect(unifiedDiff(a, near, 'f').match(/^@@/gm)).toHaveLength(1);
});

test('insert into an empty file', () => {
  expect(unifiedDiff('', 'a\n', 'f')).toBe(['--- a/f', '+++ b/f', '@@ -0,0 +1,1 @@', '+a'].join('\n') + '\n');
});
