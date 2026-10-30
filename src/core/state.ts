import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

function file(root: string, session: string): string {
  if (!isSafeSessionId(session)) throw new Error(`unsafe session id: ${session}`);
  return join(root, '.harness/state', `${session}.json`);
}

export function readState(root: string, session: string): SessionState {
  const fresh: SessionState = { startedAt: Date.now(), files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 };
  const f = file(root, session);
  if (!existsSync(f)) return fresh;
  try {
    const v: unknown = JSON.parse(readFileSync(f, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...fresh, ...(v as Partial<SessionState>) } : fresh;
  } catch {
    return fresh;
  }
}

export function writeState(root: string, session: string, s: SessionState): void {
  const f = file(root, session);
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, f);
}

export function clearTurn(root: string, session: string): void {
  writeState(root, session, { ...readState(root, session), files: [], approved: false });
}
