import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { gitRoot } from '../../src/core/repo-root.js';
import { makeRepo } from '../install/helpers.js';

test('gitRoot is the repo root, or null outside a repo', () => {
  expect(gitRoot(makeRepo({ 'a.txt': 'x' }))).toMatch(/\//);
  expect(gitRoot(mkdtempSync(`${tmpdir()}/h-noroot-`))).toBeNull();
});
