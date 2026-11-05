import { h } from './h.js';
import { PER_TURNS, section, table } from './html-parts.js';
import type { UsageResult } from './metrics/usage.js';
import type { Window, WindowRule, WindowsResult } from './windows.js';

const MAX_WINDOWS = 50, DECIMALS = 2; // spec §4.2 and §6.3
const LABELS: Record<WindowRule, string> = {
  'ask-first': 'Ask before deciding', 'no-invented-data': 'No invented data', 'fix-everything': 'Fix everything found', 'readme-per-pr': 'README checked in each PR',
  'paid-ok': 'No paid actions without an OK', 'plain-communication': 'Plain communication (style proxy)', tdd: 'TDD (when the TDD gate is off)',
};

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

export function rulesSection(w: WindowsResult, loads: UsageResult['loads'], rules: unknown): string {
  const matrix = rules === undefined ? '' : `<div id="rules-matrix"><h3>Coverage matrix</h3><pre>${h(JSON.stringify(rules, null, 1))}</pre></div>`;
  const load = table(['Sessions', 'AGENTS.md loaded', 'CLAUDE.md loaded', 'Unknown', 'Compactions', 'Reloaded after compaction'], [[loads.sessions, loads.agentsMd, loads.claudeMd, loads.unknown, loads.compactions, loads.reloaded]]);
  const note = `<p>These windows are "needs a look". They are not scored, and a turn with no window is not "followed". ${w.unknown} turns could not be read.</p>`;
  return section('rules', 'Rules', `${matrix}<h3>Rules loaded</h3>${load}${note}${(Object.keys(LABELS) as WindowRule[]).map((k) => ruleBlock(k, w.byRule[k])).join('')}`);
}
