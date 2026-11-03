import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { retryTransient, writeAtomic } from './atomic.js';

// Change detection, the backstop behind the path checks (owner decision 2026-11-03): when a route the path checks
// don't parse changed one of harness's own files, the next prompt and Stop say so. A session compares against its
// baseline: the repo's last-seen snapshot (kept by each Stop, SessionEnd and the harness CLI), or on a fresh clone the
// files at its first hook. The harness CLI also records what its own writes leave, so they don't count.
// ponytail: the snapshots live in .harness/state; a script that rewrites them too can hide its change.
const FIXED = ['.harness/config.yaml', '.harness/manifest.json', '.claude/settings.json', '.claude/settings.local.json'];
const SETTINGS = new Set(['.claude/settings.json', '.claude/settings.local.json']);
const REPO = '.harness/state/files-snapshot.json';
export type Snapshot = Record<string, string>; // repo-relative path -> sha-256 fingerprint
type RepoSnapshot = { lastSeen?: { files: Snapshot; head?: string }; cli?: { files: Snapshot } };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const lf = (s: string) => s.replace(/\r\n/g, '\n');

function hooksFiles(root: string, rel = '.harness/hooks'): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.isDirectory() ? hooksFiles(root, `${rel}/${e.name}`) : e.isFile() ? [`${rel}/${e.name}`] : []));
}

/** The deny rules harness installed, from the manifest's settings blocks; null when unknown (then every rule counts). */
function harnessDenyRules(root: string): Set<string> | null {
  try {
    const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8'));
    const f = m.files.find((x: { rel: string }) => x.rel === '.claude/settings.json');
    if (!f) return null;
    return new Set((f.blocks ?? []).map((b: string) => JSON.parse(b)?.deny).filter((d: unknown) => typeof d === 'string'));
  } catch {
    return null;
  }
}

/**
 * Only what harness relies on in a Claude settings file: the hook groups that run its dispatcher, its own deny rules,
 * and disableAllHooks. permissions.allow and the other keys Claude Code writes (an "Always allow" click) don't count.
 */
function settingsFingerprint(text: string, deny: Set<string> | null): string {
  try {
    const s = JSON.parse(text);
    const hooks = Object.entries(s?.hooks ?? {})
      .map(([ev, groups]) => [ev, (Array.isArray(groups) ? groups : []).filter((g) => JSON.stringify(g).includes('.harness/hooks/dispatch.mjs'))] as const)
      .filter(([, g]) => g.length)
      .sort(([a], [b]) => a.localeCompare(b));
    const rules = (Array.isArray(s?.permissions?.deny) ? s.permissions.deny : []).filter((d: unknown) => typeof d === 'string' && (!deny || deny.has(d))).sort();
    return sha(JSON.stringify({ hooks, deny: rules, disableAllHooks: s?.disableAllHooks ?? null }));
  } catch {
    return sha(lf(text)); // not JSON: any change counts
  }
}

const EMPTY_SETTINGS = settingsFingerprint('{}', null);
/** Fingerprints of config.yaml, manifest.json, every file under .harness/hooks, and the Claude settings that exist. */
export function snapshotHarnessFiles(root: string): Snapshot {
  const out: Snapshot = {};
  const deny = harnessDenyRules(root);
  for (const rel of [...FIXED, ...hooksFiles(root)].sort()) {
    if (!existsSync(join(root, rel))) continue;
    try {
      const text = retryTransient(() => readFileSync(join(root, rel), 'utf8'));
      const fp = SETTINGS.has(rel) ? settingsFingerprint(text, deny) : sha(lf(text)); // line endings don't count
      // A settings file holding nothing harness relies on counts as absent (Claude Code creates settings.local.json).
      if (!(SETTINGS.has(rel) && fp === EMPTY_SETTINGS)) out[rel] = fp;
    } catch {
      out[rel] = 'unreadable';
    }
  }
  return out;
}

/** The files added, removed or changed between two snapshots, sorted. */
export const changedFiles = (a: Snapshot, b: Snapshot): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

/** HEAD's sha, or undefined (no repo, no commits). */
export function gitHead(root: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 2000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

export function readRepoSnapshot(root: string): RepoSnapshot {
  try {
    const v = JSON.parse(readFileSync(join(root, REPO), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function writeRepoSnapshot(root: string, v: RepoSnapshot): void {
  try {
    if (!existsSync(join(root, '.harness'))) return; // not installed
    mkdirSync(join(root, '.harness/state'), { recursive: true }); // right after init it doesn't exist yet
    writeAtomic(join(root, REPO), JSON.stringify(v));
  } catch {} // best effort: without it the next session starts from its first hook
}

/**
 * Hooks: the snapshot this session has now accounted for, as the baseline the next session starts from. The CLI's
 * record covers only the change the CLI made: once the accounted-for files move past it, it is dropped, so a later
 * script that writes the CLI-time files back is reported like any other change.
 */
export function recordLastSeen(root: string, files: Snapshot, head?: string): void {
  const { cli } = readRepoSnapshot(root);
  const keep = cli && !changedFiles(cli.files, files).length ? { cli } : {};
  writeRepoSnapshot(root, { ...keep, lastSeen: { files, ...(head ? { head } : {}) } });
}

/** Called by init, update and uninstall after they write: what their own changes leave, so the hooks don't report them. */
export function stampHarnessFiles(root: string): void {
  const files = snapshotHarnessFiles(root);
  const head = gitHead(root);
  writeRepoSnapshot(root, { cli: { files }, lastSeen: { files, ...(head ? { head } : {}) } });
}
