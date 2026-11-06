import { emit, shown } from './io.js';
import type { Decision } from './types.js';

const unique = (xs: string[]): string[] => [...new Set(xs)];

/** Output for the context decisions (and the winning deny/block/ask, if any) of one hook run. */
export function mergeContext(event: string, decisions: Decision[], win: Decision | undefined): string {
  const ctx = decisions.flatMap((d) => (d.kind === 'context' ? [d] : []));
  const text = unique(ctx.map((d) => d.text)).join('\n');
  const notice = unique(ctx.flatMap((d) => (d.notice ? [d.notice] : []))).join('\n');
  if (!win) return ctx.length ? emit(event, { kind: 'context', text, notice: notice || undefined, check: 'context' }) : '';
  const out = emit(event, win);
  // a Stop warning survives a Stop-gate block, as a systemMessage only (spec 14.3)
  return event === 'Stop' && ctx.length ? JSON.stringify({ ...JSON.parse(out), systemMessage: shown(text) }) : out;
}
