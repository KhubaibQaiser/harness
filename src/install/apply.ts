import * as nodeFs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REPO_STATE, ManifestError, readManifest, type Manifest, type StatePaths } from './manifest.js';
import type { Hunk } from './diff.js';
import { hashText } from './text.js';
import { renameWithRetry } from '../core/atomic.js';

export { readManifest, ManifestError, type Manifest };

export type Change =
  | { kind: 'create'; rel: string; content: string; mode?: number; blocks?: string[]; item?: string }
  | { kind: 'update'; rel: string; before: string; after: string; blocks: string[]; replace?: Hunk[]; formatted?: true; unformatted?: true; rename?: { from: string; to: string }; dropped?: string[]; item?: string; /** Harness wrote the whole file (the AI-path config): record its new hash. */ rewrite?: true; /** The backup this change restored: the file is the person's again, so its entry and backup go. */ restored?: string }
  | { kind: 'delete'; rel: string; before: string };

/** True when `rel`, or any folder on the way to it, is a symlink. */
export function linkedPath(root: string, rel: string, fs: Pick<typeof nodeFs, 'lstatSync'> = nodeFs): boolean {
  let p = root;
  for (const part of rel.split('/')) {
    p = join(p, part);
    if (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) return true;
  }
  return false;
}

/** The one refusal for a link: apply never writes through one, and the plan never reads through one (dry runs too). */
export function refuseSymlink(root: string, rel: string, fs: Pick<typeof nodeFs, 'lstatSync'> = nodeFs): void {
  if (linkedPath(root, rel, fs)) throw new ApplyError(`refusing symlink: ${rel}`);
}

export type FsLike = Pick<
  typeof nodeFs,
  'readFileSync' | 'writeFileSync' | 'renameSync' | 'unlinkSync' | 'mkdirSync' | 'rmSync' | 'lstatSync' | 'existsSync' | 'copyFileSync' | 'chmodSync' | 'rmdirSync'
>;

export class ApplyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApplyError';
  }
}

const TMP = '.harness-tmp';
// A literal, not REPO_STATE.lock: manifest.ts imports this file, so REPO_STATE may not exist yet at load. A test pins it equal.
export const LOCK_REL = '.harness/apply.lock';
/** What the person does about a lock left by an interrupted run or a rollback that failed. */
export const LOCK_RECOVERY = 'A previous harness run was interrupted or could not roll back, so the files and `.harness/manifest.json` may disagree. To recover: 1) run `git status` to see what it changed, 2) undo that with `git checkout -- <file>` and `git clean -f <file>` (restore any file named in the earlier rollback message from `.harness/backup/`), 3) delete `.harness/apply.lock`, 4) run the command again.';

export function applyChanges(
  root: string,
  changes: Change[],
  version: string,
  now: () => Date = () => new Date(),
  fs: FsLike = nodeFs,
  /** `manifest`: write this instead of the computed one, as the transaction's last step (rolled back with the files). */
  /** `manifestBefore`: the manifest text the plan was built from (`rawOf`); the apply stops if the disk no longer holds it. */
  opts: { writeManifest?: boolean; manifest?: Manifest; tddOff?: string[]; manifestBefore?: string; /** Where the manifest, backups and lock live (default: the repo's `.harness`). */ state?: StatePaths } = {},
): Manifest {
  const sp = opts.state ?? REPO_STATE;
  const LOCK = sp.lock;
  const abs = (rel: string) => join(root, ...rel.split('/'));
  // A kill mid-apply leaves written files the manifest never recorded; the journal below tells the next run.
  if (fs.existsSync(abs(LOCK)))
    throw new ApplyError(LOCK_RECOVERY);
  const createdAt = now().toISOString();
  const backupRel = `${sp.backup}/${createdAt.replace(/:/g, '-')}`;
  const writeManifest = opts.manifest !== undefined || (opts.writeManifest ?? true);

  // Validate everything before touching the disk.
  const checkPath = (rel: string) => {
    const r = relative(resolve(root), resolve(root, rel));
    if (isAbsolute(rel) || r === '' || r === '..' || r.startsWith('..' + sep) || isAbsolute(r))
      throw new ApplyError(`refusing path outside the repo: ${rel}`);
    refuseSymlink(root, rel, fs);
  };
  for (const c of changes) {
    const base = c.rel.split('/').pop()!;
    if (base === '.env' || base.startsWith('.env.')) throw new ApplyError(`Harness never writes \`${c.rel}\`. Remove it from the plan.`);
    checkPath(c.rel);
    checkPath(`${backupRel}/${c.rel}`);
    if (c.kind === 'create' && fs.existsSync(abs(c.rel)))
      throw new ApplyError(`\`${c.rel}\` already exists. Run the command again.`);
    if (c.kind === 'create') continue;
    let current: string;
    try {
      current = fs.readFileSync(abs(c.rel), 'utf8');
    } catch (cause) {
      throw new ApplyError(`Could not read \`${c.rel}\`. Check it exists and is readable, then run the command again.`, { cause });
    }
    if (current !== c.before)
      throw new ApplyError(`\`${c.rel}\` changed since the plan was made. Run the command again.`);
  }
  if (writeManifest) {
    checkPath(sp.manifest);
    // Another command may have rewritten the manifest since this one read it (no file change of ours would show it).
    const seen = opts.manifestBefore;
    let now: string | null = null;
    try { now = fs.readFileSync(abs(sp.manifest), 'utf8'); } catch { /* missing */ }
    if (seen !== undefined && now !== seen) throw new ApplyError('Another harness command changed the install while this one ran. Run it again.');
  }

  const manifest: Manifest = {
    version,
    createdAt,
    ...(opts.tddOff?.length ? { tddOff: opts.tddOff } : {}),
    files: changes.map((c) => ({
      rel: c.rel,
      kind: c.kind,
      hash: hashText(c.kind === 'delete' ? c.before : c.kind === 'create' ? c.content : c.after),
      ...(c.kind !== 'delete' && c.item ? { item: c.item } : {}),
      ...(c.kind === 'update' ? { blocks: c.blocks } : c.kind === 'create' && c.blocks?.length ? { blocks: c.blocks } : {}),
      ...(c.kind === 'update' ? { ...(c.replace?.length ? { replace: c.replace } : {}), ...(c.formatted ? { formatted: c.formatted } : {}), ...(c.unformatted ? { unformatted: c.unformatted } : {}) } : {}),
    })),
  };

  // Steps = everything that gets written, the manifest last.
  type Step = { rel: string; content: string | null; mode?: number };
  const steps: Step[] = changes.map((c) =>
    c.kind === 'delete' ? { rel: c.rel, content: null } : c.kind === 'create' ? { rel: c.rel, content: c.content, mode: c.mode } : { rel: c.rel, content: c.after },
  );
  if (writeManifest) steps.push({ rel: sp.manifest, content: JSON.stringify(opts.manifest ?? manifest, null, 2) + '\n' });

  const modes = new Map<string, number>(); // rel -> original mode
  const madeDirs: string[] = []; // dirs this apply created, shallowest first
  const backedUp = new Map<string, string>(); // rel -> backup path (absolute)
  const touched: string[] = []; // rels whose target may differ from the original
  const mkParent = (p: string) => {
    const missing: string[] = [];
    for (let d = dirname(p); !fs.existsSync(d); d = dirname(d)) missing.unshift(d);
    fs.mkdirSync(dirname(p), { recursive: true });
    madeDirs.push(...missing);
  };
  try {
    for (const s of steps) {
      if (!fs.existsSync(abs(s.rel))) continue;
      const b = abs(`${backupRel}/${s.rel}`);
      mkParent(b);
      fs.copyFileSync(abs(s.rel), b);
      backedUp.set(s.rel, b);
      modes.set(s.rel, fs.lstatSync(abs(s.rel)).mode & 0o777);
      const f = manifest.files.find((x) => x.rel === s.rel);
      if (f) f.backup = `${backupRel}/${s.rel}`;
    }
    // The manifest content was serialised before backup paths were known; rebuild it.
    if (writeManifest && !opts.manifest) steps[steps.length - 1].content = JSON.stringify(manifest, null, 2) + '\n';
    mkParent(abs(LOCK));
    fs.writeFileSync(abs(LOCK), steps.map((s) => s.rel).join('\n') + '\n');
    for (const s of steps) {
      const target = abs(s.rel);
      // Pushed once the step is done: an unlink or rename is atomic, so a step that threw left its target as it was.
      if (s.content === null) {
        fs.unlinkSync(target);
        touched.push(s.rel);
        continue;
      }
      mkParent(target);
      fs.writeFileSync(target + TMP, s.content);
      const mode = s.mode ?? modes.get(s.rel);
      if (mode !== undefined && process.platform !== 'win32') fs.chmodSync(target + TMP, mode);
      renameWithRetry(target + TMP, target, (a, b) => fs.renameSync(a, b));
      touched.push(s.rel);
    }
    fs.rmSync(abs(LOCK), { force: true });
  } catch (cause) {
    const failed: string[] = [];
    for (const rel of touched.reverse()) {
      try {
        const b = backedUp.get(rel);
        if (b) {
          // temp + rename so a read-only target does not block the restore
          fs.copyFileSync(b, abs(rel) + TMP);
          if (process.platform !== 'win32') fs.chmodSync(abs(rel) + TMP, modes.get(rel)!);
          renameWithRetry(abs(rel) + TMP, abs(rel), (a, b) => fs.renameSync(a, b));
        } else fs.rmSync(abs(rel), { force: true });
      } catch {
        failed.push(rel);
      }
    }
    const restoreFailed = failed.length > 0;
    for (const s of steps) fs.rmSync(abs(s.rel) + TMP, { force: true });
    if (!restoreFailed) fs.rmSync(abs(LOCK), { force: true }); // files and manifest may disagree: the next run refuses until the person recovers
    if (!restoreFailed) fs.rmSync(abs(backupRel), { recursive: true, force: true });
    for (const d of madeDirs.reverse()) {
      try {
        fs.rmdirSync(d); // throws if not empty, which is what we want
      } catch {}
    }
    const why = cause instanceof Error ? cause.message : String(cause);
    if (restoreFailed) {
      const notes = failed.map((r) =>
        backedUp.has(r)
          ? `Rollback failed for \`${r}\`; its original is in \`${backupRel}/${r}\`. Restore it by hand.`
          : `Rollback failed for \`${r}\`; it was created by this run. Delete it by hand.`,
      );
      throw new ApplyError(`${notes.join(' ')} Cause: ${why}`, { cause });
    }
    throw new ApplyError(`apply failed and was rolled back: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  return manifest;
}

/** Removes the directories the deletes left empty, never above the repo root and never a non-empty one. */
export function removeEmptyDirs(root: string, changes: Change[]): void {
  for (const c of changes) {
    if (c.kind !== 'delete') continue;
    try {
      for (let d = dirname(join(root, c.rel)); resolve(d) !== resolve(root); d = dirname(d)) nodeFs.rmdirSync(d);
    } catch {} // rmdir refuses a non-empty directory
  }
}
