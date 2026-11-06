import { HIDDEN_CLASS } from '../core/config.js';
import type { Decision, HookInput } from './types.js';

/** Claude Code caps a systemMessage at 10,000 characters and swaps a longer one for a file path; stay under it. */
export const MAX_MESSAGE = 10_000;
const TRUNCATED = '... [truncated]';
const UNSAFE = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f${HIDDEN_CLASS}]`, 'gu'); // keeps \t and \n
const NUMBER_BASE = 16;
const UNICODE_PAD = 4;
const BMP_MAX = 0xffff;

export const capMessage = (s: string): string => (s.length > MAX_MESSAGE ? s.slice(0, MAX_MESSAGE - TRUNCATED.length) + TRUNCATED : s);

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
        : { hookSpecificOutput: { hookEventName: event, additionalContext: d.text }, ...(d.notice ? { systemMessage: shown(d.notice) } : {}) },
    );
  }
  if (event === 'PreToolUse') {
    const decision = d.kind === 'block' ? 'deny' : d.kind;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, permissionDecision: decision, permissionDecisionReason: d.reason },
    });
  }
  return JSON.stringify({ decision: 'block', reason: d.reason });
}
