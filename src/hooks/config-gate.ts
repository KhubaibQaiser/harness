import { resolve } from 'node:path';
import { shellWriteTargets } from '../checks/protect.js';
import { toRepoPath } from '../core/paths.js';
import type { Ctx } from './check.js';
import { editTarget, isShell } from './edit-target.js';
import type { Log } from './event-log.js';
import { emit } from './io.js';
import type { HookEvent } from './types.js';

const CONFIG = '.harness/config.yaml';
export const configInvalidWhy = (errors: string[]): string =>
  `\`${CONFIG}\` is invalid: ${errors.join('; ')}. Harness blocks edits and stopping until a person fixes it, so no gate is off by mistake: ask the user to correct ${CONFIG} (harness doctor checks it).`;

/**
 * An invalid config never turns a gate off silently: edits (except to the config itself, which the usual checks
 * still judge) and Stop fail closed. Stop shares the Stop gate's attempt counter, so the session can still end.
 * Returns the hook's output when it decides, or undefined to go on to the checks.
 */
export function configInvalidGate(ctx: Ctx, event: HookEvent, errors: string[], log: Log): string | undefined {
  const reason = configInvalidWhy(errors);
  if (event === 'Stop') {
    const attempts = ctx.state.stopAttempts + 1;
    if (attempts > ctx.config.stop.max_attempts) {
      ctx.save({ ...ctx.state, stopAttempts: 0 });
      log('config', 'stop-gave-up', reason);
      return '';
    }
    ctx.save({ ...ctx.state, stopAttempts: attempts });
    log('config', 'block', reason);
    return emit(event, { kind: 'block', reason, check: 'config' });
  }
  const { input, root } = ctx;
  const t = event === 'PreToolUse' ? editTarget(input) : null;
  // Shell writes and deletes count as edits; a target outside the repo, or the config itself, does not.
  const shell = event === 'PreToolUse' && isShell(input.tool_name) ? shellWriteTargets(String(input.tool_input?.command ?? '')) : [];
  const inRepo = (p: string) => { const rel = toRepoPath(root, p); return rel !== null ? rel.toLowerCase() !== CONFIG : resolve(root, p) === resolve(root); };
  if ((t !== null && toRepoPath(root, t)?.toLowerCase() !== CONFIG) || shell.some(inRepo)) {
    log('config', 'deny', reason);
    return emit(event, { kind: 'deny', reason, check: 'config' });
  }
  return undefined;
}
