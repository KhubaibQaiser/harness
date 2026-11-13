// The task contract (spec §4.1): the criteria a person approved, locked by its hash in protected state.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checks, q } from '../ai/vet-review.js';
import { writeAtomic } from '../core/atomic.js';
import { CONTROL, esc, isObj, MODEL_RULE, MODEL_RX, relPathProblem } from '../core/config.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { SAFE_GIT } from '../core/git-safe.js';
import { plainArgv } from './commands.js';

export type CriterionCheck = { test: string } | { run: string; expect_exit: number } | { person: string };
export interface Criterion { id: string; text: string; check: CriterionCheck }
export interface Contract {
  id: string; title: string; base: string; approved_by: 'person' | null; approved_at: string | null;
  closed_at: string | null; criteria: Criterion[]; checks: string[]; review: { model: string }; sha256: string | null;
}

export const TASKS_DIR = '.harness/tasks';
export const TASK_HASHES = '.harness/state/task-hashes.json';
export const ACTIVE_TASK = '.harness/state/active-task';
export const TASK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CRITERION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const KEYS = ['id', 'title', 'base', 'approved_by', 'approved_at', 'closed_at', 'criteria', 'checks', 'review', 'sha256'];
const MAX_TEST = 1000;

const file = (id: string) => `${TASKS_DIR}/${id}.json`;
const abs = (root: string, rel: string) => join(root, ...rel.split('/'));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const isIso = (v: unknown) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
const notTaskId = (id: string) => `task: ${q(id)} is not a task id (lowercase letters, digits and hyphens, at most 64)`;

function checkError(c: Record<string, unknown>): { at: string; msg: string } | null {
  const kinds = ['test', 'run', 'person'].filter((k) => Object.hasOwn(c, k));
  if (kinds.length !== 1) return { at: '', msg: 'must have exactly one of test, run or person' };
  const extra = Object.keys(c).find((k) => k !== kinds[0] && !(kinds[0] === 'run' && k === 'expect_exit'));
  if (extra !== undefined) return { at: `.${esc(extra)}`, msg: 'unknown key' };
  if (kinds[0] === 'test') {
    const t = c.test, i = typeof t === 'string' ? t.indexOf('::') : -1;
    const ok = typeof t === 'string' && i > 0 && t.length > i + 2 && t.length <= MAX_TEST && !CONTROL.test(t) && relPathProblem(t.slice(0, i)) === null;
    return ok ? null : { at: '.test', msg: 'must be <file>::<test name>, the file repo-relative' };
  }
  if (kinds[0] === 'run') {
    if (typeof c.run !== 'string' || plainArgv(c.run) === null) return { at: '.run', msg: 'must be one plain command: no pipes, redirects, ;, &, $, backticks, globs, ~, # or VAR=value prefix' };
    const x = c.expect_exit;
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 255 ? null : { at: '.expect_exit', msg: 'must be an integer from 0 to 255' };
  }
  return null; // person: its text is checked by the caller
}

/** The contract as data. `approved` is false for a draft (approved_by, approved_at and closed_at null). Errors are `<path>: <rule>`. */
export function validateContract(raw: unknown, o: { approved: boolean }): { ok: true; contract: Contract } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['contract: must be a mapping'] };
  const errors: string[] = [];
  const { str, list, keys } = checks(errors);
  keys('', raw, KEYS);
  if (typeof raw.id !== 'string' || !TASK_ID.test(raw.id)) errors.push(`id: must match ${TASK_ID.source}`);
  str('title', raw.title, 200);
  if (typeof raw.base !== 'string' || !SHA.test(raw.base)) errors.push('base: must be a commit sha (40 or 64 lowercase hex)');
  if (o.approved) {
    if (raw.approved_by !== 'person') errors.push('approved_by: must be "person"');
    if (!isIso(raw.approved_at)) errors.push('approved_at: must be an ISO date-time such as 2026-11-14T00:00:00Z');
    if (raw.closed_at !== null && !isIso(raw.closed_at)) errors.push('closed_at: must be null or an ISO date-time');
  } else {
    for (const k of ['approved_by', 'approved_at', 'closed_at']) if (raw[k] !== null) errors.push(`${k}: must be null in a draft`);
  }
  const criteria = list('criteria', raw.criteria);
  if (Array.isArray(raw.criteria) && raw.criteria.length === 0) errors.push('criteria: at least one criterion is required');
  const ids = new Set<string>();
  criteria.forEach((cr, i) => {
    const at = `criteria[${i}]`;
    if (!isObj(cr)) return void errors.push(`${at}: must be a mapping`);
    keys(`${at}.`, cr, ['id', 'text', 'check']);
    if (typeof cr.id !== 'string' || !CRITERION_ID.test(cr.id)) errors.push(`${at}.id: must match ${CRITERION_ID.source}`);
    else if (ids.has(cr.id)) errors.push(`${at}.id: duplicate criterion id ${q(cr.id)}`);
    else ids.add(cr.id);
    str(`${at}.text`, cr.text, 500);
    if (!isObj(cr.check)) return void errors.push(`${at}.check: must be a mapping`);
    const bad = checkError(cr.check);
    if (bad) errors.push(`${at}.check${bad.at}: ${bad.msg}`);
    else if (Object.hasOwn(cr.check, 'person')) str(`${at}.check.person`, cr.check.person, 500);
  });
  const names = new Set<string>();
  list('checks', raw.checks).forEach((n, i) => {
    str(`checks[${i}]`, n, 100);
    if (typeof n === 'string' && names.has(n)) errors.push(`checks[${i}]: duplicate ${q(n)}`);
    if (typeof n === 'string') names.add(n);
  });
  if (!isObj(raw.review)) errors.push('review: must be a mapping');
  else {
    keys('review.', raw.review, ['model']);
    if (typeof raw.review.model !== 'string' || !MODEL_RX.test(raw.review.model)) errors.push(`review.model: ${MODEL_RULE}`);
  }
  if (raw.sha256 !== null && (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256))) errors.push('sha256: must be null or a sha256 hex string');
  return errors.length ? { ok: false, errors } : { ok: true, contract: raw as unknown as Contract };
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

/** sha256 hex of the contract without `sha256`, keys sorted at every level. */
export function contractHash(c: Contract): string {
  const { sha256: _, ...rest } = c;
  return sha256(JSON.stringify(sortKeys(rest)));
}

export function readTaskHashes(root: string): Record<string, string> {
  const p = abs(root, TASK_HASHES);
  if (!existsSync(p)) return {};
  const v = JSON.parse(readFileSync(p, 'utf8')) as unknown; // corrupt state throws: never reset it silently
  if (!isObj(v)) throw new Error(`task: ${TASK_HASHES} is not a mapping`);
  return v as Record<string, string>;
}

/** Writes the contract with its hash, and the hash into protected state. Only the person's task commands (approve, edit, close) call this. */
export function writeContract(root: string, c: Contract): Contract {
  if (!TASK_ID.test(c.id)) throw new Error(notTaskId(c.id));
  const out = { ...c, sha256: contractHash(c) };
  mkdirSync(abs(root, TASKS_DIR), { recursive: true });
  writeAtomic(abs(root, file(c.id)), JSON.stringify(out, null, 2) + '\n');
  const hashes = readTaskHashes(root);
  hashes[c.id] = out.sha256;
  mkdirSync(abs(root, '.harness/state'), { recursive: true });
  writeAtomic(abs(root, TASK_HASHES), JSON.stringify(hashes, null, 2) + '\n');
  return out;
}

/**
 * An approved contract, from the working tree (its hash must equal both the embedded `sha256` and task-hashes.json),
 * or with `ref` from that commit (embedded `sha256` only: CI has no state, and the base branch is person-merged).
 */
export function loadContract(root: string, id: string, o: { ref?: string; git?: Exec } = {}): { contract: Contract } | { error: string } {
  if (!TASK_ID.test(id)) return { error: notTaskId(id) };
  let label = file(id), text: string;
  if (o.ref !== undefined) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._/@{}^~-]*$/.test(o.ref)) return { error: `task: ${q(o.ref)} is not a git ref` };
    label = `${o.ref}:${file(id)}`;
    const r = (o.git ?? defaultExec)('git', [...SAFE_GIT, 'cat-file', 'blob', label], { cwd: root });
    if (r.status !== 0) return { error: `${label}: not found (${esc((r.stderr ?? '').trim().split('\n')[0] ?? '')})` };
    text = r.stdout;
  } else {
    if (!existsSync(abs(root, label))) return { error: `${label}: no such task contract` };
    text = readFileSync(abs(root, label), 'utf8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: `${label}: not valid JSON (${(e as Error).message.split('\n')[0]})` };
  }
  const v = validateContract(raw, { approved: true });
  if (!v.ok) return { error: `${label}: ${v.errors.join('; ')}` };
  if (v.contract.id !== id) return { error: `${label}: id ${q(v.contract.id)} does not match the file name` };
  const hash = contractHash(v.contract);
  let recorded: string | undefined = hash;
  if (o.ref === undefined) {
    try {
      recorded = readTaskHashes(root)[id];
    } catch (e) {
      return { error: `${label}: ${(e as Error).message}` };
    }
  }
  if (v.contract.sha256 !== hash || recorded !== hash) return { error: `${label} changed since it was approved; a person must approve it again` };
  return { contract: v.contract };
}

/** HARNESS_TASK from the launch environment when it is a task id, else `.harness/state/active-task`, else null. */
export function activeTaskId(root: string, env: NodeJS.ProcessEnv): string | null {
  if (env.HARNESS_TASK !== undefined && TASK_ID.test(env.HARNESS_TASK)) return env.HARNESS_TASK;
  const p = abs(root, ACTIVE_TASK);
  if (!existsSync(p)) return null;
  const id = readFileSync(p, 'utf8').trim();
  return TASK_ID.test(id) ? id : null;
}

export function setActiveTask(root: string, id: string | null): void {
  const p = abs(root, ACTIVE_TASK);
  if (id === null) return rmSync(p, { force: true });
  if (!TASK_ID.test(id)) throw new Error(notTaskId(id));
  mkdirSync(abs(root, '.harness/state'), { recursive: true });
  writeAtomic(p, id + '\n');
}

/** features.json criteria of features not yet passing, as `test` criteria C1..Cn (spec §4.1: the contract extends the spec gate). */
export function featuresCriteria(root: string): Criterion[] {
  const p = join(root, 'features.json');
  if (!existsSync(p)) return [];
  let features: unknown;
  try {
    features = (JSON.parse(readFileSync(p, 'utf8')) as { features?: unknown })?.features;
  } catch (e) {
    throw new Error(`task: features.json is not valid JSON (${(e as Error).message.split('\n')[0]})`);
  }
  if (!Array.isArray(features)) return [];
  const out: Criterion[] = [];
  for (const f of features) {
    if (!isObj(f) || f.passes === true || !Array.isArray(f.criteria)) continue;
    for (const cr of f.criteria) {
      const c = isObj(cr) ? cr : {};
      out.push({ id: `C${out.length + 1}`, text: typeof c.text === 'string' ? c.text : '', check: { test: typeof c.test === 'string' ? c.test : '' } });
    }
  }
  return out;
}
