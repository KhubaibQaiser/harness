import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';

// Gitignore-style subset: `#` comments, blank lines, a leading `/` anchors, a trailing `/` means a directory,
// a pattern without `/` matches at any depth. No `!` negation (ponytail: add when someone needs it).
// The file is only ever read, never written.
export function harnessIgnore(root: string): (rel: string) => boolean {
  let text = '';
  try {
    text = readFileSync(join(root, '.harnessignore'), 'utf8');
  } catch {
    return () => false;
  }
  const globs = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => {
      const anchored = l.startsWith('/') || l.replace(/\/$/, '').includes('/');
      return (anchored ? '' : '**/') + l.replace(/^\//, '').replace(/\/$/, '');
    });
  if (!globs.length) return () => false;
  const match = picomatch(globs, { dot: true });
  return (rel) => {
    const segs = rel.split('/');
    // A path is ignored when it or any parent directory matches.
    return segs.some((_, i) => match(segs.slice(0, i + 1).join('/')));
  };
}
