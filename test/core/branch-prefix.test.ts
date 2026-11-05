import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PREFIX_RE, slug, suggestBranches } from '../../src/core/branch-prefix.js';

test('slug', () => {
  expect(slug('Add login form')).toBe('add-login-form');
  expect(slug('  ')).toBe('topic');
  expect(slug('a'.repeat(60))).toHaveLength(50);
  expect(slug('--Hi!!there--')).toBe('hi-there');
});
test('slug does not end in - after the cut', () => expect(slug('a'.repeat(49) + ' b')).toBe('a'.repeat(49)));
test('suggestBranches', () => expect(suggestBranches(['feature/', 'fix/'], 'X y')).toEqual(['feature/x-y', 'fix/x-y']));
test('PREFIX_RE', () => {
  expect(PREFIX_RE.test('feature/')).toBe(true);
  expect(PREFIX_RE.test('feature')).toBe(false);
});
test('is a leaf: no import line', () => expect(readFileSync('src/core/branch-prefix.ts', 'utf8')).not.toMatch(/\bimport\b|\bfrom\s+['"]|require\(/));
