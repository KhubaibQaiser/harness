import { esc, isObj } from '../core/config.js';
import type { Exec } from '../core/exec.js';

// Every gh call the reviewer makes. Field names are unverified until the live proof (plan, "After PR E").
export interface PrView {
  number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; isCrossRepository: boolean; headRepository: string;
  baseRefName: string; baseRefOid: string; headRefOid: string; author: string; title: string; body: string; url: string;
  labels: string[]; closingIssues: number[]; comments: string[]; reviews: string[];
}
type Err = { error: string };
type R = ReturnType<Exec>;

const FIELDS = 'number,state,isDraft,isCrossRepository,headRepository,headRepositoryOwner,baseRefName,baseRefOid,headRefOid,author,title,body,url,labels,closingIssuesReferences,comments,reviews';
const SHA = /^[0-9a-f]{40}$/;
const first = (r: R) => esc((r.stderr ?? '').split('\n')[0]!.trim());
const json = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
/** `--jq '<expr> | tojson'` output: one JSON value per line. Undefined when any line is not JSON. */
const lines = (s: string): unknown[] | undefined => {
  const out = s.split('\n').filter((l) => l.trim()).map(json);
  if (out.some((v) => v === undefined)) return undefined;
  return out.map((v) => (typeof v === 'string' && /^[[{]/.test(v) ? json(v) : v));
};

/** A PR number, or the URL `https://github.com/<repo>/pull/<n>` of a PR in this repo (case-insensitive). */
export function parsePr(arg: string, repo: string): number | Err {
  const u = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/i.exec(arg);
  const digits = u ? (u[1]!.toLowerCase() === repo.toLowerCase() ? u[2]! : '') : arg;
  const n = /^[1-9]\d*$/.test(digits) ? Number(digits) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : { error: `review: not a PR number or a PR URL in ${repo}: ${esc(arg.slice(0, 120))}` };
}

export function preflight(exec: Exec): { repo: string } | Err {
  const a = exec('gh', ['auth', 'status', '--hostname', 'github.com']);
  if (a.missing) return { error: 'review: needs the GitHub CLI (gh). Install it, run gh auth login, then run the review again.' };
  if (a.status !== 0) return { error: 'review: gh is not logged in for github.com (gh auth status failed). Run gh auth login.' };
  const v = exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const repo = v.stdout.trim();
  return v.status === 0 && /^[\w.-]+\/[\w.-]+$/.test(repo) ? { repo } : { error: 'review: origin is not a GitHub repo' };
}

/** §8: a rate limit names its reset time; anything else names what failed, the HTTP status and gh's first line. */
export function ghError(exec: Exec, r: R, what: string): string {
  const err = r.stderr ?? '';
  const http = /HTTP (\d{3})/.exec(err)?.[1];
  if ((http === '403' || http === '429') && /rate limit/i.test(err)) {
    const reset = Number(exec('gh', ['api', 'rate_limit', '--jq', '.resources.core.reset']).stdout.trim());
    return `review: GitHub rate limit hit; resets at ${reset > 0 ? new Date(reset * 1000).toLocaleString() : 'an unknown time (gh api rate_limit failed)'}`;
  }
  return `review: ${what} failed (${http ? `HTTP ${http}` : `gh exit ${r.status}`}): ${first(r)}`;
}

const strs = (v: unknown, key: string): string[] | undefined =>
  Array.isArray(v) && v.every((x) => isObj(x) && typeof x[key] === 'string') ? v.map((x) => (x as Record<string, string>)[key]!) : undefined;

export function prView(exec: Exec, repo: string, n: number): PrView | Err {
  const r = exec('gh', ['pr', 'view', String(n), '--repo', repo, '--json', FIELDS]);
  if (r.status !== 0) return /could not resolve to a pullrequest|not found/i.test(r.stderr ?? '') ? { error: `review: PR #${n} not found in ${repo}: ${first(r)}` } : { error: ghError(exec, r, 'gh pr view') };
  const v = json(r.stdout);
  const bad = { error: 'review: gh pr view returned an unexpected shape' };
  if (!isObj(v)) return bad;
  const head = isObj(v.headRepository) && isObj(v.headRepositoryOwner) ? `${v.headRepositoryOwner.login}/${v.headRepository.name}` : '';
  const issues = Array.isArray(v.closingIssuesReferences) && v.closingIssuesReferences.every((x) => isObj(x) && Number.isSafeInteger(x.number)) ? v.closingIssuesReferences.map((x) => (x as { number: number }).number) : undefined;
  const p = {
    number: v.number, state: v.state, isDraft: v.isDraft, isCrossRepository: v.isCrossRepository, headRepository: head, baseRefName: v.baseRefName, baseRefOid: v.baseRefOid,
    headRefOid: v.headRefOid, author: isObj(v.author) ? v.author.login : undefined, title: v.title, body: v.body, url: v.url,
    labels: strs(v.labels, 'name'), closingIssues: issues, comments: strs(v.comments, 'body'), reviews: strs(v.reviews, 'body'),
  };
  const ok = p.number === n && ['OPEN', 'CLOSED', 'MERGED'].includes(p.state as string) && typeof p.isDraft === 'boolean' && typeof p.isCrossRepository === 'boolean'
    && SHA.test(String(p.baseRefOid)) && SHA.test(String(p.headRefOid)) && [p.baseRefName, p.author, p.title, p.body, p.url].every((s) => typeof s === 'string')
    && p.labels && p.closingIssues && p.comments && p.reviews;
  return ok ? (p as PrView) : bad;
}

/** Inline review comments: `gh pr view` has none. One JSON string per line, so multi-line bodies stay whole. */
export function reviewComments(exec: Exec, repo: string, n: number): string[] | Err {
  const r = exec('gh', ['api', '--paginate', `repos/${repo}/pulls/${n}/comments`, '--jq', '.[].body | tojson']);
  if (r.status !== 0) return { error: ghError(exec, r, 'review comments') };
  const out = lines(r.stdout);
  return out?.every((s) => typeof s === 'string') ? (out as string[]) : { error: 'review: review comments returned an unexpected shape' };
}

export function issueView(exec: Exec, k: number): { title: string; body: string } | Err {
  const r = exec('gh', ['issue', 'view', String(k), '--json', 'title,body']);
  if (r.status !== 0) return { error: ghError(exec, r, `gh issue view ${k}`) };
  const v = json(r.stdout);
  return isObj(v) && typeof v.title === 'string' && typeof v.body === 'string' ? { title: v.title, body: v.body } : { error: `review: gh issue view ${k} returned an unexpected shape` };
}

export function ghLogin(exec: Exec): string | Err {
  const r = exec('gh', ['api', 'user', '--jq', '.login']);
  const login = r.stdout.trim();
  return r.status === 0 && login ? login : { error: r.status === 0 ? 'review: gh api user returned no login' : ghError(exec, r, 'gh api user') };
}

/** This login's PENDING review on the PR, with its comment count (one pending review per user is unverified). */
export function pendingReview(exec: Exec, repo: string, n: number, login: string): { id: number; node_id: string; comments: number } | null | Err {
  const r = exec('gh', ['api', '--paginate', `repos/${repo}/pulls/${n}/reviews`, '--jq', '.[] | tojson']);
  if (r.status !== 0) return { error: ghError(exec, r, 'reviews') };
  const all = lines(r.stdout);
  if (!all?.every((x) => isObj(x) && Number.isSafeInteger(x.id) && typeof x.node_id === 'string' && typeof x.state === 'string')) return { error: 'review: reviews returned an unexpected shape' };
  const p = (all as { id: number; node_id: string; state: string; user?: { login?: string } }[]).find((x) => x.state === 'PENDING' && x.user?.login === login);
  if (!p) return null;
  const c = exec('gh', ['api', '--paginate', `repos/${repo}/pulls/${n}/reviews/${p.id}/comments`, '--jq', '.[].id']);
  if (c.status !== 0) return { error: ghError(exec, c, 'pending review comments') };
  return { id: p.id, node_id: p.node_id, comments: c.stdout.split('\n').filter((l) => l.trim()).length };
}
