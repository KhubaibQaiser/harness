import { expect, test } from 'vitest';
import { CREDENTIAL_ENV, CREDENTIAL_FILES, credentialFiles } from '../../src/core/credentials.js';

test('lists equal §8.3', () => {
  expect(CREDENTIAL_FILES).toHaveLength(37);
  expect(CREDENTIAL_ENV).toHaveLength(29);
  expect(CREDENTIAL_FILES[0]).toBe('~/.ssh');
  expect(CREDENTIAL_FILES.at(-1)).toBe('/mnt/c/Users');
  expect(CREDENTIAL_ENV[0]).toBe('NPM_TOKEN');
  expect(CREDENTIAL_ENV.at(-1)).toBe('REMOTE_CONTAINERS_SOCKETS');
});

test('credentialFiles expands ~/ and leaves absolute paths alone', () => {
  const { files, skipped } = credentialFiles('/h');
  expect(files).toHaveLength(37);
  expect(files[0]).toBe('/h/.ssh');
  expect(files).toContain('/h/Library/Application Support/pypoetry');
  expect(files.at(-1)).toBe('/mnt/c/Users');
  expect(skipped).toEqual([]);
});

test('home with [ skips every file entry', () => {
  const r = credentialFiles('/h[1]');
  expect(r.files.filter((f) => f.startsWith('/h'))).toEqual([]);
  expect(r.skipped).toHaveLength(36);
  expect(r.files).toEqual(['/mnt/c/Users']);
});
