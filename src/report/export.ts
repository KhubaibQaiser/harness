import type { ReportData } from './html.js';
import { COUNT_FIELDS } from './windows.js';

// Counts-only export (spec §6.4, owner Q9). Allowlist: every string is a known id, a version, a model id, an ISO week, a date or a schema enum; all else is `other`.
export interface Known { ids: Set<string> }

const OTHER = 'other';
const MODEL_RE = /^claude-[a-z0-9.-]+$/;
const VERSION_RE = /^\d+\.\d+\.\d+([-+][\w.-]*)?$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = ['timing', 'transcript', 'events'];
const EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification'];
const ENUMS = new Set([OTHER, ...SOURCES, ...EVENTS]);
const MS_DAY = 86_400_000, DAYS_WEEK = 7, THURSDAY = 4, PAD = 2;

type Counts = Record<string, number>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numbers = (o: object): Counts => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
const id = (s: string, k: Known): string => (k.ids.has(s) ? s : OTHER);
const pick = (s: string, ok: readonly string[]): string => (ok.includes(s) ? s : OTHER);

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

const USAGE = ['input', 'output', 'cacheWrite', 'cacheRead'];
const SKILL_FIELDS = ['listedIn', 'sessionsWithListing', 'relevantIn', 'invokedRelevant', 'invokedOther', 'typedOrCarried'];

function rules(d: ReportData, k: Known): unknown[] {
  return Object.entries(d.windows.byRule).map(([name, r]) => {
    const rec = r as unknown as Record<string, unknown>;
    const c = Object.fromEntries(COUNT_FIELDS.rule.map((f) => [f, rec[f]]));
    return { id: id(name, k), ...c, counters: numbers(r.counters) };
  });
}

function gates(d: ReportData, k: Known): Record<string, unknown> {
  const g = d.gates;
  return {
    tally: fold(Object.entries(g.tally).map(([n, v]) => ({ n, v })), (r) => id(r.n, k), ['v']),
    false_blocks: g.falseBlocks.length, hallucination: numbers(g.hallucination), notes: numbers(g.notes),
  };
}

export function buildExport(d: ReportData, known: Known): Record<string, unknown> {
  const m = d.meta, u = d.usage;
  const weekly = fold(Object.entries(u.byDay).map(([day, v]) => ({ day, ...v })), (r) => isoWeek(r.day), USAGE).map((r) => ({ week: r.id, ...numbers(r) }));
  return {
    schema: 1,
    harness: VERSION_RE.test(m.harness) ? m.harness : OTHER,
    window_days: num(m.days),
    generated_on: DATE_RE.test(m.generated.slice(0, 10)) ? m.generated.slice(0, 10) : OTHER,
    claude_versions: m.claudeVersions.map((v) => (VERSION_RE.test(v) ? v : OTHER)),
    models: fold(Object.entries(u.byModel).map(([n, v]) => ({ n, ...v })), (r) => (MODEL_RE.test(r.n) ? r.n : OTHER), USAGE),
    sessions: { scanned: m.sessions.scanned, skipped: Object.values(m.sessions.skipped).reduce((a, b) => a + num(b), 0), unknown: m.sessions.unknown },
    skills: fold(d.skills, (s) => id(s.name, known), SKILL_FIELDS),
    rules: rules(d, known),
    tokens: { total: numbers({ ...u.total }), main: numbers({ ...u.main }), sub: numbers({ ...u.sub }), always: fold(d.always, (a) => id(a.id, known), ['tokens']) },
    gates: gates(d, known),
    latency: d.gates.latency.map((l) => ({ source: pick(l.source, SOURCES), event: pick(l.event, EVENTS), ...numbers({ n: l.n, p50: l.p50, p95: l.p95, max: l.max, timeouts: l.timeouts }) })),
    weekly,
    unknown: num(d.windows.unknown), notes: numbers(d.windows.notes),
  };
}

const allowed = (s: string, k: Known): boolean => k.ids.has(s) || ENUMS.has(s) || VERSION_RE.test(s) || MODEL_RE.test(s) || WEEK_RE.test(s) || DATE_RE.test(s);

/** Every string that is not allowlisted, as its JSON path (never the value). */
export function exportProblems(x: unknown, known: Known, path = '$'): string[] {
  if (typeof x === 'string') return allowed(x, known) ? [] : [`${path}: string not on the allowlist`];
  if (Array.isArray(x)) return x.flatMap((v, i) => exportProblems(v, known, `${path}[${i}]`));
  if (x !== null && typeof x === 'object') return Object.entries(x).flatMap(([key, v]) => exportProblems(v, known, `${path}.${key}`));
  return [];
}
