// `harness task` (done-contract spec §4.1): the agent drafts a contract in its work folder; only a person approves, edits or closes it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inWorkdir } from '../checks/protect.js';
import { resolveStep } from '../checks/stop/runner.js';
import { esc, type HarnessConfig, isObj, loadConfig } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { SAFE_GIT } from '../core/git-safe.js';
import { unattendedEnv } from '../core/unattended.js';
import { type Contract, type Criterion, activeTaskId, featuresCriteria, loadContract, setActiveTask, TASKS_DIR, validateContract, writeContract } from '../done/contract.js';
import { detect } from '../install/detect.js';
import { hasResultsOutput } from '../install/test-config.js';
import { insideClaude } from './claude-only.js';
import { ownCommand } from './own-command.js';
import type { Prompt } from './prompt.js';
import type { CliEnv } from './index.js';

export type TaskEnv = CliEnv & { prompt: Prompt; git?: Exec; now?: () => Date };

export const TASK_USAGE = 'harness task draft <file> | approve <file> [--yes] | edit <id> --from <file> [--yes] | close <id> [--yes]';
const UNATTENDED = 'harness task does not approve, edit or close in unattended runs (CI, cloud or no-prompt sessions): a person must say yes.';
const GUARD_OFF = "harness task won't approve, edit or close from inside Claude Code while checks.guard is off, because the agent could run it. Run it in your own terminal.";
const NOT_WORKDIR = 'harness task: the draft must be inside a harness workdir folder (.harness/tmp/<id>/); run harness workdir to make one.';
const LAND = (id: string) => `Commit ${TASKS_DIR}/${id}.json and land it on the base branch before the work PR: CI reads contracts only from there.`;

const usage = (cli: TaskEnv): number => (cli.out(`Usage: ${TASK_USAGE}`), 2);
const log = (root: string, decision: string, reason?: string) =>
  appendEvent(root, { ts: new Date().toISOString(), session: 'cli', check: 'task', decision, ...(reason ? { reason } : {}) });

function head(cli: TaskEnv): string | null {
  const r = (cli.git ?? defaultExec)('git', [...SAFE_GIT, 'rev-parse', '--verify', 'HEAD'], { cwd: cli.root });
  const sha = r.stdout.trim();
  return r.status === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null;
}
const atHead = (cli: TaskEnv, rel: string) => (cli.git ?? defaultExec)('git', [...SAFE_GIT, 'cat-file', '-e', `HEAD:${rel}`], { cwd: cli.root }).status === 0;

/** The config, or the exit code after printing why not: a broken config never falls back to defaults here. */
function config(cli: TaskEnv): HarnessConfig | number {
  const { config, errors } = loadConfig(cli.root);
  if (!errors.length) return config;
  errors.forEach((e) => cli.out(`config: ${e}`));
  return 1;
}
const stepName = (s: HarnessConfig['stop']['steps'][number]) => (typeof s === 'string' ? s : s.name);
function scripts(root: string): Record<string, unknown> {
  const p = resolve(root, 'package.json');
  return existsSync(p) ? ((JSON.parse(readFileSync(p, 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {}) : {};
}

/** The draft at `file` (with `over` laid on top), validated as a draft against the configured stop steps; or its errors. */
function readDraft(cli: TaskEnv, cfg: HarnessConfig, file: string, over?: (raw: Record<string, unknown>) => Record<string, unknown> | string): Contract | string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(cli.root, file), 'utf8'));
  } catch (e) {
    return [`${esc(file)}: not readable JSON (${esc((e as Error).message.split('\n')[0] ?? '')})`];
  }
  if (over && isObj(raw)) {
    const o = over(raw);
    if (typeof o === 'string') return [o];
    raw = o;
  }
  const v = validateContract(raw, { approved: false });
  if (!v.ok) return v.errors;
  // validateContract has no config, so the step names are checked here.
  const names = new Set(cfg.stop.steps.map(stepName));
  const bad = v.contract.checks.map((n, i) => (names.has(n) ? null : `checks[${i}]: "${n}" is not a configured stop step (stop.steps: ${[...names].join(', ') || 'none'})`)).filter((e): e is string => e !== null);
  return bad.length ? bad : v.contract;
}

const how = (c: Criterion['check']) => ('test' in c ? `test ${c.test}` : 'run' in c ? `run \`${c.run}\`, expects exit ${c.expect_exit}` : `person: ${c.person}`);
const line = (c: Criterion) => `${c.id}: ${c.text} (${how(c.check)})`;

/** What makes a test criterion's evidence weak: a test not yet at HEAD, or a runner whose results harness can't read. */
function notes(cli: TaskEnv, cfg: HarnessConfig, c: Contract): string[] {
  const out: string[] = [];
  const pkgs = c.criteria.some((cr) => 'test' in cr.check) ? detect(cli.root).packages : [];
  for (const cr of c.criteria) {
    if (!('test' in cr.check)) continue;
    const rel = cr.check.test.slice(0, cr.check.test.indexOf('::'));
    if (!atHead(cli, rel)) out.push(`  ${cr.id} rests on a test written during the task (prefer a run check or a test the person writes first)`);
    const pkg = pkgs.filter((p) => p.dir === '.' || rel.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
    const why = !pkg || pkg.test === 'none' ? 'no vitest or jest package holds it' : hasResultsOutput(pkg, cli.root, cfg.tdd.results_dir) ? null : `${pkg.test} in ${pkg.dir} does not write ${cfg.tdd.results_dir}`;
    if (why) out.push(`  ${cr.id}: no JSON results reporter is set up for ${rel} (${why}), so harness can't see it pass; prefer a run criterion`);
  }
  return out;
}
const describe = (cli: TaskEnv, cfg: HarnessConfig, c: Contract): string[] =>
  [`Task ${c.id}: ${c.title}`, ...c.criteria.map((cr) => `  ${line(cr)}`), `  checks: ${c.checks.join(', ') || 'none'}; review model: ${c.review.model}`, ...notes(cli, cfg, c)];

/** The person's yes: --yes, else a TTY prompt. Returns null on yes, else the exit code. */
async function yes(cli: TaskEnv, flag: boolean, q: string, rerun: string[]): Promise<number | null> {
  if (flag) return null;
  if (cli.tty === false) return cli.out(`No terminal to answer prompts. ${ownCommand('task', [...rerun, '--yes'], cli.root)}`), 2;
  if (await cli.prompt.confirm(`${q} [y/N]`)) return null;
  return cli.out('Nothing written.'), 1;
}

/** The refusal for a write nobody can say yes to, or null. */
function writeGate(cli: TaskEnv, cfg: HarnessConfig): string | null {
  if (unattendedEnv(cli.env)) return UNATTENDED;
  if (insideClaude(cli.env) && !cfg.checks.guard) return GUARD_OFF;
  return null;
}

function draft(file: string, cli: TaskEnv, cfg: HarnessConfig): number {
  if (!existsSync(resolve(cli.root, file))) {
    const base = head(cli);
    if (!base) return cli.out('harness task: no commit to use as the base. Commit once, then run it again.'), 1;
    const pm = cfg.stop.package_manager, s = scripts(cli.root);
    const checks = cfg.stop.steps.map((st) => resolveStep(st, pm, s)?.label).filter((l): l is string => l !== undefined);
    const skeleton = { id: '', title: '', base, approved_by: null, approved_at: null, closed_at: null, criteria: featuresCriteria(cli.root), checks, review: { model: cfg.done.review_model }, sha256: null };
    mkdirSync(dirname(resolve(cli.root, file)), { recursive: true });
    writeFileSync(resolve(cli.root, file), JSON.stringify(skeleton, null, 2) + '\n');
    cli.out(`Wrote ${file}. Fill in id, title and criteria: each is { "id": "C1", "text": "…", "check": … } with check one of { "test": "<file>::<test name>" }, { "run": "<command>", "expect_exit": 0 } or { "person": "<what to check by hand>" }. Then run harness task draft ${file} again to check it.`);
    log(cli.root, 'task-drafted');
    return 0;
  }
  const c = readDraft(cli, cfg, file);
  if (Array.isArray(c)) return c.forEach((e) => cli.out(e)), 1;
  describe(cli, cfg, c).forEach((l) => cli.out(l));
  cli.out(`Ask the person to approve it. ${ownCommand('task', ['approve', file, '--yes'], cli.root)}`);
  log(cli.root, 'task-drafted', c.id);
  return 0;
}

async function approve(file: string, flag: boolean, cli: TaskEnv, cfg: HarnessConfig): Promise<number> {
  const no = (reason: string, msg: string) => (log(cli.root, 'task-approve-refused', reason), cli.out(msg), 1);
  const gate = writeGate(cli, cfg);
  if (gate) return no(gate === UNATTENDED ? 'unattended' : 'guard-off', gate);
  const c = readDraft(cli, cfg, file);
  if (Array.isArray(c)) return no('invalid', c.join('\n'));
  if (existsSync(resolve(cli.root, TASKS_DIR, `${c.id}.json`))) return no(c.id, `harness task: ${c.id} already exists; use harness task edit ${c.id} --from ${file} to change it.`);
  describe(cli, cfg, c).forEach((l) => cli.out(l));
  cli.out(`Will write ${TASKS_DIR}/${c.id}.json and make it the active task.`);
  const stop = await yes(cli, flag, `Approve task ${c.id}?`, ['approve', file]);
  if (stop === 1) log(cli.root, 'task-approve-refused', c.id);
  if (stop !== null) return stop;
  const base = head(cli);
  if (!base) return no(c.id, 'harness task: no commit to use as the base. Commit once, then run it again.');
  writeContract(cli.root, { ...c, approved_by: 'person', approved_at: (cli.now ?? (() => new Date()))().toISOString(), base, closed_at: null });
  setActiveTask(cli.root, c.id);
  cli.out(`Approved ${c.id}; it is the active task.`);
  cli.out(LAND(c.id));
  log(cli.root, 'task-approved', c.id);
  return 0;
}

/** The approved, open contract `id`, or the exit code after printing why not. */
function open(cli: TaskEnv, id: string): Contract | number {
  const l = loadContract(cli.root, id);
  if ('error' in l) return cli.out(l.error), 1;
  if (l.contract.closed_at !== null) return cli.out(`harness task: ${id} is closed; draft a new task instead.`), 1;
  return l.contract;
}

function changes(a: Contract, b: Contract): string[] {
  const old = new Map(a.criteria.map((c) => [c.id, JSON.stringify(c)]));
  const now = new Map(b.criteria.map((c) => [c.id, JSON.stringify(c)]));
  return [
    ...b.criteria.filter((c) => !old.has(c.id)).map((c) => `added ${line(c)}`),
    ...a.criteria.filter((c) => !now.has(c.id)).map((c) => `removed ${line(c)}`),
    ...b.criteria.filter((c) => old.has(c.id) && old.get(c.id) !== now.get(c.id)).map((c) => `changed ${line(c)}`),
    ...(a.title !== b.title ? [`title: ${a.title} -> ${b.title}`] : []),
    ...(a.checks.join() !== b.checks.join() ? [`checks: ${a.checks.join(', ') || 'none'} -> ${b.checks.join(', ') || 'none'}`] : []),
    ...(a.review.model !== b.review.model ? [`review model: ${a.review.model} -> ${b.review.model}`] : []),
  ];
}

async function edit(id: string, file: string, flag: boolean, cli: TaskEnv, cfg: HarnessConfig): Promise<number> {
  const gate = writeGate(cli, cfg);
  if (gate) return cli.out(gate), 1;
  const old = open(cli, id);
  if (typeof old === 'number') return old;
  // Keeps id and base: the file supplies only what the person may change.
  const c = readDraft(cli, cfg, file, (raw) => (raw.id !== id ? `${esc(file)}: its id must be ${id}` : { ...raw, base: old.base, approved_by: null, approved_at: null, closed_at: null, sha256: null }));
  if (Array.isArray(c)) return c.forEach((e) => cli.out(e)), 1;
  const diff = changes(old, c);
  if (!diff.length) return cli.out(`No change to ${id}.`), 0;
  diff.forEach((l) => cli.out(l));
  notes(cli, cfg, c).forEach((l) => cli.out(l));
  const stop = await yes(cli, flag, `Approve these changes to ${id}?`, ['edit', id, '--from', file]);
  if (stop !== null) return stop;
  writeContract(cli.root, { ...c, approved_by: 'person', approved_at: (cli.now ?? (() => new Date()))().toISOString() });
  cli.out(`Edited ${id}.`);
  cli.out(LAND(id));
  log(cli.root, 'task-edited', id);
  return 0;
}

async function close(id: string, flag: boolean, cli: TaskEnv, cfg: HarnessConfig): Promise<number> {
  const gate = writeGate(cli, cfg);
  if (gate) return cli.out(gate), 1;
  const c = open(cli, id);
  if (typeof c === 'number') return c;
  // The state file only: HARNESS_TASK belongs to the launch environment, and close never changes it.
  const active = activeTaskId(cli.root, {}) === id;
  cli.out(`Will close ${id}: ${c.title}${active ? ', and clear the active task' : ''}.`);
  const stop = await yes(cli, flag, `Close task ${id}?`, ['close', id]);
  if (stop !== null) return stop;
  writeContract(cli.root, { ...c, closed_at: (cli.now ?? (() => new Date()))().toISOString() });
  if (active) setActiveTask(cli.root, null);
  cli.out(`Closed ${id}.`);
  cli.out(LAND(id));
  log(cli.root, 'task-closed', id);
  return 0;
}

export async function task(args: string[], cli: TaskEnv): Promise<number> {
  const [sub, ...rest] = args;
  const flags = rest.filter((a) => a === '--yes').length;
  const pos = rest.filter((a) => a !== '--yes');
  const plain = (i: number) => pos[i] !== undefined && !pos[i]!.startsWith('-');
  const ok = flags <= (sub === 'draft' ? 0 : 1) && (
    sub === 'draft' || sub === 'approve' ? pos.length === 1 && plain(0)
      : sub === 'edit' ? pos.length === 3 && plain(0) && pos[1] === '--from' && plain(2)
        : sub === 'close' && pos.length === 1 && plain(0));
  if (!ok) return usage(cli);
  if ((sub === 'draft' || sub === 'approve') && !inWorkdir(cli.root, pos[0]!)) return cli.out(NOT_WORKDIR), 2;
  const cfg = config(cli);
  if (typeof cfg === 'number') return cfg;
  if (sub === 'draft') return draft(pos[0]!, cli, cfg);
  if (sub === 'approve') return approve(pos[0]!, flags === 1, cli, cfg);
  if (sub === 'edit') return edit(pos[0]!, pos[2]!, flags === 1, cli, cfg);
  return close(pos[0]!, flags === 1, cli, cfg);
}
