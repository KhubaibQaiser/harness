import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Package-local only: walks up from src/core, dist or dist/hooks to the nearest package.json, so source, tests and both bundles agree.
export function packageDir(sub: 'templates' | 'catalog' | 'dist'): string {
  // Test-only override (undocumented); needs the second variable so a stray export cannot redirect a real run.
  const o = process.env.HARNESS_CATALOG_DIR;
  if (sub === 'catalog' && o && process.env.HARNESS_PLAIN_INIT === '1') return o;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('harness package root not found');
    dir = up;
  }
  return join(dir, sub);
}
