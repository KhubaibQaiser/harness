import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HarnessEvent {
  ts: string;
  session: string;
  check: string;
  decision: string;
  reason?: string;
  files?: string[];
  co?: true; // denied alongside an earlier deny on the same call
  of?: string; // reason-found-late: the ts of the allow-log event it completes
}

const file = (root: string) => join(root, '.harness/logs/events.jsonl');

export function appendEvent(root: string, e: HarnessEvent): void {
  mkdirSync(join(root, '.harness/logs'), { recursive: true });
  appendFileSync(file(root), JSON.stringify(e) + '\n');
}

export function readEvents(root: string): HarnessEvent[] {
  if (!existsSync(file(root))) return [];
  const out: HarnessEvent[] = [];
  for (const line of readFileSync(file(root), 'utf8').split('\n')) {
    try {
      if (line.trim()) out.push(JSON.parse(line) as HarnessEvent);
    } catch {
      // skip malformed line
    }
  }
  return out;
}
