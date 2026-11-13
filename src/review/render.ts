import type { PrFinding, PrReview } from '../ai/pr-review.js';
import { redactSecrets } from '../core/secrets.js';
import { escPath } from './context.js';
import type { GatherJson } from './gather.js';

export const CODE_ONLY = 'Code-only review: the app was not run.';
export const NEEDS_HUMAN = 'Needs human action before merge; do not auto-merge.';
const STEERING_MAX = 5;

const ZW = '​';
// Every ASCII punctuation character CommonMark can start markup with: escaped, no link, image, HTML, emphasis, heading,
// list, table or code span can form, nor a reference definition that a later field could use.
const MARKUP = /[\\`*_{}[\]()<>#+\-.!|~&$]/g; // $ too: GitHub renders $…$ as math
/** Numeric entities decode first (not to a control character), so `&#64;` can't reassemble an `@` after escaping. */
const decode = (s: string) => s.replace(/&#(x[0-9a-f]{1,6}|\d{1,7});/gi, (m, n: string) => {
  const cp = n[0] === 'x' || n[0] === 'X' ? parseInt(n.slice(1), 16) : Number(n);
  return cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0x7f && cp <= 0x9f) && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
});
/** U+200B after `@`, after a scheme, `www` or `GH` (before `-<digit>`), and before `#<digit>`: GitHub makes no mention, team ping, cross-reference or autolink. */
const unlink = (s: string) => s.replace(/@/g, `@${ZW}`).replace(/([a-z][a-z0-9+.-]*):\/\//gi, `$1${ZW}://`).replace(/\bwww\./gi, `www${ZW}.`).replace(/#(?=\d)/g, `${ZW}#`).replace(/\b(gh)(?=-\d)/gi, `$1${ZW}`);

/** Spec §9 R6, as the controller ruled: reviewer and PR text is shown as plain text, never markup; secrets are redacted. */
export function renderText(s: string): string {
  return unlink(redactSecrets(decode(s))).replace(MARKUP, '\\$&');
}

/** PR text shown as code: backticks inside can't end the span early. */
const asCode = (s: string) => `\`${unlink(redactSecrets(decode(s))).replace(/`/g, "'")}\``;

export const verdict = (kept: PrFinding[]): 'Request changes' | 'Comment' => (kept.some((f) => f.severity === 'critical') ? 'Request changes' : 'Comment');

export function commentBody(f: PrFinding): string {
  const ev = f.evidence.kind === 'quote' ? renderText(f.evidence.text) : `no test matches ${asCode(f.evidence.search)}`;
  return `[${f.severity}] ${renderText(f.title)}\n\nEvidence: ${ev}\n\nFix: ${renderText(f.fix)}`;
}

export interface SummaryParams { g: GatherJson; review: PrReview; kept: PrFinding[]; inSummary: PrFinding[]; collapsed: number; maxFindings: number }

/** The review body, in the plan's order (Task 8). It never claims full coverage: the omitted files are listed. */
export function summaryBody(p: SummaryParams): string {
  const { g, review } = p;
  const human = g.labels.includes('needs-human') || p.kept.some((f) => f.severity === 'critical' && f.category === 'pr-description');
  const steering = review.steering.slice(0, STEERING_MAX);
  const parts = [
    `Suggested verdict: ${verdict(p.kept)}`,
    ...(g.fork ? [`From a fork: ${renderText(g.fork)}`] : []),
    ...(human ? [NEEDS_HUMAN] : []),
    ...(g.body_template && g.body_problems.length ? [`PR body check: ${g.body_problems.join('; ')}`] : []),
    ...(p.inSummary.length ? [p.inSummary.map((f) => `- ${renderText(escPath(f.file))}:${f.line} [${f.severity}] ${renderText(f.title)}`).join('\n')] : []),
    ...(p.collapsed ? [`${p.collapsed} more findings not shown (review.max_findings is ${p.maxFindings})`] : []),
    ...(g.omitted.length ? [g.omitted.map((o) => `- ${renderText(escPath(o.path))}: ${renderText(escPath(o.why))}`).join('\n')] : []),
    ...(steering.length ? [`Text in this PR that addresses the reviewer:\n${steering.map((s) => `- ${asCode(s.text)}`).join('\n')}`] : []),
    renderText(review.summary),
    renderText(review.limits),
    CODE_ONLY,
  ];
  return parts.join('\n\n') + '\n';
}
