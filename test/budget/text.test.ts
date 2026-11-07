import { expect, test } from 'vitest';
import { estimateTokens } from '../../src/budget/measure.js';
import { lf, pathsOf, splitFrontmatter, stripComments } from '../../src/budget/text.js';

test('CRLF and LF give equal counts', () => {
  const a = 'one\ntwo\n\nthree\n';
  expect(estimateTokens(lf(a.replace(/\n/g, '\r\n')))).toBe(estimateTokens(lf(a)));
  expect(lf('a\r\nb')).toBe('a\nb');
});

test('a comment outside a fence is removed, also across lines', () => {
  expect(stripComments('a\n<!-- note -->\nb')).toBe('a\nb');
  expect(stripComments('a\n<!-- one\ntwo -->\nb')).toBe('a\nb');
  expect(stripComments('  <!-- c -->\nz')).toBe('z');
});

test('the same comment inside a fence is kept (backtick and tilde)', () => {
  const bt = 'a\n```\n<!-- keep -->\n```\nb';
  const td = 'a\n~~~\n<!-- keep -->\n~~~\nb';
  expect(stripComments(bt)).toBe(bt);
  expect(stripComments(td)).toBe(td);
});

test('an unclosed comment is kept, not swallowed', () => {
  expect(stripComments('a\n<!-- never closed\nb')).toBe('a\n<!-- never closed\nb');
});

test('the harness markers count 0', () => {
  const t = stripComments('<!-- harness:start -->\n<!-- harness:end -->\n');
  expect(estimateTokens(t.trim())).toBe(0);
});

test('paths accepts a list or a comma string, null when absent', () => {
  expect(pathsOf(splitFrontmatter('---\npaths: [a, b]\n---\nx').data)).toEqual(['a', 'b']);
  expect(pathsOf(splitFrontmatter('---\npaths: "a, b"\n---\nx').data)).toEqual(['a', 'b']);
  expect(pathsOf(splitFrontmatter('---\nname: x\n---\nx').data)).toBeNull();
  expect(pathsOf(null)).toBeNull();
});

test('frontmatter: body split, none, and unparseable gives the whole text', () => {
  expect(splitFrontmatter('---\nname: x\n---\nbody\n')).toEqual({ data: { name: 'x' }, body: 'body\n', bad: false });
  expect(splitFrontmatter('no fm')).toEqual({ data: null, body: 'no fm', bad: false });
  const bad = '---\nname: [unclosed\n---\nbody\n';
  expect(splitFrontmatter(bad)).toEqual({ data: null, body: bad, bad: true });
});

test('an inline comment mid-line is not block-level and is kept', () => {
  expect(stripComments('x <!-- c --> y')).toBe('x <!-- c --> y');
  expect(stripComments('x <!-- one\ntwo --> y')).toBe('x <!-- one\ntwo --> y');
});

test('paths: commas inside braces do not split', () => {
  expect(pathsOf({ paths: 'src/**/*.{ts,tsx}, lib/*.md' })).toEqual(['src/**/*.{ts,tsx}', 'lib/*.md']);
});

test('a BOM before the frontmatter is tolerated', () => {
  expect(splitFrontmatter('\uFEFF---\nname: x\n---\nbody')).toMatchObject({ data: { name: 'x' }, body: 'body', bad: false });
});
