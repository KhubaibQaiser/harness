import { HIDDEN_CLASS } from '../core/config.js';
import type { Decision, HookInput } from './types.js';

/** Claude Code caps a systemMessage at 10,000 characters and swaps a longer one for a file path; stay under it. */
export const MAX_MESSAGE = 10_000;
const TRUNCATED = '... [truncated]';
const UNSAFE = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f${HIDDEN_CLASS}]`, 'gu'); // keeps \t and \n
const NUMBER_BASE = 16;
const UNICODE_PAD = 4;
const BMP_MAX = 0xffff;

/** The docs give additionalContext the same 10,000-character cap as systemMessage. */
export const MAX_CONTEXT = MAX_MESSAGE;
const PARTIAL_ESCAPE = /\\u(?:\{[0-9a-f]*|[0-9a-f]{0,3})$/;
const HIGH_SURROGATE = /[\ud800-\udbff]$/;

/** Cuts to `max` characters with a marker, never inside a surrogate pair or a \uXXXX escape. */
export const capMessage = (s: string, max = MAX_MESSAGE): string => {
  if (s.length <= max) return s;
  const head = s.slice(0, max - TRUNCATED.length).replace(HIGH_SURROGATE, '').replace(PARTIAL_ESCAPE, '');
  return head + TRUNCATED;
};

/** Text the person reads: control and hidden characters (bidi, zero-width, tags) become \uXXXX; newlines, tabs and quotes stay readable. */
export const shown = (s: string): string =>
  capMessage(
    s.replace(UNSAFE, (c) => {
      const cp = c.codePointAt(0)!.toString(NUMBER_BASE);
      return c.codePointAt(0)! > BMP_MAX ? `\\u{${cp}}` : `\\u${cp.padStart(UNICODE_PAD, '0')}`;
    }),
  );

export function parseInput(raw: string): HookInput | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return ['hook_event_name', 'session_id', 'cwd'].every((k) => typeof o[k] === 'string') ? (v as HookInput) : null;
  } catch {
    return null;
  }
}

export function emit(event: string, d: Decision): string {
  if (d.kind === 'allow') return '';
  if (d.kind === 'context') {
    // Stop: the text is the person's line, never the agent's (spec 14.3). SessionEnd: Claude Code discards a hook's JSON output there,
    // so nothing reaches the person; the warning stays in the harness event log only.
    return JSON.stringify(
      event === 'Stop' || event === 'SessionEnd'
        ? { systemMessage: shown(d.text) }
        : { hookSpecificOutput: { hookEventName: event, additionalContext: capMessage(d.text, MAX_CONTEXT) }, ...(d.notice ? { systemMessage: shown(d.notice) } : {}) },
    );
  }
  if (event === 'PreToolUse') {
    const decision = d.kind === 'block' ? 'deny' : d.kind;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, permissionDecision: decision, permissionDecisionReason: d.reason },
      // Claude Code 2.1.322 shows the reason in a Bash ask dialog but not in an Edit/Write one (live check i5m), so an ask
      // also shows it to the person directly.
      ...(decision === 'ask' ? { systemMessage: shown(d.reason) } : {}),
    });
  }
  return JSON.stringify({ decision: 'block', reason: d.reason });
}
