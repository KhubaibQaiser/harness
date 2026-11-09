import type { HookInput } from '../hooks/types.js';

// Background subagents are not detected: hook input does not say whether one runs in the background.
/** The env parts of isUnattended, for CLI commands that have no hook input. */
export const unattendedEnv = (env: NodeJS.ProcessEnv): boolean =>
  env.CLAUDE_CODE_REMOTE === 'true' ||
  (env.CI === 'true' || env.CI === '1') ||
  (env.HARNESS_UNATTENDED === '1' || env.HARNESS_UNATTENDED === 'true');

export function isUnattended(input: HookInput, env: NodeJS.ProcessEnv): boolean {
  return (
    unattendedEnv(env) ||
    input.permission_mode === 'dontAsk' ||
    input.permission_mode === 'bypassPermissions'
  );
}
