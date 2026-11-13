import { isObj } from '../core/config.js';
import type { GatherJson } from '../review/gather.js';
import { checks, q } from './vet-review.js';

/** The rubric's 13 questions as slugs (spec §7.1 and §14). */
export const CATEGORIES = ['correctness', 'failure-modes', 'security', 'performance', 'accessibility', 'seo', 'operability', 'design', 'simplicity', 'tests', 'agents-md', 'product', 'pr-description'] as const;
export type Category = (typeof CATEGORIES)[number];
export interface PrFinding {
  id: string; severity: 'critical' | 'medium' | 'nit'; category: Category; file: string; line: number; side: 'RIGHT' | 'LEFT'; title: string;
  evidence: { kind: 'quote'; text: string } | { kind: 'missing-test'; search: string }; fix: string;
}
const SOURCES = new Set(['title', 'body', 'comment', 'issue', 'diff', 'file'] as const);
export type SteeringSource = typeof SOURCES extends Set<infer T> ? T : never;
export interface PrReview { findings: PrFinding[]; steering: { source: SteeringSource; text: string }[]; summary: string; limits: string }

/** The reviewer's findings.json as data (spec §7.2). More findings than review.max_findings is not an error: finish collapses them. */
export function validatePrReview(raw: unknown, g: GatherJson, inSnapshot: (file: string) => boolean): { ok: true; review: PrReview } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['pr-review: must be a mapping'] };
  const errors: string[] = [];
  const { str, list, keys } = checks(errors);
  keys('', raw, ['findings', 'steering', 'summary', 'limits']);
  const inPr = new Set(g.files.map((f) => f.path));
  const ids = new Set<string>();
  list('findings', raw.findings).forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!isObj(f)) return void errors.push(`${at}: must be a mapping`);
    keys(`${at}.`, f, ['id', 'severity', 'category', 'file', 'line', 'side', 'title', 'evidence', 'fix']);
    str(`${at}.id`, f.id, 100);
    if (typeof f.id === 'string') {
      if (ids.has(f.id)) errors.push(`${at}.id: duplicate ${q(f.id)}`);
      ids.add(f.id);
    }
    if (!['critical', 'medium', 'nit'].includes(f.severity as string)) errors.push(`${at}.severity: must be critical, medium or nit`);
    if (!(CATEGORIES as readonly string[]).includes(f.category as string)) errors.push(`${at}.category: must be one of the 13 rubric categories`);
    if (typeof f.file !== 'string') errors.push(`${at}.file: must be a string`);
    else if (!inPr.has(f.file) && !inSnapshot(f.file)) errors.push(`${at}.file: ${q(f.file)} is not in this PR or its snapshot`);
    if (!Number.isSafeInteger(f.line) || (f.line as number) < 1) errors.push(`${at}.line: must be a positive integer`);
    if (f.side !== 'RIGHT' && f.side !== 'LEFT') errors.push(`${at}.side: must be RIGHT or LEFT`);
    str(`${at}.title`, f.title, 200);
    str(`${at}.fix`, f.fix, 500);
    const e = f.evidence;
    if (!isObj(e)) return void errors.push(`${at}.evidence: must be a mapping`);
    if (e.kind === 'quote') { keys(`${at}.evidence.`, e, ['kind', 'text']); str(`${at}.evidence.text`, e.text, 500); }
    else if (e.kind === 'missing-test') { keys(`${at}.evidence.`, e, ['kind', 'search']); str(`${at}.evidence.search`, e.search, 500); }
    else errors.push(`${at}.evidence.kind: must be quote or missing-test`);
  });
  list('steering', raw.steering).forEach((s, i) => {
    if (!isObj(s)) return void errors.push(`steering[${i}]: must be a mapping`);
    keys(`steering[${i}].`, s, ['source', 'text']);
    if (!SOURCES.has(s.source as SteeringSource)) errors.push(`steering[${i}].source: must be title, body, comment, issue, diff or file`);
    str(`steering[${i}].text`, s.text, 500);
  });
  str('summary', raw.summary, 2000);
  str('limits', raw.limits, 1000);
  return errors.length ? { ok: false, errors } : { ok: true, review: raw as unknown as PrReview };
}
