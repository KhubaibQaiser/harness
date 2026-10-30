import { isAbsolute, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';

export function toRepoPath(root: string, p: string): string | null {
  const rel = relative(resolve(root), resolve(root, p));
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

export const matches = (rel: string, globs: string[]): boolean => globs.length > 0 && picomatch(globs, { dot: true })(rel);

export const isTestFile = (rel: string): boolean => /\.(test|spec)\.[^/]+$/.test(rel) || /(^|\/)__tests__\//.test(rel);

export const pairKey = (rel: string): string => rel.replace(/(^|\/)__tests__\//, '$1').replace(/\.(test|spec)(\.[^./]+)$/, '$2');
