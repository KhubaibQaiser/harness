import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Where a trusted harness CLI last ran from on this machine (gitignored, protected state), so the guard can name a
// runnable command. Only known install places count: a path the agent could write would let it steer the person.
const REL = '.harness/state/cli-path';
const slash = (p: string) => p.replace(/\\/g, '/');

/**
 * Trusted: a CLI inside a node_modules install of the package (a repo, workspace or global npm install; the global
 * prefix keeps it under node_modules too) or inside the plugin's install folder (CLAUDE_PLUGIN_ROOT, when set).
 * ponytail: the plugin folder is only known when CLAUDE_PLUGIN_ROOT is in the env; plugin runs without it don't record.
 */
/** The CLI's real path when it is trusted, else null. */
export function trustedCli(cli: string, env: NodeJS.ProcessEnv): string | null {
  let real: string;
  try {
    real = realpathSync.native(cli);
  } catch {
    return null;
  }
  if (/\/node_modules\/@khubaibqaiser\/harness\/dist\/cli\.m?js$/.test(slash(real))) return real;
  const plugin = env.CLAUDE_PLUGIN_ROOT;
  if (!plugin) return null;
  try {
    const root = slash(realpathSync.native(plugin)).replace(/\/$/, '');
    return slash(real).startsWith(root + '/') ? real : null;
  } catch {
    return null;
  }
}

export function recordCliPath(root: string, cli: string, env: NodeJS.ProcessEnv): void {
  try {
    const real = trustedCli(cli, env);
    if (!existsSync(join(root, '.harness')) || !real) return; // not installed, or not a known place
    mkdirSync(join(root, '.harness/state'), { recursive: true });
    writeFileSync(join(root, REL), real);
  } catch {} // best effort: the guard then names no path
}

/** The recorded CLI path, when it is absolute and still exists. */
export function readCliPath(root: string): string | null {
  try {
    const p = readFileSync(join(root, REL), 'utf8').trim();
    return isAbsolute(p) && /cli\.m?js$/.test(p) && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
