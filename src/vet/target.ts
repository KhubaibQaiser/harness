import { DIR_JQ, isNotFound } from '../catalog/resolve.js';
import { esc } from '../core/config.js';
import type { Exec } from '../core/exec.js';

export type Target = { kind: 'repo'; repo: string; ref?: string; path: string } | { kind: 'plugin'; name: string; market: string };
export interface Resolved { repo: string; ref: string; sha: string; path: string; name?: string; market?: string; marketRepo?: string }
type Err = { error: string };

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
export const REPO = { test: (s: string): boolean => REPO_RE.test(s) && !['.', '..', '.git'].includes(s.split('/')[1]) };
const NAME = /^[A-Za-z0-9._-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const VERIFY = 'Check your network or run gh auth status, then try again.';
const URL_INSTEAD = "Pass the plugin's GitHub URL instead.";
/** A ref or path that is safe to put in a gh api endpoint: allowed characters, no `..` segment, no leading `/`. */
export const safe = (s: string): boolean => /^[A-Za-z0-9._/-]+$/.test(s) && !s.startsWith('/') && !s.split('/').some((x) => x === '' || x === '.' || x === '..');
const bad = (s: string): Err => ({ error: `Not a GitHub repo, tree URL or plugin@marketplace: ${esc(s)}. Use https://github.com/<owner>/<repo>, owner/repo[#ref] or plugin@marketplace.` });
const noGh = { error: 'harness vet needs the GitHub CLI (gh). Install the GitHub CLI (gh), then run harness vet again.' };

export function parseTarget(s: string): Target | Err {
  const repoT = (repo: string, ref: string | undefined, path: string): Target | Err =>
    REPO.test(repo) && (ref === undefined || safe(ref)) && (path === '' || safe(path)) ? { kind: 'repo', repo, ...(ref ? { ref } : {}), path } : bad(s);
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(s);
  // ponytail: the first segment after tree/ is the ref, so a branch name with a slash is misread; use owner/repo#ref for those.
  if (url) return repoT(url[1], url[2], (url[3] ?? '').replace(/\/+$/, ''));
  const pm = /^([^@/#]+)@([^@/#]+)$/.exec(s);
  if (pm) return NAME.test(pm[1]) && NAME.test(pm[2]) ? { kind: 'plugin', name: pm[1], market: pm[2] } : bad(s);
  const [repo, ref, ...rest] = s.split('#');
  return rest.length || (ref !== undefined && ref === '') ? bad(s) : repoT(repo, ref, '');
}

/** Runs gh, returning stdout or a ready-to-show error. `what` names the thing for messages; notFound overrides the 404 text. */
function gh(exec: Exec, args: string[], repo: string, what: string, notFound = `${repo}: ${what} not found on GitHub. Check the URL or ref.`): { out: string } | { absent: true; error: string } | Err {
  const r = exec('gh', args);
  if (r.missing) return noGh;
  if (r.status === 0) return { out: r.stdout.trim() };
  if (isNotFound(r.stderr)) return { absent: true, error: notFound };
  const e = (r.stderr ?? '').trim().split('\n')[0];
  return { error: `${esc(repo)}: could not verify ${esc(what)} (gh exited ${r.status})${e ? `: ${esc(e)}` : ''}${e.endsWith('.') ? '' : '.'} ${VERIFY}` };
}
const failed = (r: ReturnType<typeof gh>): Err | null => ('error' in r ? { error: r.error } : null);

/** Pins repo@ref (default branch when no ref) to a commit sha. */
function pin(repo: string, ref: string | undefined, exec: Exec): { ref: string; sha: string } | Err {
  let name = ref;
  if (!name) {
    const d = gh(exec, ['api', `repos/${repo}`, '--jq', '.default_branch'], repo, 'default branch');
    const f = failed(d);
    if (f) return f;
    name = (d as { out: string }).out;
    if (!safe(name)) return { error: `${esc(repo)}: could not verify default branch (gh returned no branch name). ${VERIFY}` };
  }
  const c = gh(exec, ['api', `repos/${repo}/commits/${name}`, '--jq', '.sha'], repo, name, `${esc(repo)}: ${esc(name)} not found on GitHub. Check the URL or ref.`);
  const f = failed(c);
  if (f) return f;
  const sha = (c as { out: string }).out;
  return SHA40.test(sha) ? { ref: name, sha } : { error: `${esc(repo)}: could not verify ${esc(name)} (gh returned no commit sha). ${VERIFY}` };
}

/** Pins a sha the marketplace supplied: gh must echo the same commit back. */
function pinSha(repo: string, sha: string, exec: Exec): { ref: string; sha: string } | Err {
  const p = pin(repo, sha, exec);
  if ('error' in p) return p;
  return p.sha === sha ? p : { error: `${esc(repo)}: could not verify ${sha} (gh returned a different commit). ${VERIFY}` };
}

const J = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The installed marketplaces (`claude plugin marketplace list --json`, free, no model call), or why they can't be read. */
export function marketList(exec: Exec): Record<string, unknown>[] | 'missing' | 'unreadable' {
  const l = exec('claude', ['plugin', 'marketplace', 'list', '--json']);
  if (l.missing) return 'missing';
  let list: unknown;
  try { list = JSON.parse(l.stdout); } catch { return 'unreadable'; }
  // ponytail: assumed shape, not verified against a real claude (check in the Task 27 live run): a JSON array of
  // { name, source: 'github', repo: 'owner/repo' } (or { name, repo }); anything else is "could not read".
  if (l.status !== 0 || !Array.isArray(list) || !list.every((x) => J(x) && typeof x.name === 'string')) return 'unreadable';
  return list as Record<string, unknown>[];
}
/** An installed marketplace's GitHub repo, if it names one. */
export const marketRepoOf = (m: Record<string, unknown>): unknown => (typeof m.repo === 'string' ? m.repo : J(m.source) ? m.source.repo : undefined);

function resolvePlugin(t: { name: string; market: string }, exec: Exec): Resolved | Err {
  const name = esc(t.name), market = esc(t.market);
  const notInstalled = { error: `Marketplace "${market}" is not installed. Run harness vet with the plugin's GitHub URL instead, such as https://github.com/<owner>/<repo>.` };
  const list = marketList(exec);
  if (list === 'missing') return notInstalled;
  if (list === 'unreadable') return { error: `Could not read the installed marketplaces from claude. Run claude plugin marketplace list yourself, or ${URL_INSTEAD.charAt(0).toLowerCase()}${URL_INSTEAD.slice(1)}` };
  const m = list.find((x) => x.name === t.market);
  if (!m) return notInstalled;
  const mtype = J(m.source) ? m.source.source : m.source;
  const mrepo = marketRepoOf(m);
  if ((mtype !== undefined && mtype !== 'github') || typeof mrepo !== 'string' || !REPO.test(mrepo)) return { error: `Marketplace "${market}" has a ${esc(String(mtype ?? 'unknown'))} source; vet reads GitHub marketplaces only. ${URL_INSTEAD}` };
  const marketRepo = mrepo;
  const mp = pin(marketRepo, typeof m.ref === 'string' && safe(m.ref) ? m.ref : undefined, exec);
  if ('error' in mp) return mp;
  const raw = gh(exec, ['api', `repos/${marketRepo}/contents/.claude-plugin/marketplace.json?ref=${mp.sha}`, '-H', 'Accept: application/vnd.github.raw'], marketRepo, 'marketplace.json');
  const rf = failed(raw);
  if (rf) return rf;
  let plugins: unknown;
  try { plugins = (JSON.parse((raw as { out: string }).out) as { plugins?: unknown }).plugins; } catch { plugins = undefined; }
  const entry = (Array.isArray(plugins) ? plugins : []).find((x) => J(x) && x.name === t.name) as Record<string, unknown> | undefined;
  if (!entry) return { error: `Plugin "${name}" is not in marketplace "${market}". Check the plugin name, or ${URL_INSTEAD.charAt(0).toLowerCase()}${URL_INSTEAD.slice(1)}` };
  const base = { name: t.name, market: t.market, marketRepo };
  const src = entry.source;

  if (typeof src === 'string') {
    const path = src.startsWith('.') ? src.replace(/^\.\//, '').replace(/^\.$/, '').replace(/\/+$/, '') : '..';
    if (path !== '' && !safe(path)) return { error: `Plugin "${name}" in "${market}" has a path outside the marketplace: "${esc(src)}". ${URL_INSTEAD}` };
    if (path !== '') {
      const where = `${esc(path)}`;
      const d = gh(exec, ['api', `repos/${marketRepo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${mp.sha}`, '--jq', DIR_JQ], marketRepo, path,
        `Plugin "${name}" in "${market}": ${where} not found in ${marketRepo} at ${mp.sha.slice(0, 7)}. ${URL_INSTEAD}`);
      const f = failed(d);
      if (f) return f;
      if ((d as { out: string }).out !== 'dir') return { error: `Plugin "${name}" in "${market}": ${where} is not a folder in ${marketRepo} at ${mp.sha.slice(0, 7)}. ${URL_INSTEAD}` };
    }
    return { repo: marketRepo, path, ref: mp.sha, sha: mp.sha, ...base };
  }

  if (J(src) && (src.source === 'github' || src.source === 'git-subdir')) {
    const url = typeof src.url === 'string' ? /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(src.url)?.[1] : undefined;
    const repo = src.source === 'github' ? src.repo : url;
    const path = src.source === 'git-subdir' && typeof src.path === 'string' ? src.path.replace(/\/+$/, '') : '';
    const ref = typeof src.ref === 'string' ? src.ref : undefined;
    if (typeof repo !== 'string' || !REPO.test(repo) || (path !== '' && !safe(path)) || (ref !== undefined && !safe(ref))) return { error: `Plugin "${name}" in "${market}" has a source vet cannot read. ${URL_INSTEAD}` };
    if (src.sha !== undefined) {
      const sha = typeof src.sha === 'string' && /^[0-9a-fA-F]{40}$/.test(src.sha) ? src.sha.toLowerCase() : undefined;
      if (!sha) return { error: `Plugin "${name}" in "${market}" has a malformed sha: ${esc(String(src.sha))}. ${URL_INSTEAD}` };
      const p = pinSha(repo, sha, exec);
      return 'error' in p ? p : { repo, path, ...p, ...base };
    }
    const p = pin(repo, ref, exec);
    return 'error' in p ? p : { repo, path, ...p, ...base };
  }
  const type = J(src) ? String(src.source) : String(src);
  return { error: `Plugin "${name}" in "${market}" has a ${esc(type)} source; vet checks github, git-subdir and relative-path sources only. ${URL_INSTEAD}` };
}

export function resolveTarget(t: Target, exec: Exec): Resolved | Err {
  if (t.kind === 'plugin') return resolvePlugin(t, exec);
  const p = pin(t.repo, t.ref, exec);
  return 'error' in p ? p : { repo: t.repo, path: t.path, ...p };
}

export function vetId(r: Resolved): string {
  const id = r.name ?? [r.repo.replace('/', '-'), r.path.replace(/\//g, '-')].filter(Boolean).join('-');
  return id.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}
