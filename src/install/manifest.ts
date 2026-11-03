import { existsSync, readFileSync } from 'node:fs';
import { retryTransient } from '../core/atomic.js';
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
  constructor(options?: { cause?: unknown; message?: string }) {
    super(options?.message ?? '`.harness/manifest.json` is unreadable. Restore it from git or delete `.harness/` and run harness init again.', options);
    this.name = 'ManifestError';
  }
}

export function readManifest(root: string, read: (p: string, e: 'utf8') => string = readFileSync): Manifest | null {
  const p = join(root, MANIFEST_REL);
  if (!existsSync(p)) return null;
  let text: string;
  try {
    text = retryTransient(() => read(p, 'utf8'));
  } catch (cause) {
    // A read error (a Windows lock that outlasted the retries) is not a corrupt file: never suggest deleting .harness/.
    const why = (cause as Error).message.split('\n')[0];
    throw new ManifestError({ cause, message: `\`.harness/manifest.json\` could not be read (${why}). Try again; if it keeps failing, check what holds the file open.` });
  }
  try {
    const m = JSON.parse(text);
    if (m === null || typeof m !== 'object' || Array.isArray(m) || !Array.isArray(m.files)) throw new Error('bad shape');
    return m as Manifest;
  } catch (cause) {
    throw new ManifestError({ cause });
  }
}
