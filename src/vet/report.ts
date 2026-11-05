import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VetReview } from '../ai/vet-review.js';
import type { Exec } from '../core/exec.js';
import { show, type ScanResult, type VetFinding } from './scan.js';
import type { Resolved } from './target.js';

export const CAVEAT = "A scan can't prove an item is safe. It checks for known risky patterns only; read the high findings yourself before you install.";
const SAFE = /^[A-Za-z0-9._-]+$/;
const SEVS = ['high', 'medium', 'low'] as const;
const where = (f: VetFinding): string => (f.file ? `${show(f.file)}${f.line ? `:${f.line}` : ''}` : '');
const sp = (s: string): string => (s ? ` ${s}` : '');

export function summaryLines(s: ScanResult, review: VetReview | null, reportRel: string): string[] {
  const n = (v: string) => s.findings.filter((f) => f.severity === v).length;
  const high = s.findings.filter((f) => f.severity === 'high');
  const shown = high.length > 6 ? 5 : high.length;
  const um = s.context.unmeasured;
  return [
    `Vetted: ${show(s.repo)}@${s.sha}${s.path ? `:${show(s.path)}` : ''}`,
    `Findings: ${n('high')} high, ${n('medium')} medium, ${n('low')} low`,
    ...high.slice(0, shown).map((f) => `  [high] ${f.rule}${sp(where(f))} ${show(f.text)}`),
    ...(high.length > shown ? [`  …and ${high.length - shown} more high findings in the report.`] : []),
    `Context: ~${s.context.tokens} tokens always loaded (estimate)${um.length ? `; not measured: ${um.map(show).join(', ')}` : ''}`,
    ...(review
      ? [`Relevance: ${review.relevance}. Overlaps: ${review.overlaps.map((o) => show(o.id)).join(', ') || 'none'}`, `Recommendation: ${review.recommendation}`]
      : ['Not reviewed: run /harness:vet inside Claude Code for relevance and a recommendation.']),
    `Full report: ${show(reportRel)}`,
  ];
}

export interface InstallInfo { name: string; market: string | null; marketRepo: string | null }

const readJson = (p: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(readFileSync(p, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
};
const safeName = (v: unknown): v is string => typeof v === 'string' && SAFE.test(v);

/** The marketplace.json comes from the untrusted repo: read as data, names must match the safe shape. */
export function installInfo(dir: string, r: Resolved): InstallInfo {
  if (r.name && r.market) return { name: r.name, market: r.market, marketRepo: r.marketRepo ?? null };
  const m = existsSync(join(dir, '.claude-plugin', 'marketplace.json')) ? readJson(join(dir, '.claude-plugin', 'marketplace.json')) : null;
  if (m && safeName(m.name) && Array.isArray(m.plugins)) {
    for (const e of m.plugins as unknown[]) {
      if (typeof e !== 'object' || e === null) continue;
      const { name, source } = e as { name?: unknown; source?: unknown };
      const hit = typeof source === 'string'
        ? source.startsWith('.') && source.replace(/^\.\//, '').replace(/^\.$/, '').replace(/\/+$/, '') === r.path
        : typeof source === 'object' && source !== null && (source as { source?: unknown }).source === 'github' && (source as { repo?: unknown }).repo === r.repo && r.path === '';
      if (hit && safeName(name)) return { name, market: m.name, marketRepo: r.repo };
    }
  }
  const pj = readJson(join(dir, ...(r.path ? r.path.split('/') : []), '.claude-plugin', 'plugin.json'));
  const last = r.path.split('/').pop() ?? '';
  const name = safeName(pj?.name) ? pj.name : SAFE.test(last) ? last : r.repo.split('/')[1]!;
  return { name, market: null, marketRepo: null };
}

export function aheadBy(r: Resolved, exec: Exec): number | null {
  const o = exec('gh', ['api', `repos/${r.repo}/compare/${r.sha}...${r.ref}`, '--jq', '.ahead_by']);
  const t = o.stdout.trim();
  return o.status === 0 && /^\d+$/.test(t) ? Number(t) : null;
}

export function installLines(s: ScanResult, info: InstallInfo, ahead: number | null): string[] {
  const sha7 = s.sha.slice(0, 7);
  const entry = s.path
    ? { name: info.name, source: { source: 'git-subdir', url: s.repo, path: s.path, sha: s.sha } }
    : { name: info.name, source: { source: 'github', repo: s.repo, sha: s.sha } };
  return [
    ...(info.market
      ? [`claude plugin marketplace add ${info.marketRepo ?? s.repo}`, `claude plugin install ${info.name}@${info.market} --scope project`]
      : ['No marketplace lists this item; add the pinned entry below to a marketplace you control.']),
    ...(ahead === null ? [`Could not check how far HEAD is past the vetted ${sha7}.`]
      : ahead > 0 ? [`HEAD is ${ahead} commits past the vetted ${sha7}; marketplace add installs HEAD, not what was vetted.`] : []),
    'Pinned marketplace entry:',
    JSON.stringify(entry),
  ];
}

export function reportMarkdown(s: ScanResult, review: VetReview | null, install: string[]): string {
  const out = ['# Vet report', '', '## Summary', '', ...summaryLines(s, review, '(this file)'), '', '## Findings'];
  for (const sev of SEVS) {
    out.push('', `### ${sev[0]!.toUpperCase()}${sev.slice(1)}`, '');
    const fs = s.findings.filter((f) => f.severity === sev);
    out.push(...(fs.length ? fs.map((f) => `- ${f.rule}${f.file ? ` \`${where(f)}\`` : ''} ${show(f.text)}`) : ['None.']));
  }
  out.push('', '## Review', '');
  if (!review) out.push('Not reviewed.');
  else out.push(
    `Relevance: ${review.relevance}. ${show(review.why)}`,
    ...review.overlaps.map((o) => `- Overlaps ${show(o.id)}: ${show(o.how)}`),
    ...review.injection.map((i) => `- Injection ${show(i.file)}:${i.line} ${i.verdict}: ${show(i.why)}`),
    `Recommendation: ${review.recommendation}`,
    show(review.summary),
  );
  out.push('', '## Install', '', '```', ...install, '```', '', CAVEAT);
  return out.join('\n') + '\n';
}
