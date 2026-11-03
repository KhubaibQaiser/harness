import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { writeAtomic } from './atomic.js';
import { join } from 'node:path';

// .harness/state/tdd-pause.json: { createdAt: ISO string, session?: string }
const pauseFile = (root: string) => join(root, '.harness/state/tdd-pause.json');
export function pauseStatus(root: string): 'off' | 'pending' | { session: string } {
  try {
    const v: unknown = JSON.parse(readFileSync(pauseFile(root), 'utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'off';
    const { createdAt, session } = v as { createdAt?: unknown; session?: unknown };
    if (typeof createdAt !== 'string') return 'off';
    return typeof session === 'string' && session ? { session } : 'pending';
  } catch {
    return 'off';
  }
}

export function isPaused(root: string, session: string): boolean {
  const s = pauseStatus(root);
  return typeof s === 'object' && s.session === session;
}

function writePause(root: string, v: { createdAt: string; session?: string }): void {
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  writeAtomic(pauseFile(root), JSON.stringify(v));
}

// Returns false (and keeps the file) when a pause already exists.
export function pauseTdd(root: string): boolean {
  if (pauseStatus(root) !== 'off') return false;
  writePause(root, { createdAt: new Date().toISOString() });
  return true;
}

export function resumeTdd(root: string): void {
  rmSync(pauseFile(root), { force: true });
}

// A pending pause binds only to a session that started at or after createdAt.
export function bindPause(root: string, session: string, startedAt: number): void {
  if (pauseStatus(root) !== 'pending') return;
  const { createdAt } = JSON.parse(readFileSync(pauseFile(root), 'utf8')) as { createdAt: string };
  if (startedAt >= Date.parse(createdAt)) writePause(root, { createdAt, session });
}

export function clearPause(root: string, session: string): void {
  if (isPaused(root, session)) resumeTdd(root);
}
