import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Manifest {
  version: string;
  createdAt: string;
  files: { rel: string; kind: 'create' | 'update' | 'delete'; hash: string; backup?: string; blocks?: string[] }[];
}

export const MANIFEST_REL = '.harness/manifest.json';

export function readManifest(root: string): Manifest | null {
  const p = join(root, MANIFEST_REL);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Manifest) : null;
}
