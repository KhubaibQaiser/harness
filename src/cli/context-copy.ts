// The `harness context` report (spec §7.1) and its `--json` form (§5). Pure: the numbers come from the context set.
import { KEY_HINT } from '../budget/count-api.js';
import type { Owner } from '../budget/owners.js';
import type { Rec } from '../budget/recommend.js';
import type { SourceEntry } from '../budget/sources.js';
import { STATE_CARD_MAX_TOKENS, type ContextSet } from '../budget/summary.js';

export type { Rec } from '../budget/recommend.js';

export const REPORT_WIDTH = 62;
const OWNER_WIDTH = 9;
const PERCENT = 100;
/** Row notes for numbers an API count left as they were (owner decision 2). */
export const CATALOG_ESTIMATE = 'catalog estimate';
export const ESTIMATE_NOTE = 'estimate';
const ESTIMATE = 'Best estimate (characters ÷ 4)';
const ON_DEMAND = 'On demand (loads when used or when matching files are touched)';
const NOT_MEASURED = ['system prompt and tools', 'output style', 'personal context'];
const OWNER_ORDER = ['repo', 'harness', 'preset', 'catalog'];


const ownerWord = (o: Owner): string => o.split(':')[0];
const num = (n: number, approx: boolean): string => (approx ? '~' : '') + n.toLocaleString('en-US');
const right = (left: string, n: string): string => left + ' '.repeat(Math.max(1, REPORT_WIDTH - left.length - n.length)) + n;
const kept = (e: SourceEntry): boolean => e.note === CATALOG_ESTIMATE || e.note === ESTIMATE_NOTE;
const labelOf = (e: SourceEntry): string => e.label + (e.note ? ` (${e.note})` : '');

function header(s: ContextSet, hint: boolean): string {
  const exact = s.method === 'exact';
  const where = s.total > s.budget
    ? `, over by ${num(s.total - s.budget, !exact)}.`
    : ` (${s.budget ? Math.round((s.total / s.budget) * PERCENT) : 0}%).`;
  const est = [...s.always, ...s.onDemand].filter(kept).length;
  const except = est ? `, except ${est} estimate${est === 1 ? '' : 's'}` : '';
  const method = exact ? `Counted by Anthropic's token-counting API (${s.model})${except}.` : `${ESTIMATE}${hint ? KEY_HINT : ''}.`;
  return `Context budget: ${num(s.total, !exact)} of ${s.budget.toLocaleString('en-US')} tokens always loaded${where} ${method}`;
}

/** `plugin: x@market` comes from enabledPlugins; MCP servers go to the closing sentence instead. */
const unmeasuredLine = (id: string): string => `  Not measured: ${id.replace(/^plugin: (\S+@\S+)$/, 'plugin $1 (enabled in .claude/settings.json)')}`;

function closing(s: ContextSet): string {
  const mcp = s.unmeasured.filter((u) => u.startsWith('mcp: ')).map((u) => u.slice('mcp: '.length));
  const servers = mcp.length ? ` MCP servers (${mcp.join(', ')}),` : '';
  return `Not measured: Claude Code's system prompt and tools, output style,${servers} and your personal context (~/.claude files, user plugins, auto memory). Run /context all in a Claude Code session to see them.`;
}

/** `hint`: the estimate is only for want of a key (no offline choice, no failed API call), so say how to get exact counts. */
export function reportText(s: ContextSet, recs: Rec[], fallback: string | null, hint: boolean): string[] {
  const exact = s.method === 'exact';
  const tok = (e: SourceEntry) => num(e.tokens, !exact || kept(e));
  const rank = (e: SourceEntry) => OWNER_ORDER.indexOf(ownerWord(e.owner));
  const always = [...s.always].sort((a, b) => rank(a) - rank(b));
  const onDemand = s.onDemand.reduce((n, e) => n + e.tokens, 0);
  return [
    header(s, hint),
    ...(fallback ? [`Couldn't use the token-counting API (${fallback}); counts are best estimates.`] : []),
    '',
    right('Always loaded', 'tokens'),
    ...always.map((e) => right(`  ${ownerWord(e.owner).padEnd(OWNER_WIDTH)}${labelOf(e)}`, tok(e))),
    right('  Total', num(s.total, !exact)),
    ...s.unmeasured.filter((u) => !u.startsWith('mcp: ')).map(unmeasuredLine),
    '',
    `${ON_DEMAND}   ${num(onDemand, !exact)}`,
    ...s.onDemand.map((e) => right(`  ${labelOf(e)}`, tok(e))),
    `  after compaction: state card, at most ~${STATE_CARD_MAX_TOKENS}`,
    '',
    closing(s),
    ...s.notes.map((n) => `Note: ${n}`),
    ...(recs.length ? ['', 'Recommendations', ...recs.map((r) => `  ${r.n}. ${(r.apply ? 'harness' : 'yours').padEnd(OWNER_WIDTH)}${r.line}`)] : []),
  ];
}

/** A row with no text of its own (a catalog pick, the plugin row) has no file path and no character count. */
function source(e: SourceEntry): Record<string, unknown> {
  const file = e.text !== undefined;
  return { id: e.id, ...(file ? { path: e.path } : {}), owner: e.owner, load: e.load, tokens: e.tokens, ...(file && e.chars ? { chars: e.chars } : {}), ...(e.note ? { note: e.note } : {}) };
}

/** `fallback` is last so the §5 key order before it is unchanged; it is a fixed reason string, never key material. */
export function reportJson(s: ContextSet, recs: Rec[], fallback: string | null): object {
  return {
    method: s.method, model: s.method === 'exact' ? s.model : null, budget: s.budget,
    always: { total: s.total, harness: s.harness, catalog: s.catalog, repo: s.repo },
    on_demand: { total: s.onDemand.reduce((n, e) => n + e.tokens, 0) },
    sources: [...s.always, ...s.onDemand].map(source),
    unmeasured: s.unmeasured, not_measured: NOT_MEASURED,
    recommendations: recs.map(({ line: _l, ...r }) => r),
    fallback,
  };
}
