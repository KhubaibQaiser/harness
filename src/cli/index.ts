import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendEvent, readEvents } from '../core/events.js';
import { repoRoot } from '../core/repo-root.js';
import { recordCliPath } from '../core/cli-path.js';
import { init } from './init.js';
import { uninstall } from './uninstall.js';
import { update } from './update.js';
import { readlinePrompt } from './prompt.js';
import { doctor } from './doctor.js';
import { status } from './status.js';
import { pauseStatus, pauseTdd, resumeTdd } from '../core/pause.js';

export interface CliEnv {
  /** False when stdin is not a terminal; undefined (tests) counts as interactive. */
  tty?: boolean;
  root: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
}

declare const __HARNESS_VERSION__: string; // injected by build.mjs; undefined when tests import the source
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0-dev';
const USAGE = 'Usage: harness tdd off|on|status\n       harness stats [--days N]\n       harness init [--yes] [--dry-run] [--config <file>]\n       harness uninstall [--yes] [--force] [--dry-run]\n       harness update [--yes] [--check] [--dry-run]\n       harness doctor\n       harness status';
const DAY = 86_400_000;

export function tddStatus(root: string): string {
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
    const self = process.argv[1] ? `node "${resolve(process.argv[1])}"` : 'npx @khubaibqaiser/harness';
    out(`Run harness tdd off from a plain terminal, not inside Claude Code: ${self} tdd off`);
    return 1;
  }
  if (!pauseTdd(root)) return out(tddStatus(root)), 0;
  log(root, 'paused');
  out('TDD layers 2–4 paused for your next Claude Code session. Stop gate and CI still apply.');
  return 0;
}

export function stats(args: string[], { root, out }: CliEnv): number {
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
    ['multi-file approvals', count((e) => e.check === 'multi-file' && (e.decision === 'approved' || e.decision === 'allow-log'))],
    ['allow-log', count((e) => e.decision === 'allow-log')],
  ]);
  const steps = events.filter((e) => e.check === 'stop' && e.decision === 'block').map((e) => {
    const r = e.reason ?? '';
    return r.startsWith('Diff coverage') || r.startsWith('Coverage output') ? 'coverage' : r.includes(' failed (attempt') ? r.slice(0, r.indexOf(' failed (attempt')) : 'other';
  });
  if (steps.length) section('Stop failures by step', [...tally(steps)]);
  const stop = (d: string) => count((e) => e.check === 'stop' && e.decision === d);
  section('Gave up and timeouts', [
    ['timeouts', count((e) => e.check === 'stop' && e.decision === 'context' && (e.reason ?? '').startsWith('Stop gate timed out'))],
    ...['stop-gave-up', 'stop-no-git', 'stop-diff-failed', 'coverage-skipped', 'coverage-diff-failed', 'stop-tool-missing'].map((d): [string, number] => [d, stop(d)]),
  ]);
  return 0;
}

export function run(argv: string[], cli: CliEnv): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'tdd' && rest.length === 1) return tdd(rest[0], cli);
  if (cmd === 'stats') return stats(rest, cli);
  if (cmd === 'doctor') return doctor(rest, cli);
  if (cmd === 'status') return status(rest, cli);
  cli.out(USAGE);
  return 2;
}

// Run only as the process entry (also true for the bundled dist file), so tests can import `run`.
const entry = process.argv[1];
try {
  if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
    const cli: CliEnv = { root: repoRoot(process.cwd()), env: process.env, tty: !!process.stdin.isTTY, out: (s) => console.log(s) };
    const argv = process.argv.slice(2);
    if (argv[0] === 'init') {
      const distDir = dirname(fileURLToPath(import.meta.url)); // dist/ of the running cli.mjs
      const prompt = readlinePrompt();
      try {
        process.exitCode = await init(argv.slice(1), { ...cli, root: process.cwd(), prompt, version: VERSION, templatesDir: join(distDir, '..', 'templates'), distDir });
      } finally {
        prompt.close();
      }
    } else if (argv[0] === 'uninstall') {
      const prompt = readlinePrompt();
      try {
        process.exitCode = await uninstall(argv.slice(1), { ...cli, root: process.cwd(), prompt });
      } finally {
        prompt.close();
      }
    } else if (argv[0] === 'update') {
      const distDir = dirname(fileURLToPath(import.meta.url));
      const prompt = readlinePrompt();
      try {
        process.exitCode = await update(argv.slice(1), { ...cli, root: process.cwd(), prompt, version: VERSION, templatesDir: join(distDir, '..', 'templates'), distDir });
      } finally {
        prompt.close();
      }
    } else process.exitCode = run(argv, cli);
    // So the guard can tell a person the exact command to run in their own terminal (R5).
    recordCliPath(repoRoot(process.cwd()), fileURLToPath(import.meta.url));
  }
} catch (e) {
  console.error(`harness: ${(e as Error).message}`);
  process.exitCode = 1;
}
