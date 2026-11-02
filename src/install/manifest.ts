import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Manifest {
  version: string;
  createdAt: string;
  /** Package dirs init left out of tdd.paths because their test config could not be edited safely. */
  tddOff?: string[];
  files: {
    rel: string; kind: 'create' | 'update' | 'delete'; hash: string; backup?: string; blocks?: string[];
    /** Set when the repo's Prettier formatted harness's edit: the line hunks that undo it (blocks no longer match). */
    replace?: { from: string; to: string }[];
    formatted?: true;
    /** Prettier was found but failed, so the edit was left unformatted. */
    unformatted?: true;
  }[];
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
