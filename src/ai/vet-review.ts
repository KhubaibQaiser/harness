import { CONTROL, esc, isObj } from '../core/config.js';
import type { ScanResult } from '../vet/scan.js';

/** The reviewer's vet-review.json. */
export interface VetReview {
  relevance: 'high' | 'medium' | 'low' | 'none';
  why: string;
  overlaps: { id: string; how: string }[];
  injection: { file: string; line: number; verdict: 'benign' | 'suspicious'; why: string }[];
  recommendation: 'install' | 'install-with-care' | 'skip';
  summary: string;
}

export const MAX = 200; // a list longer than this is not a real review; keeps a huge file cheap to check
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
// Echoed values are cut to 120 code points: a hostile 5 MB value must not become a 5 MB error line.
export const cut = (s: string) => { const a = [...s.slice(0, 480)]; return esc(a.slice(0, 120).join('')) + (a.length > 120 || s.length > 480 ? '…' : ''); };
export const q = (s: string) => `"${cut(s)}"`;

/** The field checks the AI-reply validators share; each pushes its errors onto `errors`. */
export function checks(errors: string[]) {
  const str = (at: string, v: unknown, max: number) => {
    if (!text(v)) errors.push(`${at}: must be a non-empty string`);
    else if (v.length > max) errors.push(`${at}: must be at most ${max} characters`);
    else if (CONTROL.test(v)) errors.push(`${at}: must not contain control characters`);
  };
  const list = (at: string, v: unknown): unknown[] => {
    if (!Array.isArray(v)) return errors.push(`${at}: must be a list`), [];
    if (v.length > MAX) return errors.push(`${at}: at most ${MAX} entries`), [];
    return v;
  };
  const keys = (at: string, o: Record<string, unknown>, ok: string[]) => {
    let extra = 0;
    for (const k of Object.keys(o)) {
      if (ok.includes(k)) continue;
      if (++extra <= 10) errors.push(`${at}${cut(k)}: unknown key`);
    }
    if (extra > 10) errors.push(`…and ${extra - 10} more unknown keys`);
  };
  return { str, list, keys };
}

/** Checks the reviewer's file against the scan and the installed items. The reviewer can only add context: there is no severity key to lower. */
export function validateVetReview(raw: unknown, scan: ScanResult, installed: string[] | null): { ok: true; review: VetReview } | { ok: false; errors: string[] } {
  const s = scan as Partial<ScanResult> | null;
  if (!isObj(s) || !Array.isArray(s.findings) || typeof s.sha !== 'string' || !/^[0-9a-f]{40}$/.test(s.sha)) return { ok: false, errors: ['scan: not a vet scan; run harness vet --json first'] };
  if (!isObj(raw)) return { ok: false, errors: ['vet-review: must be a mapping'] };
  const errors: string[] = [];
  const { str, list, keys } = checks(errors);
  keys('', raw, ['relevance', 'why', 'overlaps', 'injection', 'recommendation', 'summary']);
  if (!['high', 'medium', 'low', 'none'].includes(raw.relevance as string)) errors.push('relevance: must be high, medium, low or none');
  if (!['install', 'install-with-care', 'skip'].includes(raw.recommendation as string)) errors.push('recommendation: must be install, install-with-care or skip');
  str('why', raw.why, 500);
  str('summary', raw.summary, 1000);

  let configErr = 0;
  list('overlaps', raw.overlaps).forEach((o, i) => {
    if (!isObj(o)) return void errors.push(`overlaps[${i}]: must be a mapping`);
    keys(`overlaps[${i}].`, o, ['id', 'how']);
    if (typeof o.id !== 'string') errors.push(`overlaps[${i}].id: must be a string`);
    else if (installed && !installed.includes(o.id)) errors.push(`overlaps[${i}].id: ${q(o.id)} is not an installed item`);
    else if (!installed && !configErr++) errors.push("config: .harness/config.yaml could not be read; overlaps can't be checked");
    str(`overlaps[${i}].how`, o.how, 500);
  });

  const hits = new Set(s.findings.filter((f) => f?.rule === 'injection-text').map((f) => `${f.file}\0${f.line}`));
  const seen = new Set<string>();
  list('injection', raw.injection).forEach((e, i) => {
    if (!isObj(e)) return void errors.push(`injection[${i}]: must be a mapping`);
    keys(`injection[${i}].`, e, ['file', 'line', 'verdict', 'why']);
    if (e.verdict !== 'benign' && e.verdict !== 'suspicious') errors.push(`injection[${i}].verdict: must be benign or suspicious`);
    str(`injection[${i}].why`, e.why, 500);
    if (typeof e.file !== 'string') errors.push(`injection[${i}].file: must be a string`);
    else if (!Number.isInteger(e.line)) errors.push(`injection[${i}].line: must be an integer`);
    else if (!hits.has(`${e.file}\0${e.line}`)) errors.push(`injection[${i}]: no injection-text finding at ${q(e.file)}:${e.line}`);
    else if (seen.has(`${e.file}\0${e.line}`)) errors.push(`injection[${i}]: duplicate ${q(e.file)}:${e.line}`);
    else seen.add(`${e.file}\0${e.line}`);
  });
  return errors.length ? { ok: false, errors } : { ok: true, review: raw as unknown as VetReview };
}
