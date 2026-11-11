import type { GatesResult } from './metrics/gates.js';
import type { UsageResult } from './metrics/usage.js';
import { CHARS_PER_TOKEN, ESTIMATE, TOP, USAGE_HEAD, chart, rate, section, table, usageCells } from './html-parts.js';
import { hbars, stackedBars } from './svg.js';

export function tokensSection(u: UsageResult, always: { id: string; tokens: number | null }[]): string {
  const days = Object.entries(u.byDay).sort(([a], [b]) => a.localeCompare(b));
  const cols = days.map(([d, x]) => ({ label: d, parts: usageCells(x) }));
  const row = (k: string, x: UsageResult['total']) => [k, ...usageCells(x)];
  const top = [...u.sessions].sort((a, b) => b.peak - a.peak).slice(0, TOP);
  const tools = Object.entries(u.toolChars).sort(([, a], [, b]) => b - a);
  return section('tokens', 'Tokens', [
    '<p>Measured per API response. The four parts are shown separately.</p>',
    chart(stackedBars(cols, USAGE_HEAD, 'Tokens by day'), ['Day', ...USAGE_HEAD], days.map(([d, x]) => row(d, x))),
    '<h3>By model</h3>', table(['Model', ...USAGE_HEAD], Object.entries(u.byModel).map(([k, x]) => row(k, x))),
    '<h3>Main thread vs subagents</h3>',
    table(['Where', ...USAGE_HEAD], [row('main', u.main), row('subagents', u.sub), row('total', u.total)]),
    `<h3>Top ${TOP} sessions by peak context</h3>`,
    '<p class="mute">Peak context is the context size of one response: uncached input + cache write + cache read, '
      + 'not output. It is measured on the main thread only. The four parts stay separate in the columns.</p>',
    table(['Session', ...USAGE_HEAD, 'Responses', 'Compactions', 'Peak context'],
      top.map((s) => [...row(s.id, s.usage), s.responses, s.compactions, s.peak])),
    `<h3>Always-loaded (${ESTIMATE})</h3>`, table(['Item', `Tokens (${ESTIMATE})`], always.map((a) => [a.id, a.tokens ?? 'unknown'])),
    `<h3>Tool results by tool (${ESTIMATE})</h3>`,
    table(['Tool', `Tokens (${ESTIMATE})`], tools.map(([k, c]) => [k, Math.round(c / CHARS_PER_TOKEN)])),
  ].join(''));
}

type Step = GatesResult['stopSteps'][number];
const NO_LOG = 'no timing log';
const stepRow = (s: Step) => [s.step, s.runs, s.blocks, rate(s.blocks, s.runs), s.flakes, s.p50 ?? NO_LOG, s.p95 ?? NO_LOG];
/** What a timing-log hook call's ms measures. */
export const MS_NOTE = 'from dispatcher module start to the decision, before the stdout write; Node startup is not included';
const latLabel = (l: GatesResult['latency'][number]) => `${l.event}${l.outcome ? ` ${l.outcome}` : ''}`;

export function gatesSection(g: GatesResult): string {
  const maxP95 = Math.max(1, ...g.latency.map((x) => x.p95));
  const bars = g.latency.flatMap((l) => [
    { label: `${latLabel(l)} p50`, value: l.p50, max: maxP95, note: `${l.p50} ms` },
    { label: `${latLabel(l)} p95`, value: l.p95, max: maxP95, note: `${l.p95} ms` },
  ]);
  const latRows = g.latency.map((l) => [latLabel(l), l.n, l.p50, l.p95, l.max, l.timeouts]);
  const fb = g.falseBlocks.map((f) => [
    f.signal, f.check, f.date, f.turn ?? '', f.fuzzy ? 'fuzzy' : '', f.signal === 'deny-retry' ? (f.quote ?? '') : '',
  ]);
  const ht = g.hallucination;
  return section('gates', 'Gates', [
    '<h3>Decisions by check</h3>', table(['Check and decision', 'Count'], Object.entries(g.tally)),
    '<h3>Probable false blocks</h3>',
    '<p class="mute">Signals are heuristics. The quote is shown only for a deny followed by a success on the same target.</p>',
    table(['Signal', 'Check', 'Session date', 'Turn', 'Match', 'Quote'], fb),
    '<h3>Hook latency (ms)</h3>',
    `<p class="mute">Timing-log rows run ${MS_NOTE}. Transcript rows are the duration Claude Code records.</p>`,
    chart(hbars(bars, 'Hook latency p50 and p95'), ['Event', 'n', 'p50', 'p95', 'max', 'timeouts'], latRows),
    '<h3>Stop steps</h3>', table(['Step', 'Runs', 'Blocks', 'Fail rate', 'Flakes', 'p50', 'p95'], g.stopSteps.map(stepRow)),
    '<h3>Hallucination checks</h3>',
    table(['Typecheck blocks', 'Test blocks', 'Registry checks', 'Registry denies'],
      [[ht.typecheckBlocks, ht.testBlocks, ht.registryChecks, ht.registryDenies]]),
  ].join(''));
}
