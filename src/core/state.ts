import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionState {
  startedAt: number;
  files: string[];
  approved: boolean;
  redTests: string[];
  lockedTests: string[];
  stopAttempts: number;
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
  writeState(root, session, { ...readState(root, session), files: [], approved: false });
}

// Serialises read-modify-write of a session's state across hook processes via an exclusive lock directory.
// Waits up to 2 s (10 ms steps); a lock older than 5 s is stale. On timeout runs fn unlocked.
export async function withSessionLock<T>(root: string, session: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = `${statePath(root, session).slice(0, -'.json'.length)}.lock`;
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
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          usable = false;
          break;
        }
        try {
          if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true });
          else if (Date.now() >= deadline) break;
          else await new Promise((r) => setTimeout(r, 10));
        } catch {
          // lock vanished between checks: retry
        }
      }
    }
    if (usable && !held) process.stderr.write('harness: state lock timeout\n');
    return await fn();
  } finally {
    if (held) rmSync(lock, { recursive: true, force: true });
  }
}
