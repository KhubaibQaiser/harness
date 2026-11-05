// Timing log: one line per hook call, no paths, no command text. Best effort; it never changes a hook's decision.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface TimingLine {
  ts: string;
  session: string;
  event: string;
  tool?: string;
  step?: string;
  outcome: 'allow' | 'deny' | 'ask' | 'block' | 'context' | 'timeout';
  ms: number;
}

export const TIMING_REL = '.harness/logs/timing.jsonl';
export const TIMING_MAX_BYTES = 5 * 1024 * 1024;
const OLD_REL = '.harness/logs/timing.1.jsonl';

export type TimingFs = Pick<typeof import('node:fs'), 'appendFileSync' | 'mkdirSync' | 'renameSync' | 'statSync'>;
const realFs: TimingFs = { appendFileSync, mkdirSync, renameSync, statSync };

// Append-only; rotation is a rename (atomic, and a second hook losing the race just fails it), never read-modify-write.
export function appendTiming(root: string, t: TimingLine, fs: TimingFs = realFs): void {
  try {
    const { ts, session, event, tool, step, outcome, ms } = t; // whitelist: nothing else can reach the file
    const text = JSON.stringify({ ts, session, event, ...(tool ? { tool } : {}), ...(step ? { step } : {}), outcome, ms }) + '\n';
    const file = join(root, TIMING_REL);
    try {
      if (fs.statSync(file).size > TIMING_MAX_BYTES) fs.renameSync(file, join(root, OLD_REL));
    } catch {
      // no file yet, or another process rotated first: append to whatever is current
    }
    try {
      fs.appendFileSync(file, text);
    } catch {
      fs.mkdirSync(join(root, '.harness/logs'), { recursive: true });
      fs.appendFileSync(file, text);
    }
  } catch (e) {
    process.stderr.write(`harness: timing log failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

export function readTiming(root: string): TimingLine[] {
  const out: TimingLine[] = [];
  for (const rel of [OLD_REL, TIMING_REL]) {
    let text = '';
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    for (const l of text.split('\n')) {
      try {
        if (l.trim()) out.push(JSON.parse(l) as TimingLine);
      } catch {
        // skip malformed line
      }
    }
  }
  return out;
}
