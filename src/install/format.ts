import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const FORMAT_MS = 15_000;

/** The repo's own Prettier CLI: from node_modules in the file's folder or a parent, up to the repo root. Null when absent. */
export function repoPrettier(root: string, rel: string): string | null {
  const top = resolve(root);
  for (let d = dirname(resolve(root, rel)); ; d = dirname(d)) {
    const pj = join(d, 'node_modules', 'prettier', 'package.json');
    if (existsSync(pj)) {
      try {
        const bin = JSON.parse(readFileSync(pj, 'utf8')).bin;
        const b = typeof bin === 'string' ? bin : bin?.prettier;
        if (typeof b === 'string') return join(dirname(pj), b);
      } catch {}
    }
    if (d === top || dirname(d) === d) return null;
  }
}

/** `text` formatted as `rel` by that Prettier, with the repo's own config. No shell; throws on failure or timeout. */
// SIGKILL at the timeout: a child that ignores SIGTERM would otherwise keep execFileSync waiting forever.
// ponytail: only Prettier's own process is killed; Prettier spawns no children, so no tree kill (as the Stop gate has).
export function prettierFormat(bin: string, root: string, rel: string, text: string, timeoutMs = FORMAT_MS): string {
  return execFileSync(process.execPath, [bin, '--stdin-filepath', resolve(root, rel)], {
    cwd: root, input: text, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
}
