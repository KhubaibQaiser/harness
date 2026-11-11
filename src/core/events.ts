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
  use?: string; // the hook input's tool_use_id
  ms?: number; // dispatcher module start to the decision (no Node startup, before the stdout write); for the stop gate, one step's run time
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

/** The last time change detection saw harness's own files change during a session, if ever. */
export function lastHarnessFilesChange(root: string): { ts: string; files: string[] } | null {
  try {
    const e = readEvents(root).filter((x) => x.decision === 'harness-files-changed').pop();
    return e ? { ts: e.ts, files: (e.reason ?? '').split(', ').filter(Boolean) } : null;
  } catch {
    return null;
  }
}

/** The last ConfigChange harness blocked, if ever. */
export function lastConfigChangeBlocked(root: string): { ts: string; reason: string } | null {
  try {
    const e = readEvents(root).filter((x) => x.decision === 'config-change-blocked').pop();
    return e ? { ts: e.ts, reason: e.reason ?? '' } : null;
  } catch {
    return null;
  }
}
