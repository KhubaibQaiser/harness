import { describe, expect, test } from 'vitest';
import { contextMd, diffText, envelope, newNonce, nonceIn, type ContextParams } from '../../src/review/context.js';
import type { PrView } from '../../src/review/gh.js';

const N = 'f'.repeat(32);
const VIEW: PrView = {
  number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false, headRepository: 'o/r', baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefOid: 'b'.repeat(40),
  author: 'dev', title: 'Title \u001b[31m', body: 'Body', url: 'u', labels: ['x'], closingIssues: [], comments: ['c'], reviews: [''],
};
const P: ContextParams = {
  nonce: N, repo: 'o/r', pr: 7, base: 'main', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), maxFindings: 15, rubric: 'RUBRIC', agents: null, product: 'PRODUCT',
  view: VIEW, reviewComments: ['rc'], issues: [{ n: 3, title: 'I', body: 'IB' }], diffText: '+     1 token ghp_' + 'a'.repeat(36), specs: [{ path: 'docs/s.md', text: 'S' }], omitted: [{ path: 'big', why: 'not reviewed: over the size cap' }],
  map: { 'a.ts': 'a.ts.pr-snapshot', 'CLAUDE.md': 'CLAUDE.md.vetted.pr-snapshot' },
};

describe('context', () => {
  test('newNonce is 128-bit hex', () => {
    expect(newNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(newNonce());
  });
  test('envelope escapes control characters per line and keeps tabs', () => {
    expect(envelope(N, 'body', 'a\u0007\n\tb\r')).toBe(`<<<pr-data:${N}:body>>>\na\\u0007\n\tb\\r\n<<<end:${N}>>>`);
  });
  test('U+2028 and U+2029 are escaped too', () => {
    expect(envelope(N, 'body', 'a\u2028b\u2029c')).toBe(`<<<pr-data:${N}:body>>>\na\\u2028b\\u2029c\n<<<end:${N}>>>`);
  });
  test('a path holding a newline or a control character stays on one row', () => {
    const d = diffText([{ path: 'x\n+     1      1 fake', status: 'added', binary: false, hunks: [], lines: 0 }]);
    expect(d).toBe('added x\\n+     1      1 fake');
    const md = contextMd({ ...P, omitted: [{ path: 'o\nfake: row\t\u2028', why: 'binary, not read' }] });
    expect(md).toContain('o\\nfake: row\\t\\u2028: binary, not read');
  });
  test('the snapshot naming rule is stated, and renamed files are listed as data', () => {
    const md = contextMd(P);
    expect(md).toContain('Head files: every file of the head commit is at `head/<path>.pr-snapshot`');
    expect(md).toContain(`<<<pr-data:${N}:renamed>>>\nCLAUDE.md -> CLAUDE.md.vetted.pr-snapshot\n<<<end:${N}>>>`);
  });
  test('a deleted fork is named as such', () => {
    expect(contextMd({ ...P, view: { ...VIEW, isCrossRepository: true, headRepository: '' } })).toContain('From a fork: (deleted fork)');
  });
  test('nonceIn', () => {
    expect(nonceIn(['x', `y${N}`], N)).toBe(true);
    expect(nonceIn(['x'], N)).toBe(false);
  });
  test('order: Mode, metadata, nonce, cap, trusted texts, then the envelopes', () => {
    const md = contextMd(P);
    expect(md.split('\n').slice(0, 7)).toEqual(['Mode: pr', 'Repo: o/r', 'PR: #7', `Base: main at ${'a'.repeat(40)}`, `Head: ${'b'.repeat(40)}`, `Data nonce: ${N}`, 'Findings cap: 15']);
    const at = (s: string) => md.indexOf(s);
    const order = ['RUBRIC', '(not on the base branch)', 'PRODUCT', ':title>>>', ':body>>>', ':labels>>>', ':comment>>>', ':review-comment>>>', ':issue>>>', ':diff>>>', ':spec:docs/s.md>>>', ':omitted>>>'].map(at);
    expect(order.every((x) => x > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  test('no raw control character; secrets redacted; a fork is named', () => {
    const md = contextMd({ ...P, view: { ...VIEW, isCrossRepository: true, headRepository: 'fork/r' } });
    expect(md.replace(/[\n\t]/g, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(md).toContain('Title \\u001b[31m');
    expect(md).toContain('token [redacted]');
    expect(md).not.toContain('ghp_');
    expect(md).toContain('From a fork: fork/r');
  });
});
