import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { claudeVersion, olderThan } from '../../src/core/min-claude.js';
import { packageDir } from '../../src/core/package-dir.js';

test('packageDir finds templates, catalog and dist from source', () => {
  expect(packageDir('templates')).toBe(resolve('templates'));
  expect(existsSync(join(packageDir('templates'), 'settings.fragment.json'))).toBe(true);
  expect(packageDir('catalog')).toBe(resolve('catalog'));
  expect(packageDir('dist')).toBe(resolve('dist'));
});

test('olderThan compares numerically per part', () => {
  expect(olderThan('2.1.9', '2.1.10')).toBe(true);
  expect(olderThan('2.1.313', '2.1.314')).toBe(true);
  expect(olderThan('2.1.314', '2.1.314')).toBe(false);
  expect(olderThan('3.0.0', '2.9.9')).toBe(false);
  expect(typeof claudeVersion).toBe('function');
});
