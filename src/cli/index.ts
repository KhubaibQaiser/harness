import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { appendEvent, readEvents } from '../core/events.js';
import { repoRoot } from '../core/repo-root.js';
import { pauseStatus, pauseTdd, resumeTdd } from '../core/pause.js';

export interface CliEnv {
  root: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
}

const USAGE = 'Usage: harness tdd off|on|status\n       harness stats [--days N]';
const DAY = 86_400_000;

function tddStatus(root: string): string {
  const s = pauseStatus(root);
  return s === 'off' ? 'TDD gate: on' : s === 'pending' ? 'TDD gate: paused (waiting for next session)' : `TDD gate: paused for session ${s.session}`;
}

const log = (root: string, decision: string) => appendEvent(root, { ts: new Date().toISOString(), session: 'cli', check: 'tdd', decision });

function tdd(sub: string | undefined, { root, env, out }: CliEnv): number {
  if (sub === 'status') return out(tddStatus(root)), 0;
  if (sub === 'on') return resumeTdd(root), log(root, 'resumed'), out(tddStatus(root)), 0;
  if (sub !== 'off') return out(USAGE), 2;
  if (env.CLAUDECODE) {
    log(root, 'refused');
    out('Run harness tdd off from a plain terminal, not inside Claude Code.');
    return 1;
  }
  if (!pauseTdd(root)) return out(tddStatus(root)), 0;
  log(root, 'paused');
  out('TDD layers 2–4 paused for your next Claude Code session. Stop gate and CI still apply.');
  return 0;
}

function stats(args: string[], { root, out }: CliEnv): number {
  let days = 7;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--days' || !/^[1-9]\d*$/.test(args[1] as string)) return out(USAGE), 2;
    days = Number(args[1]);
  }
  const since = Date.now() - days * DAY;
  const events = readEvents(root).filter((e) => e && typeof e.check === 'string' && typeof e.decision === 'string' && Date.parse(e.ts) >= since);
  if (!events.length) return out(`No harness events in the last ${days} days.`), 0;

  const tally = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const section = (title: string, rows: [string, number][]) => out(`${title}\n${rows.map(([k, n]) => `  ${k}: ${n}`).join('\n')}`);
  const count = (f: (e: (typeof events)[number]) => boolean) => events.filter(f).length;

  section('Events by check and decision', [...tally(events.map((e) => `${e.check} ${e.decision}`))].sort());
  section('Overrides', [
    ['tdd paused', count((e) => e.check === 'tdd' && e.decision === 'paused')],
    ['multi-file approvals', count((e) => e.check === 'multi-file' && e.decision.startsWith('allow'))],
    ['allow-log', count((e) => e.decision === 'allow-log')],
  ]);
  const steps = events.filter((e) => e.check === 'stop' && e.decision === 'block').map((e) => {
    const r = e.reason ?? '';
    return r.startsWith('Diff coverage') ? 'coverage' : r.includes(' failed (attempt') ? r.slice(0, r.indexOf(' failed (attempt')) : 'other';
  });
  if (steps.length) section('Stop failures by step', [...tally(steps)]);
  const stop = (d: string) => count((e) => e.check === 'stop' && e.decision === d);
  section('Gave up and timeouts', [
    ['timeouts', stop('context')],
    ...['stop-gave-up', 'stop-skipped', 'stop-diff-failed', 'coverage-skipped', 'coverage-diff-failed'].map((d): [string, number] => [d, stop(d)]),
  ]);
  return 0;
}

export function run(argv: string[], cli: CliEnv): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'tdd' && rest.length === 1) return tdd(rest[0], cli);
  if (cmd === 'stats') return stats(rest, cli);
  cli.out(USAGE);
  return 2;
}

// Run only as the process entry (also true for the bundled dist file), so tests can import `run`.
const entry = process.argv[1];
try {
  if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href)
    process.exitCode = run(process.argv.slice(2), { root: repoRoot(process.cwd()), env: process.env, out: (s) => console.log(s) });
} catch (e) {
  console.error(`harness: ${(e as Error).message}`);
  process.exitCode = 1;
}
