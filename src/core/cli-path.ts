import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { writeAtomic } from './atomic.js';
import { join } from 'node:path';

// Where the repo's own harness CLI last ran from (gitignored, protected state), so the guard can name a runnable
// command. Owner rule: only <repo>/node_modules/@khubaibqaiser/harness is trusted, because protect stops the agent
// writing there. A plugin folder, a global install or any other node_modules could be the agent's own copy.
const REL = '.harness/state/cli-path';
const slash = (p: string) => p.replace(/\\/g, '/');

/**
 * The CLI's real path when it is the repo's own install: its real path (symlinks resolved, so a link from the repo's
 * node_modules to elsewhere doesn't count) stays inside <repo>/node_modules and ends in the package's dist/cli.mjs.
 * pnpm's links into <repo>/node_modules/.pnpm stay inside, so they count. Null otherwise.
 */
export function trustedCli(cli: string, root: string): string | null {
  try {
    const real = realpathSync.native(cli);
    const nm = slash(realpathSync.native(root)).replace(/\/$/, '') + '/node_modules/';
    const r = slash(real);
    // Windows and macOS file systems ignore case.
    const inside = process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase().startsWith(nm.toLowerCase()) : r.startsWith(nm);
    return inside && /\/node_modules\/@khubaibqaiser\/harness\/dist\/cli\.m?js$/i.test(r) ? real : null;
  } catch {
    return null;
  }
}

export function recordCliPath(root: string, cli: string): void {
  try {
    const real = trustedCli(cli, root);
    if (!existsSync(join(root, '.harness')) || !real) return; // not installed, or not the repo's own CLI
    mkdirSync(join(root, '.harness/state'), { recursive: true });
    writeAtomic(join(root, REL), real);
  } catch {} // best effort: the guard then names no path
}

/** The recorded CLI path, checked again: it must still be the repo's own install. */
export function readCliPath(root: string): string | null {
  try {
    return trustedCli(readFileSync(join(root, REL), 'utf8').trim(), root);
  } catch {
    return null;
  }
}
