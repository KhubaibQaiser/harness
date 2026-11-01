import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  baseHead?: string; // git HEAD at the session's first hook
}

export const isSafeSessionId = (id: string): boolean => /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';

export function statePath(root: string, session: string): string {
  if (!isSafeSessionId(session)) throw new Error(`unsafe session id: ${session}`);
  return join(root, '.harness/state', `${session}.json`);
}

export function readState(root: string, session: string): SessionState {
  const fresh: SessionState = { startedAt: Date.now(), files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 };
  const f = statePath(root, session);
  if (!existsSync(f)) return fresh;
  try {
    const v: unknown = JSON.parse(readFileSync(f, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...fresh, ...(v as Partial<SessionState>) } : fresh;
  } catch {
    return fresh;
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
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, f);
}

export function clearTurn(root: string, session: string): void {
  writeState(root, session, { ...readState(root, session), files: [], approved: false, reasonDenied: [] });
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

// Serialises read-modify-write of a session's state across hook processes via an exclusive, owner-tagged lock directory.
// Waits up to 2 s (10 ms steps), then runs fn unlocked with a warning. Stop events skip the lock (long-running, only touch stopAttempts).
export async function withSessionLock<T>(root: string, session: string, fn: () => T | Promise<T>): Promise<T> {
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
        mkdirSync(lock);
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
          if (isStale(lock)) {
            const gone = `${lock}.stale.${nonce}`;
            renameSync(lock, gone); // only the waiter whose rename succeeds proceeds
            rmSync(gone, { recursive: true, force: true });
          } else if (Date.now() >= deadline) break;
          else await new Promise((r) => setTimeout(r, 10));
        } catch {
          // lock vanished or another waiter won the rename: retry
        }
      }
    }
    if (usable && !held) process.stderr.write('harness: state lock timeout\n');
    return await fn();
  } finally {
    if (held && readOwner(lock)?.nonce === nonce) rmSync(lock, { recursive: true, force: true });
  }
}
