import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Where the harness CLI last ran from on this machine (gitignored state), so the guard can name a runnable command.
const REL = '.harness/state/cli-path';

export function recordCliPath(root: string, cli: string): void {
  try {
    if (!existsSync(join(root, '.harness'))) return; // not installed: write nothing
    mkdirSync(join(root, '.harness/state'), { recursive: true });
    writeFileSync(join(root, REL), cli);
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
