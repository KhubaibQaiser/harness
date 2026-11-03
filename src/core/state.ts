import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { renameWithRetry, retryTransient, writeAtomic } from './atomic.js';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface SessionState {
  startedAt: number;
  files: string[];
  approved: boolean;
  reasonDenied?: string[]; // files already denied for a missing reason this turn
  redTests: string[];
  lockedTests: string[];
  stopAttempts: number;
  stopNoGitLogged?: boolean; // stop-no-git already logged this session
  stopNothingLogged?: boolean; // stop-nothing-to-run already logged this session
  sandboxUnavailableLogged?: true; // sandbox-unavailable already logged this session
  lateReasons?: { ts: string; rel: string }[]; // allow-logs with "no reason given", looked up again at the next Stop or prompt
  stopToolMissing?: string[]; // Stop steps whose missing tool was already logged and warned about this session
  baseHead?: string; // git HEAD at the session's first hook
  harnessFiles?: Record<string, string>; // sha-256 of harness's own files: the session's change-detection snapshot
  harnessHead?: string; // HEAD when that snapshot was taken
  harnessNoticed?: string; // the change set already shown at a prompt (Stop still blocks once)
}

export const isSafeSessionId = (id: string): boolean => /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';

export function statePath(root: string, session: string): string {
  if (!isSafeSessionId(session)) throw new Error(`unsafe session id: ${session}`);
  return join(root, '.harness/state', `${session}.json`);
}


export function readState(root: string, session: string, read: (p: string, e: 'utf8') => string = readFileSync): SessionState {
  const fresh: SessionState = { startedAt: Date.now(), files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 };
  const f = statePath(root, session);
  let text: string;
  // Windows: a scanner or another process can hold the file for a moment. Retry, and never answer a read error
  // with a fresh state: the next write would then drop everything recorded so far.
  try {
    text = retryTransient(() => read(f, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return fresh; // no state yet
    throw e;
  }
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...fresh, ...(v as Partial<SessionState>) } : fresh;
  } catch {
    return fresh; // corrupt file: start over (it is rewritten on the first hook)
  }
}

// True when a usable (parseable object) state file exists.
export function stateExists(root: string, session: string): boolean {
  try {
    const v: unknown = JSON.parse(readFileSync(statePath(root, session), 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

export function writeState(root: string, session: string, s: SessionState): void {
  const f = statePath(root, session);
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  writeAtomic(f, JSON.stringify(s));
}

export { renameWithRetry }; // kept for existing importers

export function clearTurn(root: string, session: string): void {
  writeState(root, session, { ...readState(root, session), files: [], approved: false, reasonDenied: [], stopAttempts: 0 });
}

const readOwner = (lock: string): { pid?: number; nonce?: string } | null => {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner'), 'utf8'));
  } catch {
    return null;
  }
};

// Stale: the owner process is dead, or there is no readable owner file and the dir is older than 30 s.
function isStale(lock: string): boolean {
  const o = readOwner(lock);
  if (typeof o?.pid === 'number') {
    try {
      process.kill(o.pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  return Date.now() - statSync(lock).mtimeMs > 30000;
}

export type LockOps = {
  rename: (from: string, to: string) => void;
  rm: (p: string, o?: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }) => void;
  mkdir: (p: string, o?: { recursive?: boolean }) => unknown;
};
const REAL_OPS: LockOps = { rename: renameSync, rm: rmSync, mkdir: mkdirSync };
const BREAK_STALE_MS = 5000;

// Breaks a stale lock with breakers serialised by `<lock>.break`. The lock is judged again under the break lock: only a
// breaker or the lock's own (live) owner ever removes it, so a lock that was replaced since the first look (a new
// holder, maybe before its owner file exists) reads as live or young there and is left alone.
function breakStale(lock: string, nonce: string, ops: LockOps): void {
  const brk = `${lock}.break`;
  try {
    ops.mkdir(brk);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return;
    // A breaker died mid-break: clear its break lock (renamed first, so a newer one is never removed by name).
    if (Date.now() - statSync(brk).mtimeMs > BREAK_STALE_MS) {
      const old = `${brk}.stale.${nonce}`;
      ops.rename(brk, old);
      ops.rm(old, { recursive: true, force: true });
    }
    return;
  }
  try {
    if (!isStale(lock)) return;
    const gone = `${lock}.stale.${nonce}`;
    ops.rename(lock, gone);
    ops.rm(gone, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  } finally {
    ops.rm(brk, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }); // a leftover blocks breaking for 5 s
  }
}

// Serialises read-modify-write of a session's state across hook processes via an exclusive, owner-tagged lock directory.
// Waits up to 2 s (10 ms steps), then runs fn unlocked with a warning. Stop events skip the lock (long-running, only touch stopAttempts).
export async function withSessionLock<T>(root: string, session: string, fn: () => T | Promise<T>, ops: LockOps = REAL_OPS): Promise<T> {
  const lock = `${statePath(root, session).slice(0, -'.json'.length)}.lock`;
  const nonce = randomBytes(8).toString('hex');
  let held = false;
  let usable = true;
  try {
    try {
      mkdirSync(join(root, '.harness/state'), { recursive: true });
    } catch {
      usable = false; // unwritable state dir: run unlocked, the dispatcher's own write warnings cover it
    }
    for (const deadline = Date.now() + 2000; usable && !held; ) {
      try {
        ops.mkdir(lock);
        held = true;
        try {
          writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: process.pid, nonce }));
        } catch {
          // an owner-less lock still expires after 30 s
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          usable = false;
          break;
        }
        try {
          if (isStale(lock)) breakStale(lock, nonce, ops);
        } catch {
          // lock or break lock vanished meanwhile: look again
        }
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    if (usable && !held) process.stderr.write('harness: state lock timeout\n');
    return await fn();
  } finally {
    // Rename first, so the lock name is free at once; on Windows removing the dir fails while a waiter has `owner`
    // open, and a half-removed lock of a now-dead owner is what several waiters then break at the same time.
    if (held && readOwner(lock)?.nonce === nonce) {
      const freed = `${lock}.free.${nonce}`;
      let renamed = false;
      try {
        renameWithRetry(lock, freed, ops.rename);
        renamed = true;
      } catch {
        // could not rename: remove it in place (the name is still ours)
      }
      try {
        // After the rename the lock name may already be a new holder's: only ever remove the freed dir then.
        ops.rm(renamed ? freed : lock, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
      } catch {
        // a leftover .free.* dir is harmless; a leftover lock has a dead owner once this process exits (broken as stale)
      }
    }
  }
}
