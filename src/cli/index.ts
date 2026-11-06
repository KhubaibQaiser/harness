import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendEvent, readEvents } from '../core/events.js';
import { packageDir } from '../core/package-dir.js';
import { repoRoot } from '../core/repo-root.js';
import { recordCliPath } from '../core/cli-path.js';
import { init } from './init.js';
import { insideClaude } from './claude-only.js';
import { uninstall } from './uninstall.js';
import { update } from './update.js';
import { items } from './items.js';
import { sync } from './sync.js';
import { readlinePrompt } from './prompt.js';
import { doctor } from './doctor.js';
import { status } from './status.js';
import { catalog } from './catalog.js';
import { preset } from './preset.js';
import { validate } from './validate.js';
import { vet } from './vet.js';
import { evalCmd } from './eval.js';
import { report } from './report.js';
import { select } from './select.js';
import { gitStep } from './git.js';
import { detect } from '../install/detect.js';
import { factsJson } from '../install/facts.js';
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
const USAGE = 'Usage: harness tdd off|on|status\n       harness stats [--days N]\n       /harness:init [--yes] [--dry-run] [--config <file>] [--answers <file> --product <file> --picks <file> --report <file> --choose <id,...>] [--install-plugins] [--over-budget]\n       harness uninstall [--yes] [--force] [--dry-run]\n       /harness:update [--yes] [--check] [--dry-run] [AI flags as init]\n       /harness:sync [--dry-run|--yes] [--take <file,...>] [--install-plugins] [--over-budget]\n       harness doctor\n       harness status\n       harness scan\n       harness catalog [check [--resolve] [--only <id,...>]]\n       harness preset list|check <dir>\n       harness validate answers <file> [--merge-config]\n       harness validate product <file>\n       harness validate picks <file> --answers <file> [--merge-config] [--attempt 1|2]\n       harness validate report <file> --picks <file> [--attempt 1|2]\n       harness validate vet-review <file> --scan <file> [--attempt 1|2]\n       harness vet <target> [--json [--keep]]\n       harness vet --finish <scan.json> --review <file>\n       harness vet --install <scan.json>\n       harness vet --clean\n       harness select --picks <file> [--choose <id,...>]\n       harness git branch|commit|push|pr [--title <t>]\n       /harness:add <id> [--take <file,...>] [--over-budget] [--dry-run|--yes]\n       harness remove <id> [--take <file,...>] [--dry-run|--yes]\n       harness why <id>\n       harness explain\n       harness report [--days N] [--open] [--export]\n       harness eval [--kind skills|rules|gates] [--runs N] [--max-cost-usd X] [--model M]';
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
  if (insideClaude(env)) {
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
  if (cmd === 'scan') return rest.length ? (cli.out(USAGE), 2) : (cli.out(factsJson(detect(cli.root))), 0);
  if (cmd === 'catalog') return catalog(rest, cli);
  if (cmd === 'preset') return preset(rest, cli);
  if (cmd === 'validate') return validate(rest, cli);
  if (cmd === 'vet') return vet(rest, cli);
  if (cmd === 'select') return select(rest, cli);
  if (cmd === 'git') return gitStep(rest, cli);
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
      const distDir = packageDir('dist');
      const prompt = readlinePrompt();
      try {
        process.exitCode = await init(argv.slice(1), { ...cli, root: process.cwd(), prompt, version: VERSION, templatesDir: packageDir('templates'), distDir });
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
      const distDir = packageDir('dist');
      const prompt = readlinePrompt();
      try {
        process.exitCode = await update(argv.slice(1), { ...cli, root: process.cwd(), prompt, version: VERSION, templatesDir: packageDir('templates'), distDir });
      } finally {
        prompt.close();
      }
    } else if (argv[0] === 'sync') {
      const prompt = readlinePrompt();
      try {
        process.exitCode = await sync(argv.slice(1), { ...cli, root: process.cwd(), prompt, version: VERSION, templatesDir: packageDir('templates'), distDir: packageDir('dist') });
      } finally {
        prompt.close();
      }
    } else if (argv[0] === 'report') {
      process.exitCode = await report(argv.slice(1), cli);
    } else if (argv[0] === 'eval') {
      const prompt = readlinePrompt();
      try {
        process.exitCode = await evalCmd(argv.slice(1), { ...cli, root: process.cwd(), prompt });
      } finally {
        prompt.close();
      }
    } else if (argv[0] === 'add' || argv[0] === 'remove' || argv[0] === 'why' || argv[0] === 'explain') {
      const prompt = readlinePrompt();
      try {
        process.exitCode = await items(argv[0], argv.slice(1), { ...cli, root: process.cwd(), prompt, templatesDir: packageDir('templates'), distDir: packageDir('dist') });
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
