import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// .harness/state/tdd-pause.json: { createdAt: ISO string, session?: string }. Task 16 adds writing, binding and clearing.
export function pauseStatus(root: string): 'off' | 'pending' | { session: string } {
  try {
    const v: unknown = JSON.parse(readFileSync(join(root, '.harness/state/tdd-pause.json'), 'utf8'));
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
