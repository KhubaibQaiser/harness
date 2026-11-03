import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Package-local only: walks up from src/core, dist or dist/hooks to the nearest package.json, so source, tests and both bundles agree.
export function packageDir(sub: 'templates' | 'catalog' | 'dist'): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('harness package root not found');
    dir = up;
  }
  return join(dir, sub);
}
