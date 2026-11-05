import { RX } from './windows.js';
import { h } from './h.js';
import { CSS, MIN_N, NO_RELEVANT, USAGE_HEAD, chart, n, rate, section, sum, table, usageCells } from './html-parts.js';
import { rulesSection } from './html-rules.js';
import { gatesSection, tokensSection } from './html-tokens-gates.js';
import { SKILL_NOTES, type SkillRow } from './metrics/skills.js';
import type { GatesResult } from './metrics/gates.js';
import type { UsageResult } from './metrics/usage.js';
import { hbars } from './svg.js';
import type { WindowsResult } from './windows.js';

export { h };
export interface ReportMeta {
  generated: string; days: number; harness: string; claudeVersions: string[]; untested: string[];
  sessions: { scanned: number; skipped: Record<string, number>; unknown: number };
}
export interface ReportData {
  meta: ReportMeta; usage: UsageResult; always: { id: string; tokens: number | null }[]; skills: SkillRow[];
  windows: WindowsResult; gates: GatesResult; rules?: unknown /* Task 19 */; evals?: unknown /* Task 16 */;
}
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
export const NO_SESSIONS = 'No sessions found for this repo. Start Claude Code inside the repo for the report to see it.';
const BANNER = "Local report. Quoted turns come from your session transcripts. Don't share this file; "
  + 'use <code>--export</code> to share counts.';

function header(m: ReportMeta): string {
  const skipped = Object.entries(m.sessions.skipped);
  const total = skipped.reduce((a, [, c]) => a + c, 0);
  const why = skipped.map(([k, c]) => `${h(k)}: ${c}`).join(', ');
  return section('header', 'Harness usage report', [
    `<p class="banner">${BANNER}</p>`,
    m.untested.length > 0
      ? `<p class="banner">Untested Claude Code versions seen: ${m.untested.map(h).join(', ')}. Numbers may be wrong.</p>` : '',
    m.sessions.scanned === 0 ? `<p>${h(NO_SESSIONS)}</p>` : '',
    `<p>Last ${m.days} days. Generated ${h(m.generated)}. Harness ${h(m.harness)}. `
      + `Claude Code versions seen: ${m.claudeVersions.map(h).join(', ') || 'none'}.</p>`,
    `<p>Sessions: ${m.sessions.scanned} scanned, ${total} skipped${why ? ` (${why})` : ''}, ${m.sessions.unknown} unknown.</p>`,
  ].join(''));
}

const tile = (k: string, v: string): string => `<div class="tile"><span class="mute">${h(k)}</span><b>${h(v)}</b></div>`;
function summary(d: ReportData): string {
  const rel = d.skills.reduce((a, s) => a + s.relevantIn, 0), hit = d.skills.reduce((a, s) => a + s.invokedRelevant, 0);
  const l = d.usage.loads, t = d.usage.total;
  const p95 = Math.max(0, ...d.gates.latency.map((x) => x.p95));
  return section('summary', 'Summary', `<div class="tiles">${[
    tile('Skills invoked when relevant', rate(hit, rel, NO_RELEVANT)),
    tile('Rules enforced', d.rules === undefined ? 'not computed' : 'see Rules'),
    tile('Rules loaded', `AGENTS.md in ${l.agentsMd} of ${l.sessions}, CLAUDE.md in ${l.claudeMd} of ${l.sessions} sessions`),
    tile('Tokens', USAGE_HEAD.map((c, i) => `${c.toLowerCase()} ${usageCells(t)[i]}`).join(', ')),
    tile('Probable false blocks', n(d.gates.falseBlocks.length)),
    tile('Harness hook p95', d.gates.latency.length === 0 ? 'n/a' : `${p95} ms`),
  ].join('')}</div>`);
}

function skillNote(s: SkillRow): string {
  const flags = [s.dropped ? 'dropped from listing' : '', s.undercounted ? 'undercounted' : '', s.stackUnknown ? 'stackUnknown' : ''];
  return [...flags, `relevance: ${s.label}`].filter(Boolean).join(', ');
}
function skillsSection(skills: SkillRow[]): string {
  const rows = [...skills].sort((a, b) => Number(b.dropped) - Number(a.dropped));
  const cells = rows.map((s) => [
    s.name, `${s.listedIn} of ${s.sessionsWithListing}`, rate(s.invokedRelevant, s.relevantIn, NO_RELEVANT),
    s.invokedOther, s.typedOrCarried, s.unknown, skillNote(s),
  ]);
  const bars = rows.filter((s) => s.relevantIn > 0)
    .map((s) => ({ label: s.name, value: s.invokedRelevant, max: s.relevantIn, note: `r=${s.relevantIn}` }));
  return section('skills', 'Skills', [
    table(['Skill', 'Listed in', 'Invoked when relevant', 'Invoked otherwise', 'Typed or carried', 'Unknown', 'Notes'], cells),
    `<p class="mute">${h(Object.values(SKILL_NOTES).join(' '))}</p>`,
    chart(hbars(bars), ['Skill', 'Invoked when relevant', 'Relevant sessions (r)'], bars.map((b) => [b.label, b.value, b.max])),
  ].join(''));
}

function dataNotes(d: ReportData): string {
  const item = ([k, v]: [string, unknown]) => `<li>${h(k)}: ${h(String(v))}</li>`;
  const list = (title: string, o: object) => `<h4>${h(title)}</h4><ul>${Object.entries(o).map(item).join('')}</ul>`;
  return `<h3>Data notes</h3>${list('Transcripts', d.windows.notes)}${list('Harness events and timing', d.gates.notes)}`;
}
function method(d: ReportData): string {
  const heur = Object.entries(RX).map(([k, r]) => `<li><code>${h(k)}</code>: <code>${h(r.source)}</code> (case-insensitive)</li>`).join('');
  return section('method', 'Method', [
    '<p>Sources: Claude Code session transcripts for this repo, the harness event log, and the hook timing log. '
      + 'The transcript format is undocumented, so every field is read defensively.</p>',
    '<p>"Relevant" is a proxy: a skill is relevant in a session that edited a file the skill\'s paths match. '
      + `Rates over fewer than ${MIN_N} sessions show counts only.</p>`,
    '<p>Unknown is not passed: a record that cannot be read counts as unknown, never as followed.</p>',
    `<p>Claude Code versions seen: ${d.meta.claudeVersions.map(h).join(', ') || 'none'}.</p>`,
    '<p>Estimates are labelled "estimate, characters / 4". Heuristics for "needs a look" windows:</p>', `<ul>${heur}</ul>`, dataNotes(d),
  ].join(''));
}

export function renderReport(d: ReportData): string {
  const body = [
    header(d.meta), summary(d), skillsSection(d.skills), rulesSection(d.windows, d.usage.loads, d.rules),
    tokensSection(d.usage, d.always), gatesSection(d.gates),
    d.evals === undefined ? '' : section('evals', 'Evals', `<pre>${h(JSON.stringify(d.evals, null, 1))}</pre>`), method(d),
  ].join('');
  const head = '<meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Harness usage report</title>'
    + `<style>${CSS}</style>`;
  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}
