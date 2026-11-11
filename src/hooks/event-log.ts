import { appendEvent } from '../core/events.js';

export type Log = (check: string, decision: string, reason?: string, co?: true) => void;

export const warn = (what: string, e: unknown) => process.stderr.write(`harness: ${what} failed: ${String((e as Error)?.message ?? e)}\n`);

/** Appends one decision to the repo's event log; a failed write only warns. `use` is the hook input's tool_use_id, kept only when a string. */
export const eventLog = (root: string, session: string, use?: unknown, start?: number): Log => (check, decision, reason, co) => {
  try {
    appendEvent(root, { ts: new Date().toISOString(), session, check, decision, ...(reason ? { reason } : {}), ...(co ? { co } : {}), ...(typeof use === 'string' ? { use } : {}), ...(start === undefined ? {} : { ms: Date.now() - start }) });
  } catch (e) {
    warn('event log', e);
  }
};
