import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('build emits a dependency-free dispatcher', async () => {
  const src = await readFile('dist/hooks/dispatch.mjs', 'utf8');
  expect(src).not.toMatch(/from\s+['"](?!node:)[^'"]+['"]/);
});
