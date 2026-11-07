import type { ReportData } from './html.js';
import { COUNT_FIELDS, COUNTERS, type WindowRule, type WindowsResult } from './windows.js';

// Counts-only export (spec §6.4, owner Q9). Allowlist: every string is a known id, a version, a model id, an ISO week, a date or a schema enum; all else is `other`.
export interface Known { ids: Set<string> }

const OTHER = 'other';
// Model ids: a family word plus version digits and an optional date, so free text can't ride along.
const MODEL_RE = /^claude-(?:(?:\d{1,2}-){0,2}(?:opus|sonnet|haiku|fable)(?:-\d{1,2}){0,3}|(?:opus|sonnet|haiku|fable)(?:-\d{1,2}){1,3})(?:-\d{8})?$/;
// Semver with an optional alpha/beta/rc number only, digits bounded, so no free text fits.
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,4})?$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = ['timing', 'transcript', 'events'];
const EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification'];
const ALWAYS_CLASSES = ['harness', 'preset', 'repo', 'catalog'];
const ENUMS = new Set([OTHER, ...ALWAYS_CLASSES, ...SOURCES, ...EVENTS]);
const DATE_LEN = 10;
const MS_DAY = 86_400_000, DAYS_WEEK = 7, THURSDAY = 4, PAD = 2;

type Counts = Record<string, number>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Copy only the listed keys, as numbers; any other key (and any non-number) is dropped. */
const only = (o: unknown, keys: readonly string[]): Counts => {
  const r = (o ?? {}) as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => typeof r[k] === 'number' && Number.isFinite(r[k])).map((k) => [k, r[k] as number]));
};
const id = (s: string, k: Known): string => (k.ids.has(s) ? s : OTHER);
const pick = (s: string, ok: readonly string[]): string => (ok.includes(s) ? s : OTHER);

// Key allowlists, from the code constants in windows.ts and gates.ts. Unknown keys are dropped.
const BUCKETS = ['1-10', '11-30', '31-100', '100+'];
const SPLIT = ['turns', 'windows'];
const COUNTER_KEYS: string[] = [...new Set(Object.values(COUNTERS).flat())];
const HALLUCINATION = ['typecheckBlocks', 'testBlocks', 'registryChecks', 'registryDenies'];
const GATE_NOTES = ['badEvents', 'badTiming', 'noTime', 'falseBlocksCut', 'denyUnlinked', 'unknownTools', 'truncatedTurns', 'samplesCut', 'keysCut'];
const WINDOW_NOTES = ['sideRecords', 'sideBad', 'beforeFirstPrompt'];
const USAGE = ['input', 'output', 'cacheWrite', 'cacheRead'];
const SKILL_FIELDS = ['listedIn', 'sessionsWithListing', 'relevantIn', 'invokedRelevant', 'invokedOther', 'typedOrCarried'];
const LATENCY = ['n', 'p50', 'p95', 'max', 'timeouts'];
const OUT_KEYS = new Set([
  'schema', 'harness', 'window_days', 'generated_on', 'claude_versions', 'models', 'sessions', 'scanned', 'skipped', 'unknown', 'skills', 'rules',
  'tokens', 'total', 'main', 'sub', 'always', 'gates', 'tally', 'v', 'false_blocks', 'hallucination', 'notes', 'latency', 'source', 'event', 'weekly',
  'id', 'week', 'counters', 'byBucket', 'byCompact', 'pre', 'post', ...COUNT_FIELDS.rule, ...COUNT_FIELDS.top,
  ...BUCKETS, ...SPLIT, ...COUNTER_KEYS, ...HALLUCINATION, ...GATE_NOTES, ...WINDOW_NOTES, ...USAGE, ...SKILL_FIELDS, ...LATENCY, 'tokens',
]);

/** A safe class for an always-loaded row: never its label (a repo file path). */
function alwaysClass(owner: string | undefined, k: Known): string {
  if (owner === 'harness' || owner === 'repo') return owner;
  if (owner?.startsWith('preset:')) return 'preset';
  if (owner?.startsWith('catalog:')) return id(owner.slice('catalog:'.length), k) === OTHER ? 'catalog' : owner.slice('catalog:'.length);
  return OTHER;
}

/** Sum rows that share a folded id. */
function fold<T extends object>(rows: T[], key: (r: T) => string, fields: string[]): Record<string, unknown>[] {
  const m = new Map<string, Counts>();
  for (const r of rows) {
    const k = key(r), acc = m.get(k) ?? Object.fromEntries(fields.map((f) => [f, 0]));
    for (const f of fields) acc[f] = (acc[f] ?? 0) + num((r as Record<string, unknown>)[f]);
    m.set(k, acc);
  }
  return [...m].map(([k, v]) => ({ id: k, ...v }));
}

/** ISO 8601 week of a YYYY-MM-DD day, or `other`. */
function isoWeek(day: string): string {
  if (!DATE_RE.test(day)) return OTHER;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return OTHER;
  const d = new Date(t), dow = d.getUTCDay() || DAYS_WEEK;
  d.setUTCDate(d.getUTCDate() + THURSDAY - dow);
  const y = d.getUTCFullYear(), week = Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / MS_DAY + 1) / DAYS_WEEK);
  return `${y}-W${String(week).padStart(PAD, '0')}`;
}

type Row = Record<string, unknown>;
/** Recursive sum of two rows of the same shape (numbers add, objects recurse; `id` keeps a's). */
function addRows(a: Row, b: Row): Row {
  return Object.fromEntries(Object.entries(a).map(([k, v]) => {
    const w = b[k];
    if (typeof v === 'number') return [k, v + num(w)];
    return [k, v !== null && typeof v === 'object' ? addRows(v as Row, (w ?? {}) as Row) : v];
  }));
}

function ruleRow(name: string, r: WindowsResult['byRule'][WindowRule], k: Known): Row {
  const bucketed = (o: unknown) => Object.fromEntries(BUCKETS.map((b) => [b, only((o as Row | undefined)?.[b], SPLIT)]));
  const c = r.byCompact as Row | undefined;
  return {
    id: id(name, k), total: num(r.total), counters: only(r.counters, COUNTER_KEYS), byBucket: bucketed(r.byBucket),
    byCompact: { pre: only(c?.pre, SPLIT), post: only(c?.post, SPLIT) },
  };
}
function rules(d: ReportData, k: Known): Row[] {
  const out = new Map<string, Row>();
  for (const [name, r] of Object.entries(d.windows.byRule)) {
    const row = ruleRow(name, r, k), prev = out.get(row.id as string);
    out.set(row.id as string, prev ? addRows(prev, row) : row);
  }
  return [...out.values()];
}

function gates(d: ReportData, k: Known): Record<string, unknown> {
  const g = d.gates;
  return {
    tally: fold(Object.entries(g.tally).map(([n, v]) => ({ n, v })), (r) => id(r.n, k), ['v']),
    false_blocks: g.falseBlocks.length, hallucination: only(g.hallucination, HALLUCINATION), notes: only(g.notes, GATE_NOTES),
  };
}

export function buildExport(d: ReportData, known: Known): Record<string, unknown> {
  const m = d.meta, u = d.usage;
  const day = m.generated.slice(0, DATE_LEN);
  const weekly = fold(Object.entries(u.byDay).map(([dy, v]) => ({ day: dy, ...v })), (r) => isoWeek(r.day), USAGE).map((r) => ({ week: r.id, ...only(r, USAGE) }));
  return {
    schema: 1,
    harness: VERSION_RE.test(m.harness) ? m.harness : OTHER,
    window_days: num(m.days),
    generated_on: DATE_RE.test(day) ? day : OTHER,
    claude_versions: m.claudeVersions.map((v) => (VERSION_RE.test(v) ? v : OTHER)),
    models: fold(Object.entries(u.byModel).map(([n, v]) => ({ n, ...v })), (r) => (MODEL_RE.test(r.n) ? r.n : OTHER), USAGE),
    sessions: { scanned: num(m.sessions.scanned), skipped: Object.values(m.sessions.skipped).reduce((a, b) => a + num(b), 0), unknown: num(m.sessions.unknown) },
    skills: fold(d.skills, (s) => id(s.name, known), SKILL_FIELDS),
    rules: rules(d, known),
    tokens: { total: only(u.total, USAGE), main: only(u.main, USAGE), sub: only(u.sub, USAGE), always: fold(d.always, (a) => alwaysClass(a.owner, known), ['tokens']) },
    gates: gates(d, known),
    latency: d.gates.latency.map((l) => ({ source: pick(l.source, SOURCES), event: pick(l.event, EVENTS), ...only(l, LATENCY) })),
    weekly,
    unknown: num(d.windows.unknown), notes: only(d.windows.notes, WINDOW_NOTES),
  };
}

const allowed = (s: string, k: Known): boolean => k.ids.has(s) || ENUMS.has(s) || VERSION_RE.test(s) || MODEL_RE.test(s) || WEEK_RE.test(s) || DATE_RE.test(s);

/** Every string that is not allowlisted, as its JSON path (never the value). */
export function exportProblems(x: unknown, known: Known, path = '$'): string[] {
  if (typeof x === 'string') return allowed(x, known) ? [] : [`${path}: string not on the allowlist`];
  if (Array.isArray(x)) return x.flatMap((v, i) => exportProblems(v, known, `${path}[${i}]`));
  if (x !== null && typeof x === 'object') return Object.entries(x).flatMap(([key, v]) => [...(OUT_KEYS.has(key) ? [] : [`${path}: a key is not on the allowlist`]), ...exportProblems(v, known, `${path}.${key}`)]);
  return [];
}
