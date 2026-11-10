// Team decision files (docs/decisions/<id>.md): schema, validation, id and serialisation. Pure; no I/O.
// The files arrive through PRs, so everything here treats them as untrusted (spec §3).
import picomatch from 'picomatch';
import { parseDocument, stringify } from 'yaml';
import { lf } from '../budget/text.js';

export const DECISIONS_DIR = 'docs/decisions';
export const SCHEMA = 'harness-decision/1';

export type DecisionStatus = 'active' | 'superseded' | 'retired';

export interface TeamDecision {
  id: string;
  title: string;
  status: DecisionStatus;
  superseded_by?: string;
  paths: string[];
  verified_at: string;
  verified_on: string;
  body: string;
  rel: string;
}

/** A decision file larger than this is refused before its YAML is parsed. */
export const MAX_DECISION_BYTES = 32 * 1024;
export const MAX_TITLE_CHARS = 80;
export const MAX_PATHS = 10;
export const MAX_GLOB_CHARS = 200;
export const SLUG_CHARS = 40;
// Date, 40-character slug and a -<n> suffix stay well inside one file-name segment on every OS.
const MAX_ID_CHARS = 64;
const FALLBACK_SLUG = 'decision'; // a title with no a-z or 0-9 (punctuation, non-Latin script)

const KEYS = new Set(['schema', 'id', 'title', 'status', 'superseded_by', 'paths', 'verified_at', 'verified_on']);
const STATUSES: readonly string[] = ['active', 'superseded', 'retired'];
const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,40}(-\d+)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Control characters, and invisible format characters (bidi, zero-width, BOM) that can hide text from a PR reviewer.
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const BODY_CONTROL = /(?![\n\t])[\p{Cc}\p{Cf}\u2028\u2029]/u;
const FRONT = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
// Unrelated names at several depths, dotted and not: a glob that matches PROBE_LIMIT of them loads for nearly every file.
const PROBES = ['zq9', '.zq9/zq9', 'zq9/zq9/zq9.zq9', 'a1/b2', 'c3', 'd4/e5/f6.g7', 'h8.i9', '.j0'];
const PROBE_LIMIT = 4;

function frontOf(text: string): { yaml: string; body: string } | null {
  const t = lf(text).replace(/^\uFEFF/, '');
  const m = FRONT.exec(t);
  return m ? { yaml: m[1]!, body: t.slice(m[0].length) } : null;
}

/** The frontmatter mapping, or null when the YAML has any error or warning. Silent: a warning would print the file's text. */
function yamlOf(src: string): Record<string, unknown> | null {
  const doc = parseDocument(src, { uniqueKeys: true }); // parseDocument only collects warnings; parse() is what prints them
  if (doc.errors.length || doc.warnings.length) return null;
  try {
    const y: unknown = doc.toJS({ maxAliasCount: 100 });
    return y !== null && typeof y === 'object' && !Array.isArray(y) ? (y as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * True when the frontmatter's `schema` is `harness-decision/1`. When the YAML is broken or oversized, any mention of
 * `schema` (any case) makes it a broken decision, so it is reported rather than silently ignored.
 */
export function isDecisionText(text: string): boolean {
  const f = frontOf(text);
  if (!f) return false;
  const data = f.yaml.length <= MAX_DECISION_BYTES ? yamlOf(f.yaml) : null;
  return data ? data.schema === SCHEMA : /schema/i.test(f.yaml);
}

function coversRepo(glob: string): boolean {
  try {
    const m = picomatch(glob, { dot: true }); // the options `matches` in src/core/paths.ts uses
    return PROBES.filter((p) => m(p)).length >= PROBE_LIMIT;
  } catch {
    return true; // a glob picomatch can't compile is refused too
  }
}

// `{a,b}`: non-empty alternatives of literal text and `?` only (no `*`, classes, nesting, `.` or `..`).
function braceProblem(inner: string): string | null {
  const bad = inner.split(',').some((a) => a === '' || a === '.' || a === '..' || /[*[\]{}]/.test(a));
  return bad ? 'must use { } only with non-empty plain alternatives' : null;
}

// One `/` segment under the allowlist: literals, `*`, `?`, `[...]`, a plain `{a,b}`; `**` only as the whole segment.
function segmentProblem(seg: string): string | null {
  if (seg === '') return 'must not hold an empty segment';
  if (seg === '**') return null;
  if (seg.includes('**')) return 'must use ** only as a whole segment';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === ']' || c === '}') return 'must close every [ ] and { }';
    if (c !== '[' && c !== '{') continue;
    const end = seg.indexOf(c === '[' ? ']' : '}', i + 1);
    const inner = end < 0 ? '' : seg.slice(i + 1, end);
    if (end < 0 || inner === '' || inner.includes(c)) return 'must close every [ ] and { }';
    const p = c === '{' ? braceProblem(inner) : null;
    if (p) return p;
    i = end;
  }
  return null;
}

/** The allowlist grammar; extglobs and regex groups never get through, whatever they would match. */
function grammarProblem(glob: string): string | null {
  if (/[()|]/.test(glob)) return 'must not use extglob or regex groups: ( ) |';
  for (const seg of glob.split('/')) {
    const p = segmentProblem(seg);
    if (p) return p;
  }
  return null;
}

/** Why a `paths` glob is refused (§3.2, O1), or null. */
export function globProblem(glob: string): string | null {
  if (glob === '') return 'must not be empty';
  if ([...glob].length > MAX_GLOB_CHARS) return `must be at most ${MAX_GLOB_CHARS} characters`;
  if (CONTROL.test(glob)) return 'must not hold control or invisible format characters';
  if (glob.includes('\\')) return 'must use / and hold no backslash';
  if (glob.startsWith('/') || /^[A-Za-z]:/.test(glob)) return 'must be repo-relative, not absolute';
  if (glob.startsWith('./')) return 'must not start with ./';
  if (glob.split('/').includes('..')) return 'must not hold a .. segment';
  if (glob.startsWith('!')) return 'must not start with ! (a negation matches nearly everything)';
  const g = grammarProblem(glob);
  if (g) return g;
  // `*`, `**`, `**/*` and their spellings (`**/**`, `*/**`): repo-wide rules belong in AGENTS.md or CLAUDE.md.
  if (/^[*/]+$/.test(glob) || coversRepo(glob)) return 'must not match the whole repo (put repo-wide rules in AGENTS.md or CLAUDE.md)';
  return null;
}

/** A name from the file safe to print: control and format characters become `?`. */
const shown = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '?');

const isRealDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00Z`);
  return DATE_RE.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_ID_CHARS && ID_RE.test(v) && isRealDate(v.slice(0, 10)) && !v.includes('--') && !v.endsWith('-');

function idProblem(id: unknown, rel: string): string | null {
  if (!isId(id)) return 'id must match YYYY-MM-DD-<slug of a-z, 0-9 and ->';
  return rel === `${DECISIONS_DIR}/${id}.md` ? null : 'id must equal the file name without .md';
}

const isTitle = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && [...v].length <= MAX_TITLE_CHARS && !CONTROL.test(v);

function supersededProblem(data: Record<string, unknown>): string | null {
  const has = 'superseded_by' in data;
  if (data.status !== 'superseded') return has ? 'superseded_by must be absent unless status is superseded' : null;
  if (!has) return 'superseded_by must be set when status is superseded';
  return isId(data.superseded_by) ? null : 'superseded_by must be a decision id';
}

function pathsProblems(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_PATHS) return [`paths must be a list of 1 to ${MAX_PATHS} globs`];
  return paths.flatMap((g: unknown, i) => {
    if (typeof g !== 'string') return [`paths[${i}] must be a string`];
    const p = globProblem(g);
    return p ? [`paths[${i}] ${p}`] : [];
  });
}

const isPastDate = (v: unknown, today: string): boolean => typeof v === 'string' && isRealDate(v) && v <= today;

function fieldProblems(rel: string, data: Record<string, unknown>, today: string): string[] {
  const out = Object.keys(data).filter((k) => !KEYS.has(k)).map((k) => `${shown([...k].slice(0, MAX_ID_CHARS).join(''))} must not be here (unknown key)`);
  const checks: (string | null)[] = [
    data.schema === SCHEMA ? null : `schema must be ${SCHEMA}`,
    idProblem(data.id, rel),
    isTitle(data.title) ? null : `title must be one line of 1 to ${MAX_TITLE_CHARS} characters`,
    STATUSES.includes(data.status as string) ? null : 'status must be active, superseded or retired',
    supersededProblem(data),
  ];
  out.push(...checks.filter((c): c is string => c !== null), ...pathsProblems(data.paths));
  if (typeof data.verified_at !== 'string' || !SHA_RE.test(data.verified_at)) out.push('verified_at must be a 40-character lowercase hex commit sha');
  if (!isPastDate(data.verified_on, today)) out.push('verified_on must be an ISO date (YYYY-MM-DD), not in the future');
  return out;
}

/** Parse and validate one decision file. A file without the schema line is not a decision: `{ null, [] }`. */
export function parseDecision(rel: string, text: string, today: string): { decision: TeamDecision | null; errors: string[] } {
  if (!isDecisionText(text)) return { decision: null, errors: [] };
  const fail = (msgs: string[]) => ({ decision: null, errors: msgs.map((m) => `${shown(rel)}: ${m}`) });
  if (Buffer.byteLength(text, 'utf8') > MAX_DECISION_BYTES) return fail([`file must be at most ${MAX_DECISION_BYTES} bytes`]);
  const front = frontOf(text)!; // isDecisionText found it
  const data = yamlOf(front.yaml);
  if (!data) return fail(['frontmatter must be valid YAML']);
  const problems = fieldProblems(rel, data, today);
  if (BODY_CONTROL.test(front.body)) problems.push('body must not hold control or invisible format characters');
  if (problems.length) return fail(problems);
  const { id, title, status, superseded_by, paths, verified_at, verified_on } = data as unknown as TeamDecision;
  const decision: TeamDecision = { id, title, status, ...(superseded_by !== undefined ? { superseded_by } : {}), paths, verified_at, verified_on, body: front.body, rel };
  return { decision, errors: [] };
}

/** §3.1: `<date>-<slug>` (a dash left at the cut is trimmed too), with `-2`, `-3`… when the id is taken. */
export function slugId(title: string, date: string, taken: (id: string) => boolean): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_CHARS).replace(/-+$/, '') || FALLBACK_SLUG;
  const base = `${date}-${slug}`;
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

// No folding and no block scalars, so every value stays on its own line; YAML quotes what would otherwise mis-parse.
const scalar = (v: string): string => stringify(v, { lineWidth: 0, blockQuote: false }).trimEnd();

/** The decision file: §3.2's key order, double-quoted globs, LF line ends and a final newline. */
export function serializeDecision(d: Omit<TeamDecision, 'rel'>): string {
  const lines = [
    '---',
    `schema: ${SCHEMA}`,
    `id: ${scalar(d.id)}`,
    `title: ${scalar(d.title)}`,
    `status: ${scalar(d.status)}`,
    ...(d.superseded_by !== undefined ? [`superseded_by: ${scalar(d.superseded_by)}`] : []),
    'paths:',
    ...d.paths.map((p) => `  - ${JSON.stringify(p)}`),
    `verified_at: ${scalar(d.verified_at)}`,
    `verified_on: ${scalar(d.verified_on)}`,
    '---',
  ];
  const body = d.body.replace(/\r\n?/g, '\n');
  return `${lines.join('\n')}\n${body}${body === '' || body.endsWith('\n') ? '' : '\n'}`;
}

/** The body `add` writes: the Rule paragraph, then the Why paragraph when there is one. */
export const addBody = (rule: string, why: string): string => (why === '' ? `**Rule:** ${rule}` : `**Rule:** ${rule}\n\n**Why:** ${why}`);
