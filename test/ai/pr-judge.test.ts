import { expect, test } from 'vitest';
import { validatePrJudge } from '../../src/ai/pr-judge.js';

const ok = { verdicts: [{ id: 'f1', supported: true, why: 'The snippet shows it.' }, { id: 'f2', supported: false, why: 'Line 5 is a comment.' }] };
const errs = (raw: unknown, ids = ['f1', 'f2']) => { const r = validatePrJudge(raw, ids); return r.ok ? [] : r.errors; };

test('a good reply, and an empty one for no findings', () => {
  expect(validatePrJudge(ok, ['f1', 'f2'])).toEqual({ ok: true, judge: ok });
  expect(validatePrJudge({ verdicts: [] }, [])).toEqual({ ok: true, judge: { verdicts: [] } });
});
test('each problem is one error', () => {
  expect(errs({ verdicts: [ok.verdicts[0]] })).toEqual(['verdicts: no verdict for "f2"']);
  expect(errs({ verdicts: [...ok.verdicts, ok.verdicts[0]] })).toEqual(['verdicts[2].id: duplicate "f1"']);
  expect(errs({ ...ok, severity: 'nit' })).toEqual(['severity: unknown key']);
  expect(errs({ verdicts: [{ ...ok.verdicts[0], why: 'w'.repeat(301) }, ok.verdicts[1]] })).toEqual(['verdicts[0].why: must be at most 300 characters']);
});
test('no added findings, no severities, single-line text', () => {
  expect(errs({ verdicts: [...ok.verdicts, { id: 'f9', supported: true, why: 'x' }] })).toEqual(['verdicts[2].id: "f9" is not a finding to judge']);
  expect(errs({ verdicts: [{ ...ok.verdicts[0], severity: 'critical' }, ok.verdicts[1]] })).toEqual(['verdicts[0].severity: unknown key']);
  expect(errs({ verdicts: [{ ...ok.verdicts[0], supported: 'yes' }, ok.verdicts[1]] })).toEqual(['verdicts[0].supported: must be true or false']);
  expect(errs({ verdicts: [{ ...ok.verdicts[0], why: 'a\nb' }, ok.verdicts[1]] })).toEqual(['verdicts[0].why: must not contain control characters']);
  expect(errs('x')).toEqual(['pr-judge: must be a mapping']);
});
