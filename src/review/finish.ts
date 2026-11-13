import { readFileSync } from 'node:fs';
import { validatePrJudge } from '../ai/pr-judge.js';
import type { PrFinding } from '../ai/pr-review.js';
import type { CliEnv } from '../cli/index.js';
import { esc } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { unattendedEnv } from '../core/unattended.js';
import { ghLogin, pendingReview } from './gh.js';
import { payloadSha, writeRecord, type Payload, type RecordFinding } from './record.js';
import { commentBody, summaryBody, verdict } from './render.js';
import { readFindings, verifyFindings } from './verify.js';
import { escPath } from './context.js';

const JUDGE_DROP = 'judge: evidence does not support the claim';
const CAP_DROP = 'over review.max_findings';
const RANK = { critical: 0, medium: 1, nit: 2 };
const KIND = (reason: string) => (reason === JUDGE_DROP ? 'judge' : reason === CAP_DROP ? 'cap' : reason.startsWith('a test matching') ? 'test-exists' : 'evidence');
const where = (f: PrFinding) => `${escPath(f.file)}:${f.line} [${f.severity}] ${f.title}`;

/** `review --finish <dir> --findings <file> --judge <file>`: verify, apply the judge, cap, place, render, record, preview. Posts nothing. */
export function finish(dir: string, findingsFile: string, judgeFile: string, { root, env, out }: CliEnv, deps: { exec?: Exec } = {}): number {
  const exec = deps.exec ?? defaultExec;
  const r = readFindings(root, dir, findingsFile);
  if ('errors' in r) return r.errors.forEach((e) => out(e)), 2;
  const { g, review } = r;
  try {
    const v = verifyFindings(review, g, r.dir, exec, root);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(judgeFile, 'utf8')); } catch (e) {
      return out(`judge: could not read "${esc(judgeFile)}" as JSON (${(e as NodeJS.ErrnoException).code ?? 'not valid JSON'})`), 2;
    }
    const j = validatePrJudge(raw, v.kept.map((f) => f.id));
    if (!j.ok) return ['judge: not valid; run harness validate pr-judge first', ...j.errors].forEach((e) => out(e)), 2;
    const why = new Map(j.judge.verdicts.map((x) => [x.id, x]));

    const dropped: { f: PrFinding; reason: string }[] = [...v.dropped];
    const supported = v.kept.filter((f) => why.get(f.id)!.supported || (dropped.push({ f, reason: JUDGE_DROP }), false));
    supported.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
    const placed = supported.slice(0, g.max_findings);
    for (const f of supported.slice(g.max_findings)) dropped.push({ f, reason: CAP_DROP });
    const inline = placed.filter((f) => g.lines[f.file]?.[f.side].includes(f.line));
    const inSummary = placed.filter((f) => !inline.includes(f));

    const payload: Payload = {
      body: summaryBody({ g, review, kept: placed, inSummary, collapsed: supported.length - placed.length, maxFindings: g.max_findings }),
      comments: inline.map((f) => ({ path: f.file, line: f.line, side: f.side, body: commentBody(f) })),
    };
    const login = ghLogin(exec);
    if (typeof login !== 'string') return out(login.error), 1;
    const pending = pendingReview(exec, g.repo, g.pr, login);
    if (pending && 'error' in pending) return out(pending.error), 1;

    const reasonOf = new Map(dropped.map((d) => [d.f.id, d.reason]));
    const findings: RecordFinding[] = review.findings.map((f) => ({
      ...f, placement: inline.includes(f) ? 'inline' : inSummary.includes(f) ? 'summary' : 'dropped',
      ...(reasonOf.has(f.id) && { dropped_reason: reasonOf.get(f.id)! }), ...(why.has(f.id) && { judge_why: why.get(f.id)!.why }),
    }));
    const vd = verdict(placed);
    writeRecord(root, { schema: 'harness-pr-review/1', repo: g.repo, pr: g.pr, base_sha: g.base_sha, head_sha: g.head_sha, created: new Date().toISOString(), findings, omitted: g.omitted, verdict: vd, payload, payload_sha256: payloadSha(payload), posted: null, history: [] });

    const sha7 = g.head_sha.slice(0, 7), ts = () => new Date().toISOString();
    for (const d of dropped) appendEvent(root, { ts: ts(), session: 'cli', check: 'review', decision: 'review-finding-dropped', reason: `pr ${g.pr} ${sha7} ${KIND(d.reason)}` });
    appendEvent(root, { ts: ts(), session: 'cli', check: 'review', decision: 'review-previewed', reason: `pr ${g.pr} ${sha7} inline ${inline.length} summary ${inSummary.length} dropped ${dropped.length}` });

    out(`Review of PR #${g.pr} at ${sha7}. Nothing is posted.`);
    out('--- Summary ---');
    out(payload.body.trimEnd());
    out('--- Inline comments ---');
    for (const f of inline) out(where(f));
    out('--- Dropped ---');
    for (const d of dropped) out(`dropped ${where(d.f)}: ${d.reason}${d.reason === JUDGE_DROP ? ` (judge: ${why.get(d.f.id)!.why})` : ''}`);
    out(`Suggested verdict: ${vd}`);
    if (pending) out(`Existing pending review: ${pending.id} with ${pending.comments} comments`);
    out(`Record: .harness/reviews/${g.pr}.json (local; nothing was posted)`);
    if (unattendedEnv(env)) out('pending review not posted: unattended run');
    return 0;
  } catch (e) {
    return out((e as Error).message), 1;
  }
}
