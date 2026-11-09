import { WorkBudget } from '../core/shell-words.js';
import type { Check, Ctx } from './check.js';
import { type Log, warn } from './event-log.js';
import type { Decision, HookEvent } from './types.js';

type AskDecision = { kind: 'ask'; reason: string; check: string };

/** One check's decision; a throw denies for a failClosed check and is skipped (null) for any other. A spent work budget
 *  (WorkBudget) always denies, with its own reason. */
async function runOne(c: Check, ctx: Ctx): Promise<Decision | null> {
  try {
    const r = await c.run(ctx);
    if (!r || typeof r !== 'object' || typeof r.kind !== 'string') throw new Error('invalid check result');
    return r;
  } catch (e) {
    if (e instanceof WorkBudget) return { kind: 'deny', reason: e.message, check: c.name }; // fail closed, whatever the check
    const msg = String((e as Error)?.message ?? e);
    if (!c.failClosed) {
      process.stderr.write(`harness: check ${c.name} failed: ${msg}\n`);
      return null;
    }
    return { kind: 'deny', reason: `harness check ${c.name} failed: ${msg}`, check: c.name };
  }
}

/** An ask blocks at Stop, is ignored (null) outside PreToolUse, and denies in an unattended run. */
function resolveAsk(d: AskDecision, event: HookEvent, unattended: boolean, log: Log): Exclude<Decision, { kind: 'allow' }> | null {
  if (event === 'Stop') return { kind: 'block', reason: d.reason, check: d.check };
  if (event !== 'PreToolUse') {
    log(d.check, 'ask-ignored', d.reason);
    return null;
  }
  return unattended ? { kind: 'deny', reason: `Unattended run: ${d.reason}`, check: d.check } : d;
}

/** Runs the event's checks in registry order and returns the decisions that count. */
export async function runChecks(ctx: Ctx, checks: Check[], degraded: boolean, log: Log): Promise<Decision[]> {
  const event = ctx.input.hook_event_name as HookEvent;
  const decisions: Decision[] = [];
  let denied = false; // after the first PreToolUse deny only pure checks run; their findings are logged, not returned
  for (const c of checks.filter((c) => c.events.includes(event) && (!degraded || c.failClosed))) {
    if (denied && !c.pure) continue;
    let d = await runOne(c, ctx);
    if (!d || d.kind === 'allow') continue;
    if (d.kind === 'ask') d = resolveAsk(d as AskDecision, event, ctx.unattended, log); // Decision types deny and ask as one member, so the kind check does not narrow it
    if (!d) continue;
    log(d.check, d.kind, d.kind === 'context' ? d.text : d.reason, denied ? true : undefined);
    if (!denied) decisions.push(d);
    if (event === 'PreToolUse' && d.kind === 'deny') denied = true;
  }
  return decisions;
}

/** PreToolUse with a plain allow: each check's afterAllow, a throw only warns. */
export function runAfterAllow(ctx: Ctx, checks: Check[], degraded: boolean): void {
  const event = ctx.input.hook_event_name as HookEvent;
  for (const c of checks) {
    if (!c.afterAllow || !c.events.includes(event) || (degraded && !c.failClosed)) continue;
    try {
      c.afterAllow(ctx);
    } catch (e) {
      warn(`check ${c.name} afterAllow`, e);
    }
  }
}
