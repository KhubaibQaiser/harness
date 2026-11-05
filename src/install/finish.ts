import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Change, Manifest } from './apply.js';
import { dirtyPaths } from './git-status.js';
import { REPO_STATE, isBackupPath, type StatePaths } from './manifest.js';
import { STRUCTURAL } from './merge.js';

/** A structural file with no change still loses its dropped blocks (in `m`, in place). Returns how many it dropped. */
export function pruneStale(m: Manifest, changes: Change[], dropped: string[]): number {
  let stale = 0;
  for (const rel of STRUCTURAL) {
    const f = m.files.find((x) => x.rel === rel);
    if (changes.some((c) => c.rel === rel) || !f?.blocks) continue;
    const kept = f.blocks.filter((b) => !dropped.includes(b));
    stale += f.blocks.length - kept.length;
    if (kept.length) f.blocks = kept;
    else delete f.blocks;
  }
  return stale;
}

/** The files `changes` would write that have uncommitted changes. */
export function dirtyTouched(root: string, changes: Change[]): string[] {
  const dirty = dirtyPaths(root);
  return changes.map((c) => c.rel).filter((rel) => dirty.some((d) => d === rel || (d.endsWith('/') && rel.startsWith(d))));
}

/** The original is back in place: delete its backup. The path comes from the manifest, so only inside .harness/backup/. */
export function dropRestoredBackups(root: string, changes: Change[], sp: StatePaths = REPO_STATE): void {
  for (const c of changes) if (c.kind === 'update' && c.restored && isBackupPath(c.restored, sp)) rmSync(join(root, c.restored), { force: true });
}
