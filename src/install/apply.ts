import * as nodeFs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MANIFEST_REL, ManifestError, readManifest, type Manifest } from './manifest.js';
import type { Hunk } from './diff.js';
import { hashText } from './text.js';
import { renameWithRetry } from '../core/atomic.js';

export { readManifest, ManifestError, type Manifest };

export type Change =
  | { kind: 'create'; rel: string; content: string; mode?: number; blocks?: string[] }
  | { kind: 'update'; rel: string; before: string; after: string; blocks: string[]; replace?: Hunk[]; formatted?: true; unformatted?: true }
  | { kind: 'delete'; rel: string; before: string };

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

export function applyChanges(
  root: string,
  changes: Change[],
  version: string,
  now: () => Date = () => new Date(),
  fs: FsLike = nodeFs,
  /** `manifest`: write this instead of the computed one, as the transaction's last step (rolled back with the files). */
  opts: { writeManifest?: boolean; manifest?: Manifest; tddOff?: string[] } = {},
): Manifest {
  const abs = (rel: string) => join(root, ...rel.split('/'));
  const createdAt = now().toISOString();
  const backupRel = `.harness/backup/${createdAt.replace(/:/g, '-')}`;
  const writeManifest = opts.manifest !== undefined || (opts.writeManifest ?? true);

  // Validate everything before touching the disk.
  const checkPath = (rel: string) => {
    const r = relative(resolve(root), resolve(root, rel));
    if (isAbsolute(rel) || r === '' || r === '..' || r.startsWith('..' + sep) || isAbsolute(r))
      throw new ApplyError(`refusing path outside the repo: ${rel}`);
    let p = root;
    for (const part of rel.split('/')) {
      p = join(p, part);
      if (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ApplyError(`refusing symlink: ${rel}`);
    }
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
  if (writeManifest) checkPath(MANIFEST_REL);

  const manifest: Manifest = {
    version,
    createdAt,
    ...(opts.tddOff?.length ? { tddOff: opts.tddOff } : {}),
    files: changes.map((c) => ({
      rel: c.rel,
      kind: c.kind,
      hash: hashText(c.kind === 'delete' ? c.before : c.kind === 'create' ? c.content : c.after),
      ...(c.kind === 'update' ? { blocks: c.blocks } : c.kind === 'create' && c.blocks?.length ? { blocks: c.blocks } : {}),
      ...(c.kind === 'update' ? { ...(c.replace?.length ? { replace: c.replace } : {}), ...(c.formatted ? { formatted: c.formatted } : {}), ...(c.unformatted ? { unformatted: c.unformatted } : {}) } : {}),
    })),
  };

  // Steps = everything that gets written, the manifest last.
  type Step = { rel: string; content: string | null; mode?: number };
  const steps: Step[] = changes.map((c) =>
    c.kind === 'delete' ? { rel: c.rel, content: null } : c.kind === 'create' ? { rel: c.rel, content: c.content, mode: c.mode } : { rel: c.rel, content: c.after },
  );
  if (writeManifest) steps.push({ rel: MANIFEST_REL, content: JSON.stringify(opts.manifest ?? manifest, null, 2) + '\n' });

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
    for (const s of steps) {
      const target = abs(s.rel);
      touched.push(s.rel);
      if (s.content === null) {
        fs.unlinkSync(target);
        continue;
      }
      mkParent(target);
      fs.writeFileSync(target + TMP, s.content);
      const mode = s.mode ?? modes.get(s.rel);
      if (mode !== undefined && process.platform !== 'win32') fs.chmodSync(target + TMP, mode);
      renameWithRetry(target + TMP, target, (a, b) => fs.renameSync(a, b));
    }
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
