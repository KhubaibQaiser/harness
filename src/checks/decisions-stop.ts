// Stop nudge to save a team decision (team-decisions spec §8.1, D5, D8): plain-text regex signals, no model call, a note
// and never a block. English phrases only; the patterns are tuned here.
import { appendEvent } from '../core/events.js';
import { redactSecrets } from '../core/secrets.js';
import type { Check, Ctx } from '../hooks/check.js';
import type { Decision } from '../hooks/types.js';
import { decisionWarnings } from './decisions-warn.js';
import { readTranscript } from './multi-file.js';

type Signals = readonly [id: string, re: RegExp][];
type Hit = { pattern: string; excerpt: string };

export const PROMPT_SIGNALS: Signals = [
  ['P1', /\b(from now on|going forward|in (the )?future)\b/i],
  ['P2', /\b(always|never)\s+(use|call|import|run|put|write|add|commit|name)\b/i],
  ['P3', /\b(don'?t|do not|stop)\s+(using|use|calling|call|importing|import|adding|add)\b/i],
  ['P4', /\bwe\s+(decided|agreed|chose|settled on|prefer|always|never)\b/i],
  ['P5', /\b(the|our)\s+(convention|rule|standard|policy)\s+(is|here is)\b/i],
];
export const ASSISTANT_SIGNALS: Signals = [
  ['A1', /\bI('ll| will)\s+(remember|keep (this|that) in mind)\b/i],
  ['A2', /\b(from now on|going forward),?\s+I('ll| will)\b/i],
];
export const MAX_HITS = 3;
export const PROMPT_SCAN = 4000;
export const EXCERPT = 120;

const ALLOW: Decision = { kind: 'allow' };
const REMEMBER_ADD = /\bremember\b[\s\S]*\badd\b/;

// Redact first, so a secret cut by the excerpt's edge can't leak in part.
function scan(text: string, signals: Signals): Hit[] {
  const t = redactSecrets(text);
  const hits: Hit[] = [];
  for (const [pattern, re] of signals) {
    const m = re.exec(t);
    if (!m) continue;
    const start = Math.max(0, Math.min(m.index + (m[0].length >> 1) - EXCERPT / 2, t.length - EXCERPT));
    const cut = t.slice(start, start + EXCERPT).replace(/\s+/g, ' ').trim();
    hits.push({ pattern, excerpt: `${start > 0 ? '…' : ''}${cut}${start + EXCERPT < t.length ? '…' : ''}` });
  }
  return hits;
}

function logCandidates(ctx: Ctx, hits: Hit[]): void {
  try {
    for (const h of hits) appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'decisions', decision: 'decision-candidate', reason: `${h.pattern}: ${h.excerpt}` });
  } catch {
    // event log is best effort
  }
}

// ponytail: the Bash tool_response shape for a failed command isn't pinned; unknown shapes count as success (plan).
const failed = (res: unknown): boolean => {
  if (typeof res !== 'object' || res === null) return false;
  const r = res as Record<string, unknown>;
  const code = r.exitCode ?? r.exit_code;
  return r.interrupted === true || r.is_error === true || (typeof code === 'number' && code !== 0);
};

// Only the last record is read, so a short tail is enough; a final record over 1 MiB is skipped (no nudge, the safe way).
const STOP_TAIL = 1024 * 1024;

// Last assistant text: the Stop input's field, else the transcript tail's last record when it is this turn's answer.
function lastAssistant(ctx: Ctx): string {
  const { last_assistant_message: m, transcript_path: t } = ctx.input;
  if (typeof m === 'string') return m;
  const last = readTranscript(t, STOP_TAIL)?.at(-1);
  return last && !last.prompt ? last.texts.join('\n') : '';
}

// Attended, a Stop scan can't change what shows: skip it (and its transcript read).
const stopSettled = (ctx: Ctx): boolean => {
  const { config, state } = ctx;
  return !config.checks.stop || !config.decisions.nudge || !!state.decisionNudged || !!state.rememberAdded || (state.decisionHits?.length ?? 0) >= MAX_HITS;
};

export const decisionSignals: Check = {
  name: 'decision-signals',
  events: ['UserPromptSubmit', 'PostToolUse', 'Stop'], // registered before stopGate, which reads the hits stored here
  run(ctx) {
    const { input, config, state } = ctx;
    if (!config.checks.decisions) return ALLOW;
    if (input.hook_event_name === 'PostToolUse') {
      const cmd = input.tool_name === 'Bash' ? input.tool_input?.command : undefined;
      if (!state.rememberAdded && typeof cmd === 'string' && REMEMBER_ADD.test(cmd) && !failed(input.tool_response)) ctx.save({ ...state, rememberAdded: true });
      return ALLOW;
    }
    const stop = input.hook_event_name === 'Stop';
    if (stop && !ctx.unattended && stopSettled(ctx)) return ALLOW;
    const hits = stop ? scan(lastAssistant(ctx), ASSISTANT_SIGNALS) : scan(String(input.prompt ?? '').slice(0, PROMPT_SCAN), PROMPT_SIGNALS);
    const kept = state.decisionHits ?? [];
    if (ctx.unattended) logCandidates(ctx, hits);
    else if (hits.length && kept.length < MAX_HITS) ctx.save({ ...state, decisionHits: [...kept, ...hits].slice(0, MAX_HITS) });
    return ALLOW;
  },
};

/** The Stop notes for team decisions. Called only on the gate's allow path, so a note it returns is shown. */
export function decisionNotes(ctx: Ctx, changed: string[]): string[] {
  const warnings = decisionWarnings(ctx, changed);
  return [...warnings, ...nudge(ctx)];
}

function nudge(ctx: Ctx): string[] {
  const { config, state } = ctx;
  if (ctx.unattended || !config.decisions.nudge || state.decisionNudged || state.rememberAdded) return [];
  const hit = state.decisionHits?.[0];
  if (!hit) return [];
  ctx.save({ ...ctx.state, decisionNudged: true });
  return [`Harness: this session may hold a team decision (you said "${hit.excerpt}"). To keep it for the team, ask Claude to save it with \`harness remember add\`; you approve the write and the PR reviews it. If it's only your own preference, Claude Code's auto memory is the place.`];
}
