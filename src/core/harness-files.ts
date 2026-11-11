import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { retryTransient, writeAtomic } from './atomic.js';
import { RULE_GLOB } from './decision-rule.js';
import { userSettingsPath } from './settings-layers.js';
import { SAFE_GIT } from './git-safe.js';

// Change detection, the backstop behind the path checks (owner decision 2026-11-03): when a route the path checks
// don't parse changed one of harness's own files, the next prompt and Stop say so. A session compares against its
// baseline: the repo's last-seen snapshot (kept by each Stop, SessionEnd and the harness CLI), or on a fresh clone the
// files at its first hook. The harness CLI also records what its own writes leave, so they don't count.
// ponytail: the snapshots live in .harness/state; a script that rewrites them too can hide its change.
const FIXED = ['.harness/config.yaml', '.harness/manifest.json', '.claude/settings.json', '.claude/settings.local.json'];
const SETTINGS = new Set(['.claude/settings.json', '.claude/settings.local.json']);
const REPO = '.harness/state/files-snapshot.json';
export type Snapshot = Record<string, string>; // repo-relative path -> sha-256 fingerprint
// cli.settings: the project settings file's fingerprint as the CLI left it, null when absent (ConfigChange's CLI record).
// cli.id: unique per CLI run, so ConfigChange honours only a record written after the session's baseline.
type RepoSnapshot = { lastSeen?: { files: Snapshot; head?: string }; cli?: { files: Snapshot; settings?: Record<string, string | null>; id?: string } };

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
export function harnessDenyRules(root: string): Set<string> | null {
  try {
    const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8'));
    const f = m.files.find((x: { rel: string }) => x.rel === '.claude/settings.json');
    if (!f) return null;
    return new Set((f.blocks ?? []).map((b: string) => JSON.parse(b)?.deny).filter((d: unknown) => typeof d === 'string'));
  } catch {
    return null;
  }
}

export type GuardedPart = 'hooks' | 'deny' | 'disableAllHooks' | 'sandbox' | 'env' | 'unreadable';
export type GuardedView = { hooks: [string, unknown[]][]; deny: string[]; disableAllHooks: unknown; sandbox: unknown; env?: unknown } | null;

/**
 * Only what harness relies on in a Claude settings file: the hook groups that run its dispatcher, its own deny rules,
 * disableAllHooks, sandbox and env (it can set the variables the hooks read). permissions.allow and the other keys Claude Code writes (an "Always allow" click) don't
 * count. An absent file is the empty view; null means the file isn't JSON.
 */
export function guardedView(text: string | null, deny: Set<string> | null): GuardedView {
  let s;
  try {
    s = JSON.parse(text ?? '{}');
  } catch {
    return null;
  }
  const hooks = Object.entries(s?.hooks ?? {})
    .map(([ev, groups]): [string, unknown[]] => [ev, (Array.isArray(groups) ? groups : []).filter((g) => JSON.stringify(g).includes('.harness/hooks/dispatch.mjs'))])
    .filter(([, g]) => g.length)
    .sort(([a], [b]) => a.localeCompare(b));
  const rules = (Array.isArray(s?.permissions?.deny) ? s.permissions.deny : []).filter((d: unknown) => typeof d === 'string' && (!deny || deny.has(d))).sort();
  // sandbox and env stay undefined when absent, so a file without them keeps the fingerprint it had before they counted.
  // env keeps each key with a hash of its value: the session state must not hold the secrets env often carries.
  // ponytail: unsalted sha-256, so a low-entropy value (CI=false) can be guessed from .harness/state; salt it if that matters.
  const env = s?.env && typeof s.env === 'object' && !Array.isArray(s.env) ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, sha(JSON.stringify(v))])) : s?.env;
  return { hooks, deny: rules, disableAllHooks: s?.disableAllHooks ?? null, sandbox: s?.sandbox, env };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** The guarded parts changed from base to cur. A deny rule counts only when a base rule is gone (removed or narrowed). */
export function guardedDiff(base: GuardedView, cur: GuardedView): GuardedPart[] {
  if (!base || !cur) return ['unreadable'];
  const parts: GuardedPart[] = [];
  if (!same(base.hooks, cur.hooks)) parts.push('hooks');
  if (base.deny.some((r) => !cur.deny.includes(r))) parts.push('deny');
  if (!same(base.disableAllHooks, cur.disableAllHooks)) parts.push('disableAllHooks');
  if (!same(base.sandbox, cur.sandbox)) parts.push('sandbox');
  if (!same(base.env, cur.env)) parts.push('env');
  return parts;
}

export const GUARDED = { user: userSettingsPath, project: '.claude/settings.json', local: '.claude/settings.local.json' } as const;
/** The file's text, or null when it doesn't exist; any other read error throws. */
export function readGuarded(path: string): string | null {
  try {
    return retryTransient(() => readFileSync(path, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}
const viewOf = (path: string, deny: Set<string> | null): GuardedView => {
  try {
    return guardedView(readGuarded(path), deny);
  } catch {
    return null; // unreadable counts like non-JSON
  }
};
/** The guarded views of the user, project and local settings: ConfigChange's session baseline. */
export function guardedViews(root: string, home: string, env: NodeJS.ProcessEnv): Record<'user' | 'project' | 'local', GuardedView> {
  const deny = harnessDenyRules(root);
  return { user: viewOf(GUARDED.user(home, env), deny), project: viewOf(join(root, GUARDED.project), deny), local: viewOf(join(root, GUARDED.local), deny) };
}

export function settingsFingerprint(text: string, deny: Set<string> | null): string {
  const v = guardedView(text, deny);
  return v ? sha(JSON.stringify(v)) : sha(lf(text)); // not JSON: any change counts
}

const EMPTY_SETTINGS = settingsFingerprint('{}', null);
// The generated decision rules the manifest lists. A plain read: manifest.ts imports this file (drift 12).
function ruleFiles(root: string): string[] {
  try {
    const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8'));
    return (m.files as { rel: unknown }[]).map((f) => f.rel).filter((r): r is string => typeof r === 'string' && RULE_GLOB.test(r));
  } catch {
    return [];
  }
}

/** Fingerprints of config.yaml, manifest.json, every file under .harness/hooks, the Claude settings and the manifest's decision rules that exist. */
export function snapshotHarnessFiles(root: string): Snapshot {
  const out: Snapshot = {};
  const deny = harnessDenyRules(root);
  for (const rel of [...new Set([...FIXED, ...hooksFiles(root), ...ruleFiles(root)])].sort()) {
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
  const r = spawnSync('git', [...SAFE_GIT, 'rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 2000 });
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
  const deny = harnessDenyRules(root);
  const settings: Record<string, string | null> = {};
  try {
    const text = readGuarded(join(root, GUARDED.project)); // the only settings file the CLI writes
    settings[GUARDED.project] = text === null ? null : settingsFingerprint(text, deny);
  } catch {} // unreadable: no record, so no change to it is allowed as the CLI's
  writeRepoSnapshot(root, { cli: { files, settings, id: randomUUID() }, lastSeen: { files, ...(head ? { head } : {}) } });
}
