// The verdict (spec §4.4 step 5): written by harness verify, bound to one commit and tree, trusted only when verify recorded its hash.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renameWithRetry } from '../core/atomic.js';
import { HIDDEN_CLASS } from '../core/config.js';
import { defaultExec } from '../core/exec.js';
import { SAFE_GIT } from '../core/git-safe.js';
import { real, realish } from '../core/paths.js';
import type { RecordFinding } from '../review/record.js';
import { taskFileProblem } from './contract.js';

export type Outcome = 'done' | 'not-done' | 'blocked' | 'harness-files-only';
export interface Evidence { command: string; exit: number | null; ts: string; source: 'reused' | 're-run'; status: 'pass' | 'fail' | 'timeout' | 'missing' }
export interface ReviewResult { model: string; judge_model?: string; status: 'ran' | 'failed' | 'skipped'; error?: string; findings: RecordFinding[]; steering?: { source: string; text: string }[] }
export interface Verdict {
  schema: 'harness-verdict/1'; mode: 'attended' | 'ci'; part: 'all' | 'evidence' | 'review'; task: string; contract_sha256: string;
  commit: string; tree: string; clean: boolean; base: string; outcome: Outcome; reasons: string[]; tamper: string[];
  checks: { name: string; evidence: Evidence | null }[];
  criteria: { id: string; text: string; kind: 'test' | 'run' | 'person'; evidence: Evidence | null }[];
  person: string[]; review: ReviewResult | null; blocked: { reason: string; failing_criteria: string[] } | null; created: string;
}

export const VERDICTS_DIR = '.harness/verdicts';
export const VERDICT_HASHES = '.harness/state/verdict-hashes.json';
export const EXIT: Record<Outcome, 0 | 1 | 3> = { done: 0, 'harness-files-only': 0, 'not-done': 1, blocked: 3 };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const verdictPath = (commit: string, part: Verdict['part']): string => `${VERDICTS_DIR}/${commit}${part === 'all' ? '' : `.${part}`}.json`;

const FOLDERS = ['.harness', VERDICTS_DIR, '.harness/state'];
/** Which of harness's folders exists but is not a real directory at its own path, else null: a link could aim a delete or write at a user's folder. */
export function linkedFolder(root: string): string | null {
  const base = realish(root);
  return FOLDERS.find((rel) => {
    const d = join(base, rel), st = lstatSync(d, { throwIfNoEntry: false });
    return !!st && (!st.isDirectory() || real(d) !== d);
  }) ?? null;
}
export const folderError = (rel: string): Error => new Error(`${rel} is not a real folder (a symlink?); a person removes it, then runs harness verify again`);

/** A unique temp file, then a rename, refused when a harness folder is or became a link; the only file ever removed is that temp file. */
function writeChecked(root: string, rel: string, data: string): void {
  let bad = linkedFolder(root);
  if (bad) throw folderError(bad);
  const p = join(realish(root), rel), tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(tmp, data, { flag: 'wx' });
  try {
    // ponytail: Node has no openat or renameat, so a folder swapped in the microseconds between this check and the rename is not caught.
    bad = linkedFolder(root) ?? (real(dirname(tmp)) === dirname(p) ? null : rel);
    if (bad) throw folderError(bad);
    renameWithRetry(tmp, p);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Writes the verdict and returns the exact text written, so its hash comes from memory, never from a re-read a racing process could swap. */
export function writeVerdict(root: string, v: Verdict): string {
  const text = JSON.stringify(v, null, 2) + '\n';
  writeChecked(root, verdictPath(v.commit, v.part), text);
  return text;
}

/** The file's text, or null when it is missing, not a regular file or too big. */
const text = (p: string): string | null => (existsSync(p) && !taskFileProblem(p) ? readFileSync(p, 'utf8') : null);
const hashes = (root: string): Record<string, string> => {
  const t = text(join(root, VERDICT_HASHES));
  return t === null ? {} : (JSON.parse(t) as Record<string, string>); // corrupt state throws: never reset it silently
};

/** verify's own record of the verdict it wrote, in protected state (sandbox denyWrite, so only a verify outside the agent's sandbox records); null drops it. */
export function recordVerdictHash(root: string, commit: string, t: string | null): void {
  const h = hashes(root);
  if (t === null) delete h[commit];
  else h[commit] = sha256(t);
  writeChecked(root, VERDICT_HASHES, JSON.stringify(h, null, 2) + '\n');
}

/** The attended verdict for `commit`; null when it is missing, unreadable, for another commit, or its hash is not the recorded one. */
export function readVerdict(root: string, commit: string): Verdict | null {
  try {
    if (linkedFolder(root)) return null;
    const t = text(join(root, verdictPath(commit, 'all')));
    if (t === null || hashes(root)[commit] !== sha256(t)) return null;
    // A hash file git tracks came from a commit, not from verify; exit 1 is "not tracked", anything else is a git error.
    const ls = defaultExec('git', [...SAFE_GIT, 'ls-files', '--error-unmatch', '--', VERDICT_HASHES], { cwd: root, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null/harness-no-grafts' } });
    if (ls.status !== 1) return null;
    const v = JSON.parse(t) as Verdict;
    return v.schema === 'harness-verdict/1' && v.commit === commit ? v : null;
  } catch {
    return null;
  }
}

// Lines are one each by construction; escaping control and hidden characters keeps agent text from starting a line of its own.
const oneLine = (s: string) => s.replace(new RegExp(`[\\u0000-\\u001f\\u2028\\u2029${HIDDEN_CLASS}]`, 'gu'), (c) => (c < ' ' ? JSON.stringify(c).slice(1, -1) : `\\u{${c.codePointAt(0)!.toString(16)}}`));
const item = (id: string, e: Evidence | null) => (e ? `- ${id} ${e.status}: ${e.command} exit ${e.exit ?? 'none'} (${e.source})` : `- ${id} not run`);

function reviewLines(r: ReviewResult | null): string[] {
  if (!r || r.status !== 'ran') return r ? [`Review ${r.status} (${r.model})`] : [];
  const kept = r.findings.filter((f) => f.placement !== 'dropped');
  // A kept critical is already a reason; the rest are shown so the person sees them.
  return [
    `Review ran (reviewer ${r.model}, judge ${r.judge_model ?? r.model}): ${kept.length} findings, ${r.findings.length - kept.length} dropped`,
    ...kept.filter((f) => f.severity !== 'critical').map((f) => `- review ${f.severity}: ${f.file}:${f.line} ${f.title}`),
    // Task text that tried to steer the reviewer, as M2a shows it: the person judges it.
    ...(r.steering ?? []).map((s) => `- review steering (${s.source}): ${s.text}`),
  ];
}

export function verdictLines(v: Verdict): string[] {
  return [
    `Verdict: ${v.outcome} at ${v.commit} (tree ${v.tree}), task ${v.task}, harness verify${v.clean ? '' : ' (working tree not clean)'}`,
    ...(v.blocked ? [`Blocked: ${v.blocked.reason}`] : []),
    ...v.checks.map((c) => item(c.name, c.evidence)),
    ...v.criteria.filter((c) => c.kind !== 'person').map((c) => item(c.id, c.evidence)),
    ...v.person.map((p) => `- person: ${p}`),
    ...reviewLines(v.review),
    ...v.tamper.map((t) => `tamper: ${t}`),
    ...v.reasons,
  ].map(oneLine);
}
