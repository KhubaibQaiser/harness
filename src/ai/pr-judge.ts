import { isObj } from '../core/config.js';
import { checks, q } from './vet-review.js';

export interface PrJudge { verdicts: { id: string; supported: boolean; why: string }[] }

/** The judge's reply as data: one verdict per finding it was given, and nothing else. It can't add a finding or touch a severity. */
export function validatePrJudge(raw: unknown, ids: string[]): { ok: true; judge: PrJudge } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['pr-judge: must be a mapping'] };
  const errors: string[] = [];
  const { str, list, keys } = checks(errors);
  keys('', raw, ['verdicts']);
  const want = new Set(ids), seen = new Set<string>();
  list('verdicts', raw.verdicts).forEach((v, i) => {
    const at = `verdicts[${i}]`;
    if (!isObj(v)) return void errors.push(`${at}: must be a mapping`);
    keys(`${at}.`, v, ['id', 'supported', 'why']);
    if (typeof v.id !== 'string') errors.push(`${at}.id: must be a string`);
    else if (!want.has(v.id)) errors.push(`${at}.id: ${q(v.id)} is not a finding to judge`);
    else if (seen.has(v.id)) errors.push(`${at}.id: duplicate ${q(v.id)}`);
    else seen.add(v.id);
    if (typeof v.supported !== 'boolean') errors.push(`${at}.supported: must be true or false`);
    str(`${at}.why`, v.why, 300);
  });
  if (Array.isArray(raw.verdicts)) for (const id of ids) if (!seen.has(id)) errors.push(`verdicts: no verdict for ${q(id)}`);
  return errors.length ? { ok: false, errors } : { ok: true, judge: raw as unknown as PrJudge };
}
