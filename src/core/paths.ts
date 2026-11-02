import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';

// Native realpath gives what git reports: true case (macOS, Windows) and long names for 8.3 short ones (C:\Users\RUNNER~1).
const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return realpathSync(p); // some Windows volumes reject the native call
  }
};

// Realpath of the deepest existing ancestor, with the not-yet-existing remainder re-appended (new files don't exist yet).
function realish(p: string): string {
  const rest: string[] = [];
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try {
      return join(real(cur), ...rest.reverse());
    } catch {
      if (dirname(cur) === cur) return resolve(p);
      rest.push(basename(cur));
    }
  }
}

const rootCache = new Map<string, string>();

export function toRepoPath(root: string, p: string): string | null {
  let r = rootCache.get(root);
  if (r === undefined) rootCache.set(root, (r = realish(root)));
  const rel = relative(r, realish(resolve(root, p)));
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

export const matches = (rel: string, globs: string[]): boolean => globs.length > 0 && picomatch(globs, { dot: true })(rel);

export const isTestFile = (rel: string): boolean => /\.(test|spec)\.[^/]+$/.test(rel) || /(^|\/)__tests__\//.test(rel);

export const pairKey = (rel: string): string => rel.replace(/(^|\/)__tests__\//, '$1').replace(/\.(test|spec)(\.[^./]+)$/, '$2');
