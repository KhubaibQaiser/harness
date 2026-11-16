import type { HookInput } from '../hooks/types.js';

// Background subagents are not detected: hook input does not say whether one runs in the background.
/** A scrubbed `claude -p` launch keeps this in hooks even in default mode (spec 10.5, 15 item 23). */
export const scrubOn = (env: NodeJS.ProcessEnv): boolean =>
  !['', '0', 'false', 'no', 'off'].includes((env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? '').trim().toLowerCase()); // fail closed: any other value counts; narrow after live check L0a

/** The env parts of isUnattended, for CLI commands that have no hook input. */
export const unattendedEnv = (env: NodeJS.ProcessEnv): boolean =>
  env.CLAUDE_CODE_REMOTE === 'true' ||
  (env.CI === 'true' || env.CI === '1') ||
  (env.HARNESS_UNATTENDED === '1' || env.HARNESS_UNATTENDED === 'true') ||
  scrubOn(env);

export function isUnattended(input: HookInput, env: NodeJS.ProcessEnv): boolean {
  return (
    unattendedEnv(env) ||
    input.permission_mode === 'dontAsk' ||
    input.permission_mode === 'bypassPermissions'
  );
}

/** Unattended with the scrub, attended without it: the only case the SessionStart note is for. */
export const scrubOnly = (input: HookInput, env: NodeJS.ProcessEnv): boolean =>
  scrubOn(env) && !isUnattended(input, { ...env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: undefined });
