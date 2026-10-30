import type { HookInput } from '../hooks/types.js';

// Background subagents are not detected: hook input does not say whether one runs in the background.
export function isUnattended(input: HookInput, env: NodeJS.ProcessEnv): boolean {
  return (
    env.CLAUDE_CODE_REMOTE === 'true' ||
    env.CI === 'true' ||
    env.HARNESS_UNATTENDED === '1' ||
    input.permission_mode === 'dontAsk' ||
    input.permission_mode === 'bypassPermissions'
  );
}
