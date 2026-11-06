import { h } from './h.js';
import { PER_TURNS, section, table } from './html-parts.js';
import type { UsageResult } from './metrics/usage.js';
import { enforcedLine, type RuleRow } from './rules.js';
import type { Window, WindowRule, WindowsResult } from './windows.js';

const MAX_WINDOWS = 50, DECIMALS = 2; // spec §4.2 and §6.3
const LABELS: Record<WindowRule, string> = {
  'ask-first': 'Ask before deciding', 'no-invented-data': 'No invented data', 'fix-everything': 'Fix everything found',
  'readme-per-pr': 'README checked in each PR',
  'paid-ok': 'No paid actions without an OK', 'plain-communication': 'Plain communication (style proxy)',
  tdd: 'TDD (when the TDD gate is off)',
};

const NAMES: Record<string, string> = { ...LABELS, 'small-prs': 'Small PRs', 'lean-context': 'Lean context', 'no-ai-trailer': 'No AI trailer', 'branch-prefix': 'Branch prefixes' };
const MATRIX_HEAD = ['Rule', 'Kind', 'Enforced', 'Fires', 'Denies', 'Asks', 'Blocks', 'Probable false blocks', 'Windows', 'Known bypasses'];

function matrix(rows: RuleRow[]): string {
  const cells = rows.map((r) => [NAMES[r.def.id] ?? r.def.id, r.def.kind, r.enforced, r.fires, r.denies, r.asks, r.blocks, r.probableFalse, r.windows, r.def.bypasses.join('; ') || '-']);
  return `<div id="rules-matrix"><h3>Coverage matrix</h3><p>${h(enforcedLine(rows))}</p>${table(MATRIX_HEAD, cells)}`
    + '<p class="mute">Computed from config and the event log. "no" means no check is on; it never means followed.</p></div>';
}

const windowBlock = (w: Window): string =>
  `<details><summary>${h(w.date)}, session ${h(w.session)}, turn ${w.turn}${w.control ? ' (contains control characters)' : ''}</summary>`
  + `<p class="mute">Prompt</p><pre>${h(w.prompt)}</pre><p class="mute">Assistant text</p><pre>${h(w.texts)}</pre>`
  + `<p class="mute">Tool calls</p><pre>${h(w.tools.join('\n'))}</pre></details>`;

function ruleBlock(rule: WindowRule, r: WindowsResult['byRule'][WindowRule]): string {
  const shown = r.windows.slice(0, MAX_WINDOWS);
  const rest = r.total - shown.length;
  const decay = (Object.keys(r.byBucket) as (keyof typeof r.byBucket)[]).map((b) => {
    const s = r.byBucket[b];
    return [b, s.turns, s.windows, s.turns === 0 ? 'n/a' : ((s.windows / s.turns) * PER_TURNS).toFixed(DECIMALS)];
  });
  return `<h3>${h(LABELS[rule])}</h3><p>${r.total} windows in total. Counters: ${h(JSON.stringify(r.counters))}.</p>`
    + shown.map(windowBlock).join('') + (rest > 0 ? `<p class="mute">${rest} more not shown.</p>` : '')
    + table(['Turns bucket', 'Turns', 'Windows', 'Windows per 10 turns'], decay);
}

export function rulesSection(w: WindowsResult, loads: UsageResult['loads'], rules?: RuleRow[]): string {
  const loadHead = ['Sessions', 'AGENTS.md loaded', 'CLAUDE.md loaded', 'Unknown', 'Compactions', 'Reloaded after compaction'];
  const load = table(loadHead, [[loads.sessions, loads.agentsMd, loads.claudeMd, loads.unknown, loads.compactions, loads.reloaded]]);
  const note = '<p>These windows are "needs a look". They are not scored, and a turn with no window is not "followed". '
    + `${w.unknown} turns could not be read.</p>`;
  const blocks = (Object.keys(LABELS) as WindowRule[]).map((k) => ruleBlock(k, w.byRule[k])).join('');
  return section('rules', 'Rules', `${rules === undefined ? '' : matrix(rules)}<h3>Rules loaded</h3>${load}${note}${blocks}`);
}
