import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { retryTransient, writeAtomic } from './atomic.js';

// Change detection, the backstop behind the path checks (owner decision 2026-11-03): whatever route changed one of
// harness's own files (a script, an unparsed command), the next Stop or prompt says so. The hooks compare against the
// snapshot taken at the session's first hook; the harness CLI stamps the snapshot it leaves behind, so its own writes
// don't count.
const FIXED = ['.harness/config.yaml', '.harness/manifest.json', '.claude/settings.json', '.claude/settings.local.json'];
const STAMP = '.harness/state/files-snapshot.json';
export type Snapshot = Record<string, string>; // repo-relative path -> sha-256 of its bytes

function hooksFiles(root: string, rel = '.harness/hooks'): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.isDirectory() ? hooksFiles(root, `${rel}/${e.name}`) : e.isFile() ? [`${rel}/${e.name}`] : []));
}

/** sha-256 of config.yaml, manifest.json, every file under .harness/hooks, and the Claude settings files that exist. */
export function snapshotHarnessFiles(root: string): Snapshot {
  const out: Snapshot = {};
  for (const rel of [...FIXED, ...hooksFiles(root)].sort()) {
    if (!existsSync(join(root, rel))) continue;
    try {
      out[rel] = createHash('sha256').update(retryTransient(() => readFileSync(join(root, rel)))).digest('hex');
    } catch {
      out[rel] = 'unreadable';
    }
  }
  return out;
}

/** The files added, removed or changed between two snapshots, sorted. */
export const changedFiles = (a: Snapshot, b: Snapshot): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

/** Called by init, update and uninstall after they write: the snapshot their own changes leave. */
export function stampHarnessFiles(root: string): void {
  try {
    if (existsSync(join(root, '.harness'))) writeAtomic(join(root, STAMP), JSON.stringify(snapshotHarnessFiles(root)));
  } catch {} // best effort: without a stamp the next hook reports the CLI's change once
}

export function readStamp(root: string): Snapshot | null {
  try {
    const v = JSON.parse(readFileSync(join(root, STAMP), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
