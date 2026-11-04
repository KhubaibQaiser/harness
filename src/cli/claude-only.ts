/** The harness supports Claude Code only for now: any non-empty CLAUDECODE counts as inside it. */
export const insideClaude = (env: NodeJS.ProcessEnv): boolean => !!env.CLAUDECODE;

/**
 * The refusal for an AI command run outside Claude Code, or null to go on.
 * HARNESS_PLAIN_INIT=1 (tests only) lets init and update take the plain path, unless AI flags ask for the AI path.
 */
export function refuseOutsideClaude(cmd: 'init' | 'update' | 'add' | 'sync', env: NodeJS.ProcessEnv, aiFlags: boolean): string | null {
  if (insideClaude(env) || (env.HARNESS_PLAIN_INIT === '1' && !aiFlags)) return null;
  return `Run /harness:${cmd} inside Claude Code. The harness supports Claude Code only for now.`;
}

// Any of these present means the AI path.
const AI_FLAGS = ['--answers', '--picks', '--choose', '--report', '--product'];
export const hasAiFlags = (args: string[]): boolean => args.some((a) => AI_FLAGS.includes(a));
