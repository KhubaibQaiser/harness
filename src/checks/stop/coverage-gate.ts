import { appendEvent } from '../../core/events.js';
import type { Ctx } from '../../hooks/dispatch.js';
import type { Decision } from '../../hooks/types.js';
import { diffCoverage, formatLines } from './diff-coverage.js';
import type { Exec } from './gate.js';

const MAX_FILES = 10;
const MAX_LINES = 20;

// `since` is the epoch-ms start of the gate's steps (coverage older than that is stale).
export function coverageGate(ctx: Ctx, exec: Exec, since: number): Decision {
  const { root, config, input, state } = ctx;
  const log = (decision: string, reason: string) => {
    try {
      appendEvent(root, { ts: new Date().toISOString(), session: input.session_id, check: 'stop', decision, reason });
    } catch {
      // event log is best effort
    }
  };
  const r = diffCoverage(root, config, exec, { baseHead: state.baseHead, since: since / 1000 });
  if (r.problem === 'no-base') {
    log('coverage-skipped', 'no base'); // nothing to measure against
    return { kind: 'allow' };
  }
  if (r.problem === 'diff-failed') {
    log('coverage-diff-failed', r.detail ?? '');
    return { kind: 'block', check: 'stop', reason: `Diff coverage could not read git diff (${r.detail}). Fix git, then finish again.` };
  }
  if (r.problem === 'unparseable-coverage')
    return { kind: 'block', check: 'stop', reason: `Coverage output at ${config.stop.coverage_globs.join(', ')} could not be parsed.` };
  if (r.problem === 'no-fresh-coverage')
    return { kind: 'block', check: 'stop', reason: `Diff coverage needs fresh coverage output (${config.stop.coverage_globs.join(', ')}). Make the test step write coverage, then finish again.` };
  const need = config.tdd.diff_coverage;
  if (r.pct >= need) return { kind: 'allow' };
  const files = r.uncovered.slice(0, MAX_FILES).map((u) => `${u.file}:${formatLines(u.lines.slice(0, MAX_LINES))}${u.lines.length > MAX_LINES ? ',…' : ''}`);
  const more = r.uncovered.length - MAX_FILES;
  return { kind: 'block', check: 'stop', reason: `Diff coverage ${Math.floor(r.pct)}% is below ${need}%. Uncovered: ${files.join(', ')}${more > 0 ? ` (+${more} more files)` : ''}` };
}
