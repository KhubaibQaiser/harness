import type { PrFinding, PrReview } from '../ai/pr-review.js';
import { redactSecrets } from '../core/secrets.js';
import { escPath } from './context.js';
import type { GatherJson } from './gather.js';

export const CODE_ONLY = 'Code-only review: the app was not run.';
export const NEEDS_HUMAN = 'Needs human action before merge; do not auto-merge.';
const STEERING_MAX = 5;

const github = (url: string) => { try { return new URL(url).hostname === 'github.com'; } catch { return false; } };
/** Each part of `s` outside `code spans`, transformed; code spans stay as they are. */
const outsideCode = (s: string, f: (t: string) => string) => s.split(/(`[^`\n]*`)/).map((p, i) => (i % 2 ? p : f(p))).join('');

/** Spec §9 R6: comment text can't ping people, load images, carry raw HTML or link off github.com; then secrets are redacted. */
export function renderText(s: string): string {
  const linked = outsideCode(s, (t) => t
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => (github(url) ? m : `${text} (${url})`))
    .replace(/(?<![\w`])https?:\/\/[^\s<>()`]+/g, (u) => (github(u) ? u : `\`${u}\``)));
  return redactSecrets(outsideCode(linked, (t) => t.replace(/(^|[^\w`/])@([A-Za-z0-9][\w-]*(?:\/[\w.-]+)?)/g, '$1`@$2`')));
}

/** PR text shown as code: backticks inside can't end the span early. */
const asCode = (s: string) => `\`${redactSecrets(s).replace(/`/g, "'")}\``;

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
    ...(g.omitted.length ? [g.omitted.map((o) => `- ${renderText(escPath(o.path))}: ${o.why}`).join('\n')] : []),
    ...(steering.length ? [`Text in this PR that addresses the reviewer:\n${steering.map((s) => `- ${asCode(s.text)}`).join('\n')}`] : []),
    renderText(review.summary),
    renderText(review.limits),
    CODE_ONLY,
  ];
  return parts.join('\n\n') + '\n';
}
