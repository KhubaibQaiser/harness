import { expect, test } from 'vitest';
import type { ScanResult } from '../../src/vet/scan.js';
import { validateVetReview } from '../../src/ai/vet-review.js';

const scan = { sha: 'a'.repeat(40), findings: [{ severity: 'medium', rule: 'injection-text', file: 'skills/a/SKILL.md', line: 3, text: 'x' }, { severity: 'high', rule: 'network', file: 'b.sh', line: 1, text: 'y' }] } as unknown as ScanResult;
const good = { relevance: 'high', why: 'Fits.', overlaps: [{ id: 'base', how: 'Same job.' }], injection: [{ file: 'skills/a/SKILL.md', line: 3, verdict: 'benign', why: 'A quote.' }], recommendation: 'install', summary: 'Fine.' };
const errs = (raw: unknown, s: unknown = scan) => {
  const r = validateVetReview(raw, s as ScanResult, ['base']);
  return r.ok ? [] : r.errors;
};

test('a valid review passes', () => {
  const r = validateVetReview(good, scan, ['base']);
  expect(r).toEqual({ ok: true, review: good });
});

test('unknown keys, severity included, are rejected', () => {
  expect(errs({ ...good, severity: 'low' })).toEqual(['severity: unknown key']);
});

test('bad enums', () => {
  const e = errs({ ...good, relevance: 'x', recommendation: 'y' });
  expect(e).toContain('relevance: must be high, medium, low or none');
  expect(e).toContain('recommendation: must be install, install-with-care or skip');
});

test('overlap ids must be installed', () => {
  expect(errs({ ...good, overlaps: [{ id: 'foo', how: 'x' }] })).toEqual(['overlaps[0].id: "foo" is not an installed item']);
});

test('injection entries match a scan finding, once, with a verdict', () => {
  const at = (o: object) => ({ ...good, injection: [{ ...good.injection[0], ...o }] });
  expect(errs(at({ line: 4 }))).toEqual(['injection[0]: no injection-text finding at "skills/a/SKILL.md":4']);
  expect(errs(at({ file: 'b.sh', line: 1 }))).toEqual(['injection[0]: no injection-text finding at "b.sh":1']);
  expect(errs(at({ verdict: 'bad' }))).toEqual(['injection[0].verdict: must be benign or suspicious']);
  expect(errs(at({ line: 3.5 }))).toEqual(['injection[0].line: must be an integer']);
  expect(errs({ ...good, injection: [good.injection[0], good.injection[0]] })).toEqual(['injection[1]: duplicate "skills/a/SKILL.md":3']);
});

test('text fields: non-empty, no control characters, errors escaped', () => {
  expect(errs({ ...good, why: ' ' })).toEqual(['why: must be a non-empty string']);
  expect(errs({ ...good, summary: '' })).toEqual(['summary: must be a non-empty string']);
  expect(errs({ ...good, why: 'a\u001b[31mb' })).toEqual(['why: must not contain control characters']);
  expect(errs({ ...good, 'k\u001b[1m': 1 }).join()).not.toContain('\u001b');
});

test('non-object JSON and oversized lists are rejected', () => {
  expect(errs([])).toEqual(['vet-review: must be a mapping']);
  expect(errs(null)).toEqual(['vet-review: must be a mapping']);
  expect(errs({ ...good, overlaps: Array.from({ length: 201 }, () => ({ id: 'base', how: 'x' })) })).toEqual(['overlaps: at most 200 entries']);
});

test('a scan that is not a vet scan', () => {
  const m = 'scan: not a vet scan; run harness vet --json first';
  expect(errs(good, { findings: [] })).toEqual([m]);
  expect(errs(good, { sha: 'abc', findings: [] })).toEqual([m]);
  expect(errs(good, null)).toEqual([m]);
});
