import type { Decision, HookInput } from './types.js';

export function parseInput(raw: string): HookInput | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return typeof (v as { hook_event_name?: unknown }).hook_event_name === 'string' ? (v as HookInput) : null;
  } catch {
    return null;
  }
}

export function emit(event: string, d: Decision): string {
  if (d.kind === 'allow') return '';
  if (d.kind === 'context') {
    return JSON.stringify(
      event === 'Stop' || event === 'SessionEnd'
        ? { systemMessage: d.text }
        : { hookSpecificOutput: { hookEventName: event, additionalContext: d.text } },
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
