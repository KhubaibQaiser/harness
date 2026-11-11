// `harness remember` (team-decisions spec §5): add, sync and list. Field text is untrusted: secret-scanned before
// anything echoes it, printed through `shown`, and never logged.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { ApplyError, type Change, type FsLike } from '../install/apply.js';
import { MANIFEST_REL } from '../install/manifest.js';
import type { HarnessConfig } from '../core/config.js';
import { DECISIONS_DIR, MAX_PATHS, MAX_TITLE_CHARS, addBody, globProblem, parseDecision, serializeDecision, shown, slugId, type TeamDecision } from '../core/decision-file.js';
import { renderRule, ruleRel } from '../core/decision-rule.js';
import { commitDecisions, planSync, readDecisions, type DecisionSet, type SyncPlan } from '../core/decisions.js';
import { gitIn, type Git } from '../core/decisions-stale.js';
import { appendEvent } from '../core/events.js';
import { gitRoot } from '../core/repo-root.js';
import { argsValid, type Flags, parseFlags, REMEMBER_SPECS } from '../core/remember-args.js';
import { scanSecrets } from '../core/secrets.js';
import { unattendedEnv } from '../core/unattended.js';
import { insideClaude } from './claude-only.js';
import type { Prompt } from './prompt.js';
import { openInstall, readConfig } from './preamble.js';
import { list } from './remember-read.js';
import type { CliEnv } from './index.js';

export type RememberEnv = CliEnv & { prompt: Prompt; now?: () => Date; fs?: FsLike; /** Default: git in the repo root; tests pass a fake. */ git?: Git };

export const REMEMBER_USAGE = [
  'harness remember add --title <text> --rule <text> [--why <text>] --path <glob> [--path <glob>…] [--supersedes <id>] [--quoted] [--dry-run] [--yes]',
  'harness remember confirm <id> [--dry-run] [--yes]',
  'harness remember retire <id> [--by <id>] [--dry-run] [--yes]',
  'harness remember sync [--dry-run] [--yes]',
  'harness remember list',
  'harness remember check',
];
const UNATTENDED = 'harness remember does not write in unattended runs (CI, cloud or no-prompt sessions). A person can save it later.';
const GUARD_OFF = "harness remember won't write from inside Claude Code while checks.guard is off, because nobody would be asked. Run it in your own terminal.";
const NOT_INSTALLED = 'Harness is not installed here (no .harness/manifest.json). Run /harness:init first.';
const NO_TTY = 'No terminal to answer prompts. Run with --yes, or use --dry-run to preview.';
const NOT_COMMITTED = 'Nothing is committed. Open a PR so the team reviews it.';
const MAX_RULE_CHARS = 300;
const MAX_WHY_CHARS = 500;
const SHA = /^[0-9a-f]{40}$/;
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u; // newlines included: every field is one line
const SAFE = ['-c', 'core.fsmonitor=false'];

interface Ctx { root: string; cfg: HarnessConfig; today: string; now: () => Date; git: Git }

const usage = (cli: RememberEnv): number => (cli.out(`Usage: ${REMEMBER_USAGE.join('\n       ')}`), 2);
const log = (root: string, decision: string, reason?: string) =>
  appendEvent(root, { ts: new Date().toISOString(), session: 'cli', check: 'remember', decision, ...(reason ? { reason } : {}) });
/** Prints the refusal and logs only its reason word. */
const refuse = (cli: RememberEnv, root: string, reason: string, msg: string): number => (log(root, 'refused', reason), cli.out(msg), 1);

/** §5 write steps 1 and 2: the refusal copy, or null. */
export function writeGate(cli: RememberEnv, config: HarnessConfig): string | null {
  if (unattendedEnv(cli.env)) return UNATTENDED;
  if (insideClaude(cli.env) && !config.checks.guard) return GUARD_OFF;
  return null;
}

/** The repo, its config and today; or the exit code after printing why not. `write`: run the write gate too. */
function open(cli: RememberEnv, write: boolean): Ctx | number {
  const git = gitRoot(cli.root);
  if (git && !existsSync(join(git, MANIFEST_REL))) return cli.out(NOT_INSTALLED), 1;
  const o = openInstall(cli, 'Not a git repository. Run harness inside a git repo.');
  if (typeof o === 'number') return o;
  const cfg = readConfig(o.root, cli.out);
  if (typeof cfg === 'number') return cfg;
  const gate = write ? writeGate(cli, cfg) : null;
  if (gate) return refuse(cli, o.root, gate === UNATTENDED ? 'unattended' : 'guard-off', gate);
  const now = cli.now ?? (() => new Date());
  return { root: o.root, cfg, today: now().toISOString().slice(0, 10), now, git: cli.git ?? gitIn(o.root) };
}

const secretIn = (fields: [string, string][]): string | null => {
  for (const [name, text] of fields) {
    const hit = scanSecrets(text)[0];
    if (hit) return `harness remember: ${name} looks like it holds a secret (${hit.kind}). Decisions are committed to git. Remove it.`;
  }
  return null;
};

const fitsLine = (s: string, min: number, max: number): boolean => [...s].length >= min && [...s].length <= max && !CONTROL.test(s);

function fieldProblem(title: string, rule: string, why: string, paths: string[]): string | null {
  if (!fitsLine(title, 1, MAX_TITLE_CHARS)) return `--title must be one line of 1 to ${MAX_TITLE_CHARS} characters`;
  if (!fitsLine(rule, 1, MAX_RULE_CHARS)) return `--rule must be one line of 1 to ${MAX_RULE_CHARS} characters`;
  if (!fitsLine(why, 0, MAX_WHY_CHARS)) return `--why must be one line of 0 to ${MAX_WHY_CHARS} characters`;
  if (paths.length > MAX_PATHS) return `--path must be given 1 to ${MAX_PATHS} times`;
  for (const p of paths) {
    const problem = globProblem(p);
    if (problem) return `--path ${shown(p)} ${problem}`;
  }
  return null;
}

/** HEAD and the paths that match no tracked file, or a refusal. */
function fromGit(git: Git, paths: string[]): { head: string; dead: string[] } | string {
  const head = git([...SAFE, 'rev-parse', 'HEAD']);
  const sha = head.out.trim();
  if (!head.ok || !SHA.test(sha)) return 'harness remember: no commit to record as verified_at. Commit once, then run it again.';
  const ls = git([...SAFE, 'ls-files', '-z']);
  if (!ls.ok) return `harness remember: couldn't list tracked files (${shown(ls.reason ?? 'git failed')}).`;
  const files = ls.out.split('\0').filter(Boolean);
  return { head: sha, dead: paths.filter((p) => { const m = picomatch(p, { dot: true }); return !files.some((f) => m(f)); }) };
}

/** `verb`: write, remove, update. A manifest-only fix (adopt, rehash, drop) gets its own line, so a yes is never blind. */
const fileLines = (changes: Change[], plan: SyncPlan, verb: [string, string, string]): string[] => [
  ...changes.map((c) => `${c.kind === 'delete' ? verb[1] : verb[0]} ${shown(c.rel)}`),
  ...(changes.length === 0 && plan.adopt.length + plan.rehash.length + plan.stale.length > 0 ? [`${verb[2]} ${MANIFEST_REL}`] : []),
];

/** Steps 4 and 5: dry run, the prompt, then one transaction. Returns the exit code when it stops, or null once written. */
async function commit(cli: RememberEnv, ctx: Ctx, flags: Flags, decisionChanges: Change[], plan: SyncPlan): Promise<number | null> {
  const all = [...decisionChanges, ...plan.changes];
  if (plan.foreign.length) return refuse(cli, ctx.root, 'foreign', `harness remember: ${shown(plan.foreign[0]!)} is not harness's; rename it`);
  if (flags.switches.has('--dry-run')) return fileLines(all, plan, ['Would write', 'Would remove', 'Would update']).forEach((l) => cli.out(l)), 0;
  if (!flags.switches.has('--yes')) {
    if (cli.tty === false) return cli.out(NO_TTY), 2;
    fileLines(all, plan, ['Will write', 'Will remove', 'Will update']).forEach((l) => cli.out(l));
    if (!(await cli.prompt.confirm('Write these files? [y/N]'))) return refuse(cli, ctx.root, 'declined', 'Nothing written.');
  }
  try {
    commitDecisions(ctx.root, decisionChanges, plan, { now: ctx.now, ...(cli.fs ? { fs: cli.fs } : {}) });
  } catch (e) {
    if (!(e instanceof ApplyError)) throw e;
    return refuse(cli, ctx.root, 'apply', shown(e.message)); // applyChanges already rolled back
  }
  return null;
}

/** The new decision, and the update for the one it supersedes; or a refusal. */
function build(ctx: Ctx, set: DecisionSet, f: { title: string; rule: string; why: string; paths: string[]; supersedes?: string; head: string }) {
  const id = slugId(f.title, ctx.today, (id) => existsSync(join(ctx.root, DECISIONS_DIR, `${id}.md`)));
  const d: TeamDecision = { id, title: f.title, status: 'active', paths: f.paths, verified_at: f.head, verified_on: ctx.today, body: `${addBody(f.rule, f.why)}\n`, rel: `${DECISIONS_DIR}/${id}.md` };
  const text = serializeDecision(d);
  const { errors } = parseDecision(d.rel, text, ctx.today);
  if (errors.length) return { error: errors.join('\n') };
  const changes: Change[] = [{ kind: 'create', rel: d.rel, content: text }];
  let decisions = [...set.decisions, d];
  if (f.supersedes !== undefined) {
    const old = set.decisions.find((x) => x.id === f.supersedes);
    if (!old) return { error: `harness remember: no decision ${shown(f.supersedes)} in ${DECISIONS_DIR}/.` };
    if (old.status !== 'active') return { error: `harness remember: ${old.id} is ${old.status}, not active. Only an active decision can be superseded.` };
    const next: TeamDecision = { ...old, status: 'superseded', superseded_by: id };
    changes.push({ kind: 'update', rel: old.rel, before: readFileSync(join(ctx.root, old.rel), 'utf8'), after: serializeDecision(next), blocks: [], rewrite: true });
    decisions = decisions.map((x) => (x === old ? next : x));
  }
  return { d, text, changes, set: { ...set, decisions } };
}

async function add(args: string[], cli: RememberEnv): Promise<number> {
  const f = parseFlags(args, REMEMBER_SPECS.add!.valued, REMEMBER_SPECS.add!.switches);
  if (!f || !argsValid('add', f)) return usage(cli);
  const ctx = open(cli, !f.switches.has('--dry-run'));
  if (typeof ctx === 'number') return ctx;
  const [title, rule, why, paths, supersedes] = [f.values.get('--title')![0]!, f.values.get('--rule')![0]!, f.values.get('--why')?.[0] ?? '', f.values.get('--path')!, f.values.get('--supersedes')?.[0]];
  const no = (reason: string, msg: string) => refuse(cli, ctx.root, reason, msg);
  const fields: [string, string][] = [['--title', title], ['--rule', rule], ['--why', why], ...paths.map((p): [string, string] => ['--path', p]), ['--supersedes', supersedes ?? '']];
  const secret = secretIn(fields);
  if (secret) return no('secret', secret);
  const bad = fieldProblem(title, rule, why, paths);
  if (bad) return no('invalid', `harness remember: ${bad}`);
  const g = fromGit(ctx.git, paths);
  if (typeof g === 'string') return no('git', g);
  if (g.dead.length) return no('dead-path', `harness remember: ${shown(g.dead[0]!)} matches no tracked file. Fix the path, or retire the decision.`);
  const b = build(ctx, readDecisions(ctx.root, ctx.today), { title, rule, why, paths, head: g.head, ...(supersedes !== undefined ? { supersedes } : {}) });
  if ('error' in b) return no('invalid', b.error!);
  const cap = ctx.cfg.decisions.max_lines;
  const lines = renderRule(b.d, cap).lines;
  if (lines > cap) return no('cap', `harness remember: the rule would be ${lines} lines; the cap is ${cap} (decisions.max_lines). Shorten --rule or --why.`);
  const fileSecret = secretIn([['the decision file', b.text]]);
  if (fileSecret) return no('secret', fileSecret);
  const plan = planSync(ctx.root, b.set, ctx.cfg.decisions, ctx.today);
  const stop = await commit(cli, ctx, f, b.changes, plan);
  if (stop !== null) return stop;
  for (const l of fileLines([...b.changes, ...plan.changes], plan, ['Wrote', 'Removed', 'Updated'])) cli.out(l === `Wrote ${ruleRel(b.d.id)}` ? `${l} (loads when ${paths.map(shown).join(', ')} are touched)` : l);
  cli.out(NOT_COMMITTED);
  log(ctx.root, 'added');
  return 0;
}

async function syncCmd(args: string[], cli: RememberEnv): Promise<number> {
  const f = parseFlags(args, REMEMBER_SPECS.sync!.valued, REMEMBER_SPECS.sync!.switches);
  if (!f || !argsValid('sync', f)) return usage(cli);
  const ctx = open(cli, !f.switches.has('--dry-run'));
  if (typeof ctx === 'number') return ctx;
  const set = readDecisions(ctx.root, ctx.today);
  set.errors.forEach((e) => cli.out(e));
  const plan = planSync(ctx.root, set, ctx.cfg.decisions, ctx.today);
  const inSync = `Rules in sync: ${set.decisions.length} decisions, ${plan.wanted} rules (${plan.leftOut} expired or retired, left out).`;
  const code = set.errors.length ? 1 : 0;
  if (plan.changes.length + plan.adopt.length + plan.rehash.length + plan.stale.length === 0 && !plan.foreign.length) return cli.out(inSync), code;
  const stop = await commit(cli, ctx, f, [], plan);
  if (stop !== null) return stop;
  fileLines(plan.changes, plan, ['Wrote', 'Removed', 'Updated']).forEach((l) => cli.out(l));
  log(ctx.root, 'synced');
  return code;
}

export async function remember(args: string[], cli: RememberEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'add') return add(rest, cli);
  if (sub === 'sync') return syncCmd(rest, cli);
  if (sub !== 'list' || rest.length) return usage(cli);
  const ctx = open(cli, false);
  if (typeof ctx === 'number') return ctx;
  const lines = list(ctx.root, ctx.cfg, ctx.today);
  cli.out(lines.length ? lines.join('\n') : `No team decisions in ${DECISIONS_DIR}/.`);
  return 0;
}
