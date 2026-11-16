import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';

// Windows refuses a rename onto (or a read of) a file another process has open, or a scanner holds, for a moment:
// EPERM, EACCES or EBUSY. On Windows those are retried with a short, growing, bounded backoff (5 ms doubling to
// 250 ms, 15 tries, about 2.3 s at most). Elsewhere they are real errors and thrown at once. When retries run out,
// the last error is thrown, so the caller reports it as before: a write is never lost silently.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const TRIES = 15;
const sleepSync = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Test seams: the platform the retry rule follows, and how it waits. */
export const RETRY: { platform: NodeJS.Platform; sleep: (ms: number) => void } = { platform: process.platform, sleep: sleepSync };

// One wait budget per process: a hook is one process, and the retries of all its reads and writes together stay
// well under the 10 s hook timeout (a timed-out hook fails open).
const BUDGET_MS = 3000;
let budget = BUDGET_MS;
/** Test seam: start a fresh budget (of `ms`). */
export const resetRetryBudget = (ms = BUDGET_MS): void => void (budget = ms);
export const isTransient = (e: unknown): boolean => TRANSIENT.has((e as NodeJS.ErrnoException)?.code ?? '');

export function retryTransient<T>(fn: () => T): T {
  for (let i = 0, wait = 5; ; i++, wait = Math.min(wait * 2, 250)) {
    try {
      return fn();
    } catch (e) {
      if (RETRY.platform !== 'win32' || i >= TRIES - 1 || !isTransient(e) || budget <= 0) throw e;
      const ms = Math.min(wait, budget);
      budget -= ms;
      RETRY.sleep(ms);
    }
  }
}

export function renameWithRetry(from: string, to: string, rename: (a: string, b: string) => void = nodeFs.renameSync): void {
  retryTransient(() => rename(from, to));
}

type WriteFs = Pick<typeof nodeFs, 'writeFileSync' | 'renameSync' | 'rmSync'>;
/** Writes `data` to `path` through a unique temp file and a rename, so readers see the old or the new text, never part. */
export function writeAtomic(path: string, data: string, fs: WriteFs = nodeFs): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data); // inside the try: a part-written temp file is removed too
    renameWithRetry(tmp, path, (a, b) => fs.renameSync(a, b));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// ponytail: a link swapped in between this check and the open that follows is a bounded race. O_NOFOLLOW covers only the last path part. The file names are fixed harness names (events.jsonl, timing.jsonl, evidence.jsonl), so the race can only aim a write for one of those names at a planted link's target, in a window of microseconds.
/** Makes `rel` (e.g. `.harness/logs`) under `root` if missing, and throws when it or any folder above it inside `root` is a symlink: a planted link must never send a harness write or delete onto someone else's files. Returns the absolute path. */
export function ensureRealDir(root: string, rel: string): string {
  let p = root;
  for (const part of rel.split('/').filter(Boolean)) {
    p = `${p}/${part}`;
    const look = () => { try { return nodeFs.lstatSync(p); } catch { return undefined; } };
    let st = look();
    if (!st) {
      try { nodeFs.mkdirSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } // a concurrent create is fine
      st = look(); // checked again: it may be a planted link now
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${p} is a symlink or not a folder; harness does not write through it.`);
  }
  return p;
}

/** Test seam: O_NOFOLLOW, which Node leaves undefined on Windows. */
export const NOFOLLOW: { flag: number | undefined } = { flag: nodeFs.constants.O_NOFOLLOW };

const refuse = (path: string) => new Error(`${path} is a link or not a plain file; harness does not write through it.`);

// Without O_NOFOLLOW: lstat the name, open it, and refuse unless the opened handle is that same plain file.
// A link swapped in between is opened but closed before any byte is written.
function openChecked(path: string, flags: number): number {
  const { O_CREAT, O_EXCL } = nodeFs.constants;
  const look = () => { try { return nodeFs.lstatSync(path, { bigint: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } };
  let before = look();
  if (!before) {
    try { return nodeFs.openSync(path, flags | O_CREAT | O_EXCL); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    before = look(); // made by someone else meanwhile: check what is there now
  }
  if (!before || before.isSymbolicLink() || !before.isFile()) throw refuse(path);
  const fd = nodeFs.openSync(path, flags);
  const after = nodeFs.fstatSync(fd, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile()) {
    nodeFs.closeSync(fd);
    throw refuse(path);
  }
  return fd;
}

/** Appends `data` to `path`, creating it if missing, and throws instead of writing through a symlink or hard link at the file. */
export function appendNoFollow(path: string, data: string, write: (fd: number, d: string) => void = nodeFs.appendFileSync): void {
  const { O_WRONLY, O_APPEND, O_CREAT } = nodeFs.constants;
  const fd = NOFOLLOW.flag === undefined ? openChecked(path, O_WRONLY | O_APPEND) : nodeFs.openSync(path, O_WRONLY | O_APPEND | O_CREAT | NOFOLLOW.flag);
  try {
    const st = nodeFs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw refuse(path); // a hard link would append into another file the person owns
    write(fd, data);
  } finally {
    nodeFs.closeSync(fd);
  }
}
