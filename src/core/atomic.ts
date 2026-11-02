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
