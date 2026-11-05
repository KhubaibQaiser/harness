import type { GatesResult } from './metrics/gates.js';
import type { UsageResult } from './metrics/usage.js';
import { CHARS_PER_TOKEN, ESTIMATE, TOP, USAGE_HEAD, chart, section, sum, table, usageCells } from './html-parts.js';
import { hbars, stackedBars } from './svg.js';

export function tokensSection(u: UsageResult, always: { id: string; tokens: number | null }[]): string {
  const days = Object.entries(u.byDay).sort(([a], [b]) => a.localeCompare(b));
  const row = (k: string, x: UsageResult['total']) => [k, ...usageCells(x)];
  const top = [...u.sessions].sort((a, b) => sum(b.usage) - sum(a.usage)).slice(0, TOP);
  const tools = Object.entries(u.toolChars).sort(([, a], [, b]) => b - a);
  return section('tokens', 'Tokens', [
    '<p>Measured per API response. The four parts are never added together.</p>',
    chart(stackedBars(days.map(([d, x]) => ({ label: d, parts: usageCells(x) })), USAGE_HEAD), ['Day', ...USAGE_HEAD], days.map(([d, x]) => row(d, x))),
    '<h3>By model</h3>', table(['Model', ...USAGE_HEAD], Object.entries(u.byModel).map(([k, x]) => row(k, x))),
    '<h3>Main thread vs subagents</h3>', table(['Where', ...USAGE_HEAD], [row('main', u.main), row('subagents', u.sub), row('total', u.total)]),
    `<h3>Top ${TOP} sessions</h3>`, table(['Session', ...USAGE_HEAD, 'Responses', 'Compactions', 'Peak context'], top.map((s) => [...row(s.id, s.usage), s.responses, s.compactions, s.peak])),
    `<h3>Always-loaded (${ESTIMATE})</h3>`, table(['Item', `Tokens (${ESTIMATE})`], always.map((a) => [a.id, a.tokens ?? 'unknown'])),
    `<h3>Tool results by tool (${ESTIMATE})</h3>`, table(['Tool', `Tokens (${ESTIMATE})`], tools.map(([k, c]) => [k, Math.round(c / CHARS_PER_TOKEN)])),
  ].join(''));
}

export function gatesSection(g: GatesResult): string {
  const lat = g.latency.map((l) => ({ label: `${l.event}${l.outcome ? ` ${l.outcome}` : ''}`, value: l.p95, max: Math.max(1, ...g.latency.map((x) => x.p95)), note: `p95 ${l.p95} ms, p50 ${l.p50} ms` }));
  const fb = g.falseBlocks.map((f) => [f.signal, f.check, f.date, f.turn ?? '', f.fuzzy ? 'fuzzy' : '', f.signal === 'deny-retry' ? (f.quote ?? '') : '']);
  const ht = g.hallucination;
  return section('gates', 'Gates', [
    '<h3>Decisions by check</h3>', table(['Check and decision', 'Count'], Object.entries(g.tally)),
    '<h3>Probable false blocks</h3><p class="mute">Signals are heuristics. The quote is shown only for a deny followed by a success on the same target.</p>',
    table(['Signal', 'Check', 'Session date', 'Turn', 'Match', 'Quote'], fb),
    '<h3>Hook latency (ms)</h3>', chart(hbars(lat), ['Event', 'n', 'p50', 'p95', 'max', 'timeouts'], g.latency.map((l) => [`${l.event} ${l.outcome ?? ''}`.trim(), l.n, l.p50, l.p95, l.max, l.timeouts])),
    '<h3>Stop steps</h3>', table(['Step', 'Runs', 'Blocks', 'Flakes', 'p50', 'p95'], g.stopSteps.map((s) => [s.step, s.runs, s.blocks, s.flakes, s.p50 ?? 'no timing log', s.p95 ?? 'no timing log'])),
    '<h3>Hallucination checks</h3>', table(['Typecheck blocks', 'Test blocks', 'Registry checks', 'Registry denies'], [[ht.typecheckBlocks, ht.testBlocks, ht.registryChecks, ht.registryDenies]]),
  ].join(''));
}
