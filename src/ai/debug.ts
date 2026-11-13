import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../core/atomic.js';

/** Keeps a twice-failed recommend output for the user. Outside .harness/state/, so no deny rule blocks the CLI; the agent never writes here. */
export function saveDebug(root: string, kind: 'picks' | 'report' | 'vet-review' | 'pr-review' | 'pr-judge', raw: string, now: () => Date = () => new Date()): string {
  const rel = `.harness/debug/${kind}-${now().toISOString().replace(/:/g, '-')}.txt`;
  mkdirSync(join(root, '.harness/debug'), { recursive: true });
  writeAtomic(join(root, rel), raw);
  return rel;
}
