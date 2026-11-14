import { expect, test } from 'vitest';
import { tokenBase } from '../../src/core/token-base.js';

test('token base per platform, getconf failure throws, Linux without XDG is null', () => {
  expect(tokenBase('darwin', {}, () => '/var/folders/ab/T/\n')).toBe('/var/folders/ab/T/harness/gh');
  expect(() => tokenBase('darwin', {}, () => { throw new Error('boom\nmore'); })).toThrow('boom');
  expect(() => tokenBase('darwin', {}, () => '')).toThrow();
  expect(tokenBase('linux', { XDG_RUNTIME_DIR: '/run/user/1' })).toBe('/run/user/1/harness/gh');
  expect(tokenBase('linux', {})).toBeNull();
  expect(tokenBase('win32', { XDG_RUNTIME_DIR: '/x' })).toBeNull();
});

test('token base must be absolute and is joined without a trailing slash', () => {
  expect(tokenBase('darwin', {}, () => '/var/T')).toBe('/var/T/harness/gh');
  expect(() => tokenBase('darwin', {}, () => 'T/')).toThrow(/absolute/);
  expect(tokenBase('linux', { XDG_RUNTIME_DIR: 'run/user' })).toBeNull();
});
