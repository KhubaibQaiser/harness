import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { bodyProblems, MARKER } from '../checks/pr-body.js';
import type { CliEnv } from '../cli/index.js';
import { writeAtomic } from '../core/atomic.js';
import { packageDir } from '../core/package-dir.js';
import { esc } from '../core/config.js';
import { validateConfig } from '../core/config-io.js';
import { appendEvent } from '../core/events.js';
import { defaultExec, defaultExecBytes, type Exec, type ExecBytes } from '../core/exec.js';
import { SAFE_GIT } from '../core/git-safe.js';
import { unattendedEnv } from '../core/unattended.js';
import { harnessIgnoreText } from '../install/harnessignore.js';
import { LIMITS } from '../vet/fetch.js';
import { baseBlobs, driftCheck, lsTree } from './base.js';
import { contextMd, DELETED_FORK, diffText, newNonce, nonceIn } from './context.js';
import { capDiff, commentable, DIFF_CAP, diffArgs, parseDiff } from './diff.js';
import { issueView, parsePr, preflight, prView, reviewComments } from './gh.js';
import { writeSnapshot } from './snapshot.js';

export interface GatherJson {
  repo: string; pr: number; base: string; base_sha: string; head_sha: string; merge_base: string; nonce: string; fork: string | null; labels: string[]; body_template: boolean; body_problems: string[]; max_findings: number;
  files: { path: string; old_path?: string; status: string; binary: boolean; skipped?: true }[];
  lines: Record<string, { RIGHT: number[]; LEFT: number[] }>; map: Record<string, string>; omitted: { path: string; why: string }[];
}
export interface GatherDeps { exec?: Exec; bytes?: ExecBytes; nonce?: () => string }

const SPECS = 3, SPEC_BYTES = 50 * 1024;
const STATE = '.harness/state/review-gather.json';
const GITHUB_URL = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i;

/** The git remote whose URL is github.com/<repo> (origin first): in a fork workflow that is `upstream`, not `origin`. */
function remoteFor(exec: Exec, repo: string): { name: string } | { error: string } {
  const r = exec('git', [...SAFE_GIT, 'config', '-z', '--get-regexp', '^remote\\..*\\.url$']);
  const names = r.stdout.split('\0').filter(Boolean).map((e) => {
    const nl = e.indexOf('\n');
    return { name: e.slice('remote.'.length, nl - '.url'.length), url: e.slice(nl + 1) };
  }).filter((x) => !x.name.startsWith('-') && GITHUB_URL.exec(x.url)?.[1]?.toLowerCase() === repo.toLowerCase()).map((x) => x.name);
  const name = names.includes('origin') ? 'origin' : names[0];
  return name ? { name } : { error: `review: no git remote points to github.com/${repo}; add one, for example: git remote add upstream https://github.com/${repo}.git` };
}
/** gh's or git's first stderr line, escaped; never empty. */
const gitErr = (r: { status: number; stderr?: string }) => esc((r.stderr ?? '').split('\n').find((l) => l.trim())?.trim() ?? '') || `git exited ${r.status}`;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Up to 3 repo-relative `docs/**\/*.md` paths named in the body, read from the snapshot, 50 KB each. */
function specs(body: string, head: string, map: Record<string, string>): { path: string; text: string }[] {
  const named = [...body.matchAll(/(?<![\w./-])(?:\.\/)?(docs\/[\w./-]+\.md)(?![\w/-])/g)].map((m) => m[1]!).filter((p) => !p.split('/').includes('..'));
  const out: { path: string; text: string }[] = [];
  for (const p of [...new Set(named)]) {
    const file = resolve(head, ...(map[p] ?? p).split('/'));
    if (out.length === SPECS || !file.startsWith(head + sep) || !existsSync(file)) continue;
    const b = readFileSync(file);
    out.push({ path: p, text: b.subarray(0, SPEC_BYTES).toString('utf8') + (b.length > SPEC_BYTES ? '\n[cut at 50 KB]' : '') });
  }
  return out;
}

/** `harness review <pr> --out <dir>`: gathers the PR without running any of its code. Writes only `<dir>/`, the gather hash and an event. */
export function gather(args: string[], { root, env, out }: CliEnv, deps: GatherDeps = {}): number {
  const [arg = '', , outDir = ''] = args;
  const raw = deps.exec ?? defaultExec, bytes = deps.bytes ?? defaultExecBytes;
  const exec: Exec = (c, a, o) => raw(c, a, { cwd: root, ...o });
  const fail = (m: string) => (out(m), 1);
  try {
    const pf = preflight(exec);
    if ('error' in pf) return fail(pf.error);
    const { repo } = pf;
    const n = parsePr(arg, repo);
    if (typeof n !== 'number') return out(n.error), 2;
    const view = prView(exec, repo, n);
    if ('error' in view) return fail(view.error);
    const { baseRefOid: baseSha, headRefOid: headSha, baseRefName: base } = view;
    const fmt = exec('git', [...SAFE_GIT, 'check-ref-format', '--branch', base]);
    if (base.startsWith('-') || fmt.status !== 0 || fmt.stdout.trim() !== base) return fail(`review: the base branch name "${esc(base)}" is not a valid branch name`);
    const remote = remoteFor(exec, repo);
    if ('error' in remote) return fail(remote.error);

    // FETCH_HEAD lists the refspecs in order: the PR head, the PR's base commit (R11), then the base branch tip.
    const f = exec('git', [...SAFE_GIT, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', remote.name, `refs/pull/${n}/head`, baseSha, `refs/heads/${base}`], { timeoutMs: 600_000 });
    const gone = (f.stderr ?? '').split('\n').some((l) => l.trim() === `fatal: couldn't find remote ref refs/heads/${base}`);
    if (f.status !== 0) return fail(gone
      ? `review: base branch ${esc(base)} is not on ${esc(remote.name)} (deleted?); a PR whose base branch is gone cannot be reviewed`
      : `review: git fetch failed: ${gitErr(f)}`);
    const fh = exec('git', [...SAFE_GIT, 'rev-parse', '--git-path', 'FETCH_HEAD']);
    const fetched = readFileSync(resolve(root, fh.stdout.trim()), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')[0]!);
    if (fetched.length !== 3 || fetched[1] !== baseSha) return fail('review: git fetch gave an unexpected FETCH_HEAD; run again');
    if (fetched[0] !== headSha) return fail('review: PR head moved during fetch; run again');
    const tip = fetched[2]!;

    const shallow = exec('git', [...SAFE_GIT, 'rev-parse', '--is-shallow-repository']);
    if (shallow.status !== 0) return fail(`review: git rev-parse --is-shallow-repository failed: ${gitErr(shallow)}`);
    if (shallow.stdout.trim() === 'true') return fail('review: this clone is shallow; fetch the full history (git fetch --unshallow) and retry');

    // Claude Code loaded this session's CLAUDE.md, hooks and .mcp.json from this checkout: it must be the base branch, not the PR.
    const anc = exec('git', [...SAFE_GIT, 'merge-base', '--is-ancestor', 'HEAD', tip]);
    if (anc.status === 1) return fail(`review: this checkout is not ${esc(base)} or behind it (is it the PR branch?). Switch to ${esc(base)} and start a fresh Claude Code session: this one may already have loaded the PR's CLAUDE.md, hooks or .mcp.json.`);
    if (anc.status !== 0) return fail(`review: git merge-base --is-ancestor failed: ${gitErr(anc)}`);

    const commits = [...new Set([baseSha, tip])].map((sha) => ({ sha, blobs: baseBlobs(bytes, root, sha) }));
    const cfgText = commits[0]!.blobs['.harness/config.yaml'];
    if (cfgText == null) return fail(`review: base branch ${esc(base)} has no .harness/config.yaml; run harness init on ${esc(base)} first`);
    let cfgRaw: unknown;
    try { cfgRaw = parse(cfgText); } catch (e) { return fail(`review: base branch .harness/config.yaml is not valid YAML: ${esc((e as Error).message.split('\n')[0]!)}`); }
    const cfg = validateConfig(cfgRaw ?? {});
    if (!cfg.ok) return fail(`review: base branch .harness/config.yaml is not valid: ${cfg.errors[0]}`);
    if (unattendedEnv(env) && cfg.config.unattended.review === 'skip') return out('review: skipped (unattended.review is skip)'), 0;
    const drift = driftCheck(root, bytes, base, commits);
    if ('error' in drift) return fail(drift.error);
    const { blobs } = drift;
    const judge = '.claude/agents/review-judge.md';
    if (blobs[judge] == null) return fail(`review: base branch ${esc(base)} has no ${judge} (an older harness install); run /harness:update on ${esc(base)} first`);
    // The plugin registers its own staff-reviewer, and which one Claude Code starts is unverified: both must be the same text.
    const agent = '.claude/agents/staff-reviewer.md', lf = (t: string | null | undefined) => t?.replace(/\r\n/g, '\n');
    if (lf(blobs[agent]) !== lf(readFileSync(join(packageDir('templates'), 'agents', 'staff-reviewer.md'), 'utf8')))
      return fail(`review: ${agent} differs from the harness plugin's copy, and Claude Code may start either; run /harness:update on ${esc(base)} and review again`);

    const mb = exec('git', [...SAFE_GIT, 'merge-base', baseSha, headSha]);
    const mergeBase = mb.stdout.trim();
    if (mb.status !== 0 || !mergeBase) return fail(`review: git merge-base failed: ${gitErr(mb)}`);
    const d = exec('git', [...SAFE_GIT, ...diffArgs(mergeBase, headSha)], { timeoutMs: 120_000 });
    if (d.status !== 0) return fail(`review: git diff failed: ${gitErr(d)}`);
    const files = parseDiff(d.stdout);
    const cap = capDiff(files, DIFF_CAP, cfg.config.pr_size.exclude);

    const dir = resolve(root, outDir), head = join(dir, 'head');
    const changed = new Set(files.map((x) => x.path));
    const tree = lsTree(bytes, root, headSha);
    let only: Set<string> | undefined;
    const partial = tree.length > LIMITS.files || tree.reduce((s, e) => s + (e.size <= LIMITS.fileBytes ? e.size : 0), 0) > LIMITS.unpacked;
    if (partial) {
      const dirs = new Set([...changed].map((p) => p.slice(0, p.lastIndexOf('/') + 1)));
      only = new Set(tree.filter((e) => changed.has(e.path) || dirs.has(e.path.slice(0, e.path.lastIndexOf('/') + 1))).map((e) => e.path));
      if (only.size > LIMITS.files) return fail(`review: the changed files and their siblings are over ${LIMITS.files} files; review stops`);
    }
    const snap = writeSnapshot(bytes, root, headSha, head, { ignore: harnessIgnoreText(blobs['.harnessignore'] ?? ''), ...(only && { only }) });
    const omitted = [...cap.omitted, ...snap.omitted.filter((o) => changed.has(o.path)),
      ...(partial ? [{ path: 'head/', why: `holds only the changed files and their siblings (the tree is over ${LIMITS.files} files or 100 MB)` }] : [])];

    const comments = reviewComments(exec, repo, n);
    if (!Array.isArray(comments)) return fail(comments.error);
    const issues: { n: number; title: string; body: string }[] = [];
    for (const { number: k, repo: r } of view.closingIssues) {
      if (r.toLowerCase() !== repo.toLowerCase()) {
        omitted.push(r ? { path: `issue ${r}#${k}`, why: 'linked issue in another repo, not read' } : { path: `issue #${k}`, why: 'linked issue in an unknown repo, not read' });
        continue;
      }
      const i = issueView(exec, repo, k);
      if ('error' in i) return fail(i.error);
      issues.push({ n: k, ...i });
    }
    const sp = specs(view.body, head, snap.map);
    const diff = diffText(cap.sent);
    const nonce = (deps.nonce ?? newNonce)();
    const prTexts = [view.title, view.body, view.headRepository, ...view.labels, ...view.comments, ...view.reviews, ...comments, ...issues.flatMap((i) => [i.title, i.body]), diff, ...sp.map((s) => s.text), ...omitted.map((o) => o.path)];
    if (nonceIn(prTexts, nonce)) return fail('review: PR text contains this run\'s data nonce; run the review again');

    writeAtomic(join(dir, 'context.md'), contextMd({
      nonce, repo, pr: n, base, baseSha, headSha, maxFindings: cfg.config.review.max_findings, rubric: blobs['.claude/skills/review-rubric/SKILL.md'] ?? null, agents: blobs['AGENTS.md'] ?? null,
      product: blobs['.harness/context/product.md'] ?? null, view, reviewComments: comments, issues, diffText: diff, specs: sp, omitted, map: snap.map,
    }));
    const skipped = new Set(cap.omitted.map((o) => o.path));
    const g: GatherJson = {
      repo, pr: n, base, base_sha: baseSha, head_sha: headSha, merge_base: mergeBase, nonce, fork: view.isCrossRepository ? view.headRepository || DELETED_FORK : null, labels: view.labels,
      body_template: view.body.includes(MARKER), body_problems: bodyProblems(view.body, view.labels), // never PR text: bodyProblems names sections only
      max_findings: cfg.config.review.max_findings,
      files: files.map((x) => ({ path: x.path, ...(x.old_path !== undefined && { old_path: x.old_path }), status: x.status, binary: x.binary, ...(skipped.has(x.path) && { skipped: true as const }) })),
      lines: commentable(cap.sent), map: snap.map, omitted,
    };
    writeGather(root, dir, g);

    const lines = cap.sent.reduce((s, x) => s + x.lines, 0), sha7 = headSha.slice(0, 7);
    appendEvent(root, { ts: new Date().toISOString(), session: 'cli', check: 'review', decision: 'review-gathered', reason: `pr ${n} ${sha7} files ${cap.sent.length} lines ${lines} omitted ${omitted.length}` });
    out(`Gathered PR #${n} at ${sha7}: ${cap.sent.length} files, ${lines} diff lines, ${omitted.length} omitted.`);
    return 0;
  } catch (e) {
    return fail((e as Error).message.startsWith('review: ') ? (e as Error).message : `review: ${esc((e as Error).message)}`);
  }
}

/** Writes `<dir>/gather.json` and records its hash in protected state (Review Focus 1). */
export function writeGather(root: string, dir: string, g: GatherJson): void {
  const json = JSON.stringify(g, null, 2) + '\n', abs = resolve(root, dir);
  writeAtomic(join(abs, 'gather.json'), json);
  const state = readState(root);
  state[abs] = sha256(json);
  mkdirSync(join(root, '.harness', 'state'), { recursive: true });
  writeAtomic(join(root, ...STATE.split('/')), JSON.stringify(state, null, 2) + '\n');
}

function readState(root: string): Record<string, string> {
  const p = join(root, ...STATE.split('/'));
  if (!existsSync(p)) return {};
  const v = JSON.parse(readFileSync(p, 'utf8')) as unknown; // a corrupt state file throws: fail fast, never reset silently
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`review: ${STATE} is not a mapping`);
  return v as Record<string, string>;
}

/** Review Focus 1: `<dir>/gather.json` must be the bytes gather wrote; the agent can write `<dir>`. */
export function gatherHash(root: string, dir: string): 'ok' | string {
  const p = join(resolve(root, dir), 'gather.json');
  const want = readState(root)[resolve(root, dir)];
  return want !== undefined && existsSync(p) && sha256(readFileSync(p)) === want ? 'ok' : `review: ${dir}/gather.json changed since gather; run the review again`;
}
