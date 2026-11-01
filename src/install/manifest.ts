import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Manifest {
  version: string;
  createdAt: string;
  files: { rel: string; kind: 'create' | 'update' | 'delete'; hash: string; backup?: string; blocks?: string[] }[];
}

export const MANIFEST_REL = '.harness/manifest.json';

export class ManifestError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('`.harness/manifest.json` is unreadable. Restore it from git or delete `.harness/` and run harness init again.', options);
    this.name = 'ManifestError';
  }
}

export function readManifest(root: string): Manifest | null {
  const p = join(root, MANIFEST_REL);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    if (m === null || typeof m !== 'object' || Array.isArray(m) || !Array.isArray(m.files)) throw new Error('bad shape');
    return m as Manifest;
  } catch (cause) {
    throw new ManifestError({ cause });
  }
}
