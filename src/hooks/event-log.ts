import { appendEvent } from '../core/events.js';

export type Log = (check: string, decision: string, reason?: string, co?: true) => void;

export const warn = (what: string, e: unknown) => process.stderr.write(`harness: ${what} failed: ${String((e as Error)?.message ?? e)}\n`);

/** Appends one decision to the repo's event log; a failed write only warns. */
export const eventLog = (root: string, session: string): Log => (check, decision, reason, co) => {
  try {
    appendEvent(root, { ts: new Date().toISOString(), session, check, decision, ...(reason ? { reason } : {}), ...(co ? { co } : {}) });
  } catch (e) {
    warn('event log', e);
  }
};
