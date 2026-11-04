import { expect, test } from 'vitest';
import { harnessIgnore } from '../../src/install/harnessignore.js';
import { makeRepo } from './helpers.js';

const ig = (text: string) => harnessIgnore(makeRepo({ '.harnessignore': text }, { git: false }));

test('directory glob, trailing slash, anchoring, comment and negation', () => {
  const i = ig('# a comment\n\nfixtures/**\nbuild/\n/top.txt\nsecret.json\n!keep.txt\n');
  expect(i('fixtures/a/b.ts')).toBe(true);
  expect(i('build/x/y.js')).toBe(true);
  expect(i('src/build/x.js')).toBe(true);
  expect(i('top.txt')).toBe(true);
  expect(i('src/top.txt')).toBe(false);
  expect(i('deep/secret.json')).toBe(true);
  expect(i('# a comment')).toBe(false);
  expect(i('keep.txt')).toBe(false);
  expect(i('src/a.ts')).toBe(false);
});

test('no file means nothing is ignored', () => {
  expect(harnessIgnore(makeRepo({ a: '1' }, { git: false }))('a')).toBe(false);
});
