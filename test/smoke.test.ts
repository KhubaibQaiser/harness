import { readFile, stat } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('build emits a dependency-free dispatcher', async () => {
  const src = await readFile('dist/hooks/dispatch.mjs', 'utf8');
  expect(src).not.toMatch(/from\s+['"](?!node:)[^'"]+['"]/);
});

test.skipIf(process.platform === 'win32')('dist/cli.mjs is executable', async () => {
  for (const f of ['dist/cli.mjs', 'dist/hooks/dispatch.mjs']) expect((await stat(f)).mode & 0o100).toBe(0o100);
});
