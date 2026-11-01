import { describe, expect, it } from 'vitest';
import { eolOf, jsonIndentOf, sha256, withEol } from '../../src/install/text.js';

describe('text', () => {
  it('eolOf and withEol keep CRLF', () => {
    expect(eolOf('a\r\nb\r\n')).toBe('\r\n');
    expect(eolOf('a\nb\n')).toBe('\n');
    expect(eolOf('single')).toBe('\n');
    expect(withEol('a\nb\n', '\r\n')).toBe('a\r\nb\r\n');
    expect(withEol('a\r\nb\n', '\n')).toBe('a\nb\n');
    expect(withEol('a\r\nb\n', '\r\n')).toBe('a\r\nb\r\n');
  });
  it('jsonIndentOf detects tabs and 4 spaces', () => {
    expect(jsonIndentOf('{\n\t"a": 1\n}')).toBe('\t');
    expect(jsonIndentOf('{\n    "a": 1\n}')).toBe(4);
    expect(jsonIndentOf('{\n  "a": 1\n}')).toBe(2);
    expect(jsonIndentOf('{"a":1}')).toBe(2);
  });
  it('sha256 is hex', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
