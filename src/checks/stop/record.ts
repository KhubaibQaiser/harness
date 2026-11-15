// The "checks never ran" record: what the last wrapped Stop run reported, for doctor and the status line.
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../../core/atomic.js';
import { real, realish } from '../../core/paths.js';
import { warn } from '../../hooks/event-log.js';
import type { CheckName } from './steps.js';

export const STOP_SANDBOX_REL = '.harness/state/stop-sandbox.json';
const MAX_BYTES = 64 * 1024;
const OUTCOMES = ['ran', 'unavailable', 'never-ran'];
const NAMES: string[] = ['write canary', 'read canary', 'unix socket', 'network', 'user namespace'] satisfies CheckName[];
export type StopSandboxRecord = { ts: string; srt: string | null; outcome: 'ran' | 'unavailable' | 'never-ran'; checks: Partial<Record<CheckName, string>>; reason?: string };

/** Never writes a ledger row and is never evidence of a pass (R11): nothing may read it as one. Null on any problem. */
export function readStopRecord(root: string): StopSandboxRecord | null {
  try {
    const f = join(root, STOP_SANDBOX_REL);
    const st = lstatSync(f);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const o = JSON.parse(readFileSync(f, 'utf8'));
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.ts !== 'string' || !(o.srt === null || typeof o.srt === 'string') || !OUTCOMES.includes(o.outcome)) return null;
    if (o.reason !== undefined && typeof o.reason !== 'string') return null;
    const c = o.checks;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.entries(c).some(([k, v]) => !NAMES.includes(k) || typeof v !== 'string')) return null;
    return o as StopSandboxRecord;
  } catch {
    return null;
  }
}

/** Best effort: a failure is a warning and never changes a decision. Never writes through a symlinked state folder. */
export function writeStopRecord(root: string, r: StopSandboxRecord): void {
  try {
    const dir = join(realish(root), '.harness/state');
    mkdirSync(dir, { recursive: true });
    if (!lstatSync(dir).isDirectory() || real(dir) !== dir) {
      warn('stop record', new Error('state folder is not a real directory'));
      return;
    }
    writeAtomic(join(root, STOP_SANDBOX_REL), JSON.stringify(r));
  } catch (e) {
    warn('stop record', e);
  }
}
