// Agent guard, ported from fitness-app scripts/agent-hooks/guard.mjs. A seatbelt, not a sandbox.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultLookup, type VerifyOpts, verifyPackages } from './dep-verify.js';
import { readCliPath, trustedCli } from '../core/cli-path.js';
import { globRegex, plainHeads } from '../core/command-head.js';
import { type OptTable, type Parsed, readOptions, valuesOf, withoutRedirects } from '../core/options.js';
import { commandName, cPayloads, pieces, remember, SHELLS, stdinPrograms, unquote as shellUnquote, withWorkBudget, words as shellWords } from '../core/shell-words.js';
import { isTestFile, matches, toRepoPath } from '../core/paths.js';
import { isShell } from '../hooks/edit-target.js';
import { commandSkeleton, eachJoin, gitPlain, globReadings, joinAll, joinLines, joinVariant, MAX_READINGS, RULED, splicedReading, textRulesView } from './guard-readings.js';
import { type Quoted, Scan, SCAN_BUDGET_WHY, ScanBudget } from './guard-scan.js';
import { commandTests, EDITOR_SET, wholeFlags } from './guard-sinks.js';
import { writesGitOutputAndRunsFile, writesGitOutputToSensitivePath } from './guard-allow.js';
import { decideCommand as decideBase, JOIN } from './guard-base.js';
import type { Check, Ctx } from '../hooks/dispatch.js';
import type { Decision } from '../hooks/types.js';
import { REMEMBER_WHY, rememberAsk } from './remember.js';
import { rememberReadOnly } from '../core/remember-args.js';
import { suggestBranches } from '../core/branch-prefix.js';
import { ghWriteWhy, HUB_OWN, hubWriteWhy, pushConfigWhy, pushOptionWhy, remoteRefWhy } from './gh-writes.js';

type GuardCtx = Pick<Ctx, 'config' | 'env' | 'root'> & { startedAt?: number; lookup?: VerifyOpts['lookup'] }; // lookup: test seam
type Verdict = ['allow'] | ['deny' | 'ask', string];

const SAFE_EXAMPLE = /\.(example|sample|template|dist)$/i;
const SAFE_RM_TARGETS =
  /^(\.\/)?(node_modules|dist|build|out|coverage|\.next|\.turbo|\.cache|\.expo|\.vercel|tmp|\.tmp|playwright-report|test-results)\/?$/;
// Flags whose next token is a value, not a package name.
const VALUE_FLAGS = new Set(['--filter', '-F', '--cwd', '-C', '--dir', '--prefix', '--registry', '--workspace']);
// pip: requirement files, constraints, editable paths and indexes are not package names.
const PIP_VALUE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-t', '--target', '--prefix', '--root', '--python']);
const JS_ADD = new Set(['add', 'install', 'i']);
const PY_ADD = new Set(['add', 'install']);
const REDIRECTION = /\d*[<>]+&?\d*\s*[^\s;&|]*/g;
const RUNNERS = new Set(['npx', 'npm', 'pnpm', 'dlx', 'exec', 'yarn', 'bun', 'bunx', 'node', 'sudo', 'env', 'eval', 'bash', 'sh', 'zsh', 'command', 'nohup', 'time', 'nice', 'timeout', 'xargs', 'pnpx', 'x', 'stdbuf', 'script']);
// Matched on text whose backslashes became slashes (see personOnlyInvocation). Windows shims (harness.cmd) and any case
// count: Windows and macOS file systems ignore case.
const HARNESS_CMD = /(^=?|\/)harness(@\S+)?(\.(cmd|ps1|bat|exe))?$|(^=?|\/)cli\.m?js$/i; // zsh =cmd expands to the path of cmd
/** True when a wrapper's flag takes the next word as its value: the flag itself (-u, --unset), or a short-option
 *  cluster whose first value flag is its last letter (-iu NAME, -vs KILL), for every wrapper in WRAPPER_VALUE_FLAGS.
 *  As in getopt, a value flag earlier in the cluster takes the rest of it as its value (-uC: unset C). */
const takesValue = (wrapper: string, t: string): boolean => {
  const flags = WRAPPER_VALUE_FLAGS[wrapper];
  if (!flags) return false;
  if (flags.has(t)) return true;
  if (!/^-[a-zA-Z0-9]{2,}$/.test(t)) return false;
  const i = [...t.slice(1)].findIndex((c) => flags.has(`-${c}`));
  return i === t.length - 2;
};
/** `C:/nodejs/npx.cmd` -> `npx`: a runner by its last path segment, without a Windows extension, in lower case. */
const NAME_PLAIN = /^[a-z0-9_-]*$/; // a word every name rule leaves as it is
export const runnerName = (t: string): string => (NAME_PLAIN.test(t) ? t : runnerNameOf(t)); // most words are plain
const runnerNameOf = (t: string): string => t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1).toLowerCase().replace(/^=/, '').replace(/\.(cmd|ps1|bat|exe)$/, '');
// Flags of a wrapper whose value is the next word, so that word is not the command.
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a']),
  stdbuf: new Set(['-i', '-o', '-e']),
  npx: new Set(['-p', '--package', ...VALUE_FLAGS]),
  ...Object.fromEntries(['npm', 'pnpm', 'yarn', 'bun', 'bunx', 'pnpx', 'exec', 'dlx', 'x'].map((n) => [n, VALUE_FLAGS])),
};
const NPM_ALIAS: Record<string, string> = { t: 'test', tst: 'test' };
const BUILT = 'the subcommand of a harness command is built by the shell (a brace, glob, forwarded or piped word), so the guard cannot read it';
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until']);
const PMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Subcommands only a person may run (deny) or that need the person's yes (ask; the dispatcher denies it when
// unattended), with the arguments (after the subcommand) the agent may still use. `run(sub)` is how the person runs
// `harness <sub>` in their own terminal. One place: M3's entries are in.
// A word right after a value flag is that flag's value (init reads `--config --dry-run` as a file name), not a preview flag.
const VALUE_FLAG = new Set(['--config', '--answers', '--product', '--picks', '--report', '--choose', '--take', '--title']);
const PREVIEW_FLAGS = new Set(['--dry-run', '--check', '--plan']);
const OTHER_FLAGS = new Set(['--over-budget', '--install-plugins']);
const PLAIN_WORD = /^[\w@%+=:,./-]+$/; // no #, <, >, $, quotes or globs: nothing the shell could read differently
/** Fails closed: a preview only when a preview flag is a real flag and every other word is a known flag, a value flag's
 *  value, or a plain positional word. A comment, redirection, --yes or anything unknown means not a preview. */
const PREVIEW = (a: string[]): boolean => {
  if (a.includes('--yes')) return false;
  let preview = false;
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (VALUE_FLAG.has(t)) {
      if (!a[i + 1] || a[i + 1].startsWith('-') || !PLAIN_WORD.test(a[++i])) return false;
    } else if (PREVIEW_FLAGS.has(t)) preview = true;
    else if (!OTHER_FLAGS.has(t) && (t.startsWith('-') || !PLAIN_WORD.test(t))) return false;
  }
  return preview;
};
export const TASK_PERSON_WHY = 'Only a person approves, edits or closes a task contract: ask them to run';
const PERSON_ONLY: Record<string, { kind: 'deny' | 'ask'; allowed: (args: string[]) => boolean; why: (run: (sub: string) => string) => string }> = {
  tdd: { kind: 'deny', allowed: (a) => ['on', 'status'].includes(a.filter((t) => !t.startsWith('-'))[0]), why: (run) => `Only a person can pause TDD: run ${run('tdd off')} in your own terminal.` },
  uninstall: { kind: 'ask', allowed: (a) => a.includes('--dry-run') && a.every((t) => t === '--dry-run' || t === '--global'), why: () => 'the agent is uninstalling the harness, which removes every gate' },
  init: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is installing the harness, which writes its hooks, rules and settings' },
  update: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is updating the harness, which rewrites its hooks, rules and settings' },
  add: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is adding a harness item, which writes its files and settings' },
  remove: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is removing a harness item, which deletes its files and settings' },
  sync: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is syncing the harness items, which rewrites their files and settings' },
  git: { kind: 'ask', allowed: (a) => a[0] === 'branch' || a[0] === 'commit', why: () => 'the agent is pushing or opening a pull request for the harness changes' },
  preset: { kind: 'ask', allowed: (a) => a[0] === 'list' || a[0] === 'check' || (a[0] === 'install' && a.includes('--dry-run') && !a.includes('--yes')), why: () => 'the agent is installing a preset, which writes rules, skills and settings (global ones go to ~/.claude)' },
  context: { kind: 'ask', allowed: (a) => a[0] !== 'apply' || PREVIEW(a.slice(1)), why: () => 'the agent is changing which skills load, in .claude/settings.json' },
  report: { kind: 'ask', allowed: (a) => a.includes('--help'), why: () => "the agent is running the usage and adherence report, which reads this repo's session transcripts" },
  remember: { kind: 'ask', allowed: rememberReadOnly, why: () => REMEMBER_WHY },
  eval: { kind: 'deny', allowed: (a) => a.includes('--help'), why: (run) => `Only a person can run paid evals: run ${run('eval')} in your own terminal.` },
  task: { kind: 'deny', allowed: (a) => a[0] === 'draft', why: (run) => `${TASK_PERSON_WHY} ${run('task approve <file> --yes')}.` },
};
const isPersonOnly = (t: string | undefined): t is string => t !== undefined && Object.hasOwn(PERSON_ONLY, t);
// The shell can turn such a word into any subcommand or flag, so no preview test passes it; `next` is the separator after
// the segment (the split eats `$(`, a backtick and the `(` of `<(`/`>(`, so `context $(echo apply)` reaches here as `context`).
const PREVIEW_EXPANDS = /[$`{}*?[\]]|^~/;
const passes = (name: string, args: string[], next?: string): boolean =>
  !/^(\$\(|`|\()$/.test(next ?? '') && !args.some((t) => PREVIEW_EXPANDS.test(t)) && PERSON_ONLY[name].allowed(args);
const ANY_WHY = 'Only a person can change or remove the harness gates: run the harness command in your own terminal.';
type Hit = { kind: 'deny' | 'ask'; reason: string };
export type Where = { root: string; env: NodeJS.ProcessEnv };

/**
 * How the person runs `harness <sub>` in their own terminal, in backticks: a trusted CLI path (the typed one, or the
 * one recorded by the last trusted harness run here), else plain `harness <sub>` with the other ways to run it.
 * Never a path from an unknown place: the agent could have written it.
 */
function terminalCommand(tok: string, sub: string, w: Where): string {
  tok = tok.split(KEPT_SPACE).join(' ');
  if (/(^|\/)cli\.m?js$/.test(tok)) {
    const p = tok.replace(/\$\{?(\w+)\}?/g, (m, v: string) => w.env[v] ?? m);
    const real = /\$/.test(p) ? null : trustedCli(resolve(w.root, p), w.root);
    if (real) return `\`node "${real}" ${sub}\``;
  }
  const recorded = readCliPath(w.root);
  if (recorded) return `\`node "${recorded}" ${sub}\``;
  return `\`harness ${sub}\` (if harness is not on your PATH: \`npx @khubaibqaiser/harness ${sub}\`, or from a source checkout \`node /path/to/harness/dist/cli.mjs ${sub}\`)`;
}

/**
 * Where a command runs in a segment's words: past wrappers, their flags and the values those flags take, a timeout's
 * duration, script's FILE, and into find -exec. Words anywhere else (echo, grep, rg, git args) are not commands.
 * `stop` ends the walk at a name that is a runner here but the command for the caller (protect's interpreters).
 * A `CMD=harness` assignment is rewritten in place to its value, so the caller sees the harness word.
 */
export function commandStart(toks: string[], stop: (name: string) => boolean = () => false): number {
  let k = 0, wrapper = '', scriptFile = false;
  while (k < toks.length) {
    const t = toks[k];
    if (stop(runnerName(t))) break;
    if (t === 'find') {
      let e = k + 1; // from k, not from 0: many `find` words stay linear (re-review 22b, F4)
      while (e < toks.length && !/^-(exec|execdir|ok|okdir)$/.test(toks[e])) e++;
      if (e >= toks.length) break;
      [k, wrapper] = [e + 1, ''];
    } else if (RESERVED.has(t)) k++; // `{ harness …; }`, `! harness …`, `then harness …`
    else if (RUNNERS.has(runnerName(t))) [k, wrapper, scriptFile] = [k + 1, runnerName(t), runnerName(t) === 'script'];
    else if (/^\w+=/.test(t)) {
      const val = t.replace(/^\w+=/, '');
      if (HARNESS_CMD.test(val)) { toks[k] = val; break; } // CMD="harness tdd off"
      k++;
    } else if (t.startsWith('-')) {
      if (t === '-c') scriptFile = false; // script -c COMMAND
      k += takesValue(wrapper, t) ? 2 : 1;
    } else if (k > 0 && /^\d+(\.\d+)?[smhd]?$/.test(t)) k++; // timeout 60, timeout 1m
    else if (scriptFile) [k, scriptFile] = [k + 1, false]; // script [-q] FILE COMMAND (BSD form)
    else break;
  }
  return k;
}

function scriptsOf(root: string): Record<string, string> {
  try {
    const s = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

/**
 * The command with each data here-document body removed (sinkTest: a body is code unless it goes to a data sink, and a
 * code body stays as command lines). Round 25: the heredocs (where each operator is, its delimiter, whether it is
 * quoted, where its body ends) come only from the lexer (lexText), and only text canonicalText accepts in full has any
 * body taken out. There is no second quote reader to disagree with it (re-review 22b, F1, F3, F5).
 */
export const withoutHeredocBodies = remember(withoutBodies, () => joinVariant());
/** What stdin feeds each command, read with the guard's command start (shells stop it); kept for the decision's repeats. */
const shellPrograms = remember((c: string) => stdinPrograms(c, (ws) => commandStart(ws, (n) => SHELLS.has(n))));
function withoutBodies(cmd: string): string {
  const lx = lexText(cmd);
  if (!lx?.heredocs.length || lx.heredocs.some((h) => h.to < 0)) return cmd; // no end line: nothing is hidden
  const tests = commandTests(new Scan(cmd), wholeFlags(cmd, commandSkeleton(cmd)));
  let out = '', at = 0;
  for (const h of lx.heredocs) if (tests.sink(h.lineStart, h.at)) [out, at] = [out + cmd.slice(at, h.from), h.to];
  return out + cmd.slice(at);
}

/** One command segment of one reading: `k = commandStart(toks)`, `prev`/`next` the separators around it, `words` all the words of the reading. */
export type Seg = { toks: string[]; k: number; prev?: string; next?: string; words: string[] };
export type Visit<T> = (seg: Seg) => T | null;
/** `whole` sees each reading's words before that reading's segments; readings are interleaved (reading 2's `whole` runs
 *  after reading 1's visits, and payload readings come after all four). `script` sees each package-script body after it
 *  is walked. `tooDeep` is the result for a script body at depth 3 or more; without `tooDeep`, a body at depth 3 or more
 *  is not walked and the walk goes on. */
export interface WalkHooks<T> { whole?: (words: string[]) => T | null; script?: (body: string) => T | null; tooDeep?: T }

/** Walks every command segment of `command` the way the shell could read it, under every line-continuation reading
 *  (eachJoin); the first non-null result wins. A nested body is read once, joined as its shell joins it: readings at
 *  every level multiply (re-review 19, N8). */
export function walkCommands<T>(command: string, w: Where, visit: Visit<T>, hooks: WalkHooks<T> = {}, depth = 0): T | null {
  if (depth > 0) return walkJoined(joinLines(command), w, visit, hooks, depth);
  return eachJoin(command, (t) => walkJoined(t, w, visit, hooks, depth), (r) => r !== null).find((r) => r !== null) ?? null;
}
function walkJoined<T>(command: string, w: Where, visit: Visit<T>, hooks: WalkHooks<T>, depth: number): T | null {
  const whole = command;
  command = withoutHeredocBodies(command); // a body is data for its command; a shell reading it is handled below, from `whole`
  // A backslash is an escape in a POSIX shell (harn\\ess -> harness) and a path separator on Windows
  // (C:\\x\\cli.mjs): judge the command both ways.
  // Then again with a quoted or escaped space kept inside its word, so a path such as "C:\\Users\\John Smith\\…\\cli.mjs"
  // or ./my\\ dir/cli.mjs stays one word. (The ungrouped readings still see a command inside quotes: sh -c "harness …".)
  return (
    walkReading(command.replace(/['"\\]/g, ''), w, visit, hooks, depth) ??
    walkReading(command.replace(/['"]/g, '').replace(/\\/g, '/'), w, visit, hooks, depth) ??
    walkReading(grouped(command, true), w, visit, hooks, depth) ??
    walkReading(grouped(command, false), w, visit, hooks, depth) ??
    // A -c payload, or a program fed to a shell on stdin (echo … | bash, <<<, a here-document), is a command line of
    // its own: judge it with all the readings (a spaced path inside it is one word).
    (depth < 3
      ? [...cPayloads(command), ...shellPrograms(whole).filter((p) => SHELLS.has(p.name)).map((p) => p.text)]
          .reduce<T | null>((hit, p) => hit ?? walkCommands(p, w, visit, hooks, depth + 1), null)
      : null)
  );
}

// Why a harness invocation (in command position) needs the person, or null when the agent may run it.
// ponytail: a wrapper flag value not listed in WRAPPER_VALUE_FLAGS is read as the command, which then isn't harness.
function personOnlyInvocation(command: string, w: Where, depth = 0): Hit | null {
  return walkCommands(command, w, personOnlyVisit(w), {
    // eval re-parses its input, so any eval near a harness token and a person-only subcommand is denied.
    // `eval` itself is left out of the person-only test, so harness's own `eval` subcommand is judged by its table entry.
    whole: (words) => (words.includes('eval') && words.some((t) => t !== 'eval' && isPersonOnly(t)) && words.some((t) => HARNESS_CMD.test(t.replace(/^\w+=/, ''))) ? { kind: 'deny', reason: ANY_WHY } : null),
    script: backstop,
    tooDeep: { kind: 'ask', reason: 'a chain of npm scripts is too deep for the guard to read; run it yourself or read the scripts first' },
  }, depth);
}

const KEPT_SPACE = '\u0001'; // a space inside a word: not matched by \s, turned back into a space when printed
/** Quotes removed, spaces inside quotes (and `\\ ` when backslash escapes) kept in the word; other backslashes dropped
 *  (escape reading) or made `/` (Windows reading). */
function grouped(command: string, escapes: boolean): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      else out += c === ' ' ? KEPT_SPACE : c === '\\' ? (escapes ? '' : '/') : c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '\\' && escapes) out += command[i + 1] === ' ' ? (i++, KEPT_SPACE) : '';
    else out += c === '\\' ? '/' : c;
  }
  return out;
}

function walkReading<T>(plain: string, w: Where, visit: Visit<T>, hooks: WalkHooks<T>, depth: number): T | null {
  const words = plain.split(/[ \t]+/); // not \s: the shell does not split on NBSP, \f, \v or Unicode spaces
  const all = hooks.whole?.(words) ?? null;
  if (all !== null) return all;
  // A lone & separates commands; 2>&1, >&2 and &> are redirections.
  const parts = plain.split(/(&&|\|\||\$\(|(?<![<>])&(?!>)|[;|\n()`])/);
  for (let i = 0; i < parts.length; i += 2) {
    const toks = parts[i].split(/[ \t]+/).filter(Boolean);
    // npm run <script> -- args, or pnpm/yarn/bun <script>: judge the script text with the args appended.
    const pm = toks.findIndex((t) => PMS.has(runnerName(t)));
    if (pm >= 0) {
      let j = pm + 1;
      let dir = w.root;
      while (toks[j]?.startsWith('-')) {
        const eq = /^(--prefix|--dir|-C)=(.*)$/.exec(toks[j]);
        if (eq) dir = resolve(w.root, eq[2] || '.');
        else if (['--prefix', '-C', '--dir'].includes(toks[j])) dir = resolve(w.root, toks[++j] ?? '.');
        j++;
      }
      if (['run', 'run-script', 'rum', 'urn'].includes(toks[j])) j++;
      const scripts = scriptsOf(dir);
      const name = scripts[toks[j] ?? ''] !== undefined ? toks[j] : NPM_ALIAS[toks[j] ?? ''] ?? toks[j] ?? '';
      const args = toks.slice(j + 1).filter((t) => t !== '--').join(' ');
      // npm also runs pre<name> and post<name>.
      const bodies = [`pre${name}`, name, `post${name}`].filter((n) => typeof scripts[n] === 'string').map((n) => `${scripts[n]}${n === name ? ` ${args}` : ''}`);
      if (bodies.length && depth >= 3) {
        if (hooks.tooDeep !== undefined) return hooks.tooDeep;
      } else for (const b of bodies) {
        const r = walkCommands(b, w, visit, hooks, depth + 1) ?? hooks.script?.(b) ?? null;
        if (r !== null) return r;
      }
    }
    const r = visit({ toks, k: commandStart(toks), prev: parts[i - 1], next: parts[i + 1], words });
    if (r !== null) return r;
  }
  return null;
}

/** The person-only rules for one segment: a harness token in command position, or a person-only word after a hidden command. */
function personOnlyVisit(w: Where): Visit<Hit> {
  const hit = (name: string, tok: string): Hit => ({ kind: PERSON_ONLY[name].kind, reason: PERSON_ONLY[name].why((sub) => terminalCommand(tok, sub, w)) });
  const hidden: Hit = { kind: 'deny', reason: ANY_WHY };
  // The harness token at toks[k]: which person-only subcommand it runs, if any. `next` is the separator after it.
  const judge = (toks: string[], k: number, next: string | undefined): Hit | null => {
    const rest = toks.slice(k + 1);
    if (rest[0]?.startsWith('-')) { // no global flags in M1, so flag values cannot be told apart from subcommands
      for (const name of Object.keys(PERSON_ONLY)) {
        const t = rest.indexOf(name);
        if (t >= 0 && !passes(name, rest.slice(t + 1), next)) return hit(name, toks[k]);
      }
    }
    const s = rest.findIndex((t) => !t.startsWith('-'));
    // `xargs harness` with no written subcommand: the words come from stdin.
    if (s < 0) return /^(\$\(|\(|`)$/.test(next ?? '') ? hidden : toks.slice(0, k).some((t) => runnerName(t) === 'xargs') ? { kind: 'ask', reason: BUILT } : null;
    if (/[$`]/.test(rest[s])) return /^\$[@*0-9]$/.test(rest[s]) ? { kind: 'ask', reason: BUILT } : hidden; // "$@", $*, $1: the caller's words
    // A brace, glob or character class the shell expands into the subcommand: `tdd off` shaped is denied, the rest asks.
    if (/[{*?[]/.test(rest[s])) return rest[s + 1] === 'off' ? hit('tdd', toks[k]) : { kind: 'ask', reason: BUILT };
    if (isPersonOnly(rest[s]) && !passes(rest[s], rest.slice(s + 1), next)) return hit(rest[s], toks[k]);
    return null;
  };
  return ({ toks, k, prev, next }) => {
    // $X tdd …, `…` tdd … or $(…) tdd …: the command name is hidden in a variable or substitution.
    // Whatever the hidden command is, the allowed arguments stay allowed.
    const at = toks[k]?.startsWith('$') && !HARNESS_CMD.test(toks[k]) ? k + 1 : k === 0 && /^[`)]$/.test(prev ?? '') ? 0 : -1;
    if (at >= 0 && isPersonOnly(toks[at]) && !passes(toks[at], toks.slice(at + 1), next)) return hidden;
    // A glob in the CLI path (dist/cli.mj?) is expanded by the shell: judge it as the harness CLI.
    // `function harness { … }` defines a harness that runs something else, like the `harness() { … }` form (caught at the `(` above).
    if (toks[k] === 'function' && toks[k + 1] && HARNESS_CMD.test(toks[k + 1])) return hidden;
    if (!toks[k] || !(HARNESS_CMD.test(toks[k]) || (/[*?[]/.test(toks[k]) && CLI_RE.test(toks[k])))) return null;
    return judge(toks, k, next);
  };
}
// Backstop: the parser reads words, but the shell has more ways to hide a command (globs, renamed copies, comments,
// redirections, odd whitespace). Text that names harness or its CLI and a word that changes things asks, unless the parser
// saw every such segment as a plain harness command and the text is clean.
const CLI_RE = /cli\.[m*?[]|c[*?]\S*\.m/i;
const CHANGE = /(?<![\w-])(init|update|add|remove|sync|uninstall|push|pr|apply)(?![\w-])/i;
const TDD_OFF = /(?<![\w-])tdd\W+off(?![\w-])/i;
const NORM = (t: string): string => joinAll(t).replace(/['"\\]/g, '');
// `harness` counts as a command word (or a bare word), never as part of a directory in a path: `cd /x/harness && git push` is a push.
function names(text: string): boolean {
  if (CLI_RE.test(text)) return true;
  for (const seg of text.split(SEGMENTS)) {
    const toks = seg.split(/[ \t]+/).filter(Boolean);
    const k = commandStart(toks);
    if (toks.some((t, i) => /harness/i.test(t) && (!t.includes('/') || i === k))) return true;
  }
  return false;
}
const UNCLEAN = /[{}*?[#<>]|[^\S \t]/;
export const SEGMENTS = /&&|\|\||\$\(|(?<![<>])&(?!>)|[;|\n()`]/;
function previewOnly(text: string, depth = 0): boolean {
  text = text.split('${CLAUDE_PLUGIN_ROOT}').join('PLUGIN_ROOT'); // the one expansion the skills use
  if (UNCLEAN.test(text)) return false;
  // A -c payload is judged on its own; what is left outside it is judged as before.
  const pays = depth < 3 ? cPayloads(text) : [];
  if (pays.length && !pays.every((p) => previewOnly(p, depth + 1))) return false;
  for (const p of pays) text = text.split(p).join('');
  const plain = grouped(text, false);
  if (plain.split(/[ \t]+/).some((t) => RESERVED.has(t))) return false;
  for (const seg of plain.split(SEGMENTS)) {
    if (!CHANGE.test(seg)) continue;
    const toks = seg.split(/[ \t]+/).filter(Boolean);
    const k = commandStart(toks);
    if (!toks[k] || !HARNESS_CMD.test(toks[k])) return false;
  }
  return true;
}
// The one word right after `harness vet` (or `cli.mjs" vet`) is a target, not a subcommand: o/sync names a repo. Target characters
// only, ended by a space, a redirect or the end, so `vet x;harness sync` is not hidden.
const VET_TARGET = /((?:harness|cli\.mjs)["']?[ \t]+vet[ \t]+)[\w.@:/#-]+(?=[\s>]|$)/gi;
const FUNC_DEF = /\bfunction\b|\(\s*\)\s*\{/;
function backstop(raw: string): Hit | null {
  raw = joinAll(raw);
  const norm = NORM(raw); // `in''it` and `in\it` are init
  if (!names(norm)) return null;
  // Only words: a real `harness tdd off` the parser saw was denied before this. Prose, echo, grep, a commit message or a forwarding function asks.
  if (TDD_OFF.test(raw) || TDD_OFF.test(norm)) return { kind: 'ask', reason: 'the command names harness and `tdd off`, and the guard cannot tell that it does not run it. Only a person can pause TDD, in their own terminal' };
  // A function defined anywhere can forward the masked word (`function harness { command harness "$2"; }`): mask nothing then.
  const t = (s: string) => (FUNC_DEF.test(s) ? s : s.replace(VET_TARGET, '$1T'));
  if (!(CHANGE.test(t(raw)) || CHANGE.test(t(norm))) || previewOnly(raw)) return null;
  return { kind: 'ask', reason: 'the command names harness and a word that changes it (init, update, add, remove, sync, uninstall, push, pr, apply), and the guard cannot tell that it is only a preview' };
}
const unquote = (t: string) => t.replace(/^['"]|['"]$/g, '');

// Long names (no leading dot) whose Win32 8.3 short name could stand for a protected file or dir.
const SHORT_STEMS = ['env', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'credentials', 'netrc', 'pgpass', 'ssh', 'gnupg', 'aws'];
// ponytail: 8.3 names can't be mapped back exactly (Windows hashes them after a few collisions), so any `~<digit>`
// segment whose stem could be the start of a protected name is denied; a false deny needs a short-name path.
function shortNameOfProtected(seg: string): boolean {
  const m = /^([^~]{1,6})~\d+(?:\.([^.]{1,3}))?$/.exec(seg);
  if (!m) return false;
  if (m[2] && ['tfs', 'tfv', 'key', 'pem', 'p12', 'pfx'].includes(m[2])) return true;
  const stem = /^..[0-9a-f]{4}$/.test(m[1]) ? m[1].slice(0, 2) : m[1]; // hashed form: 2 chars of the name, then 4 hex
  return SHORT_STEMS.some((s) => s.startsWith(stem) || stem.startsWith(s));
}

const sensitivePath = (p: string): boolean => {
  if (!p || !/[.~]|id_/i.test(p)) return false; // every rule below needs a dot, a `~` or id_ (round 28: most words have none)
  // Backslashes as separators: Windows paths (C:\proj\...) must match the same rules. Lowercase: macOS and Windows file
  // systems ignore case. A leading `host:` (scp) or `C:` (Win32 drive-relative) hides the real path, so the part after
  // it is checked too.
  const raw = String(p).replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/^~(?=\/|$)/, '$HOME').toLowerCase();
  const afterColon = /^[^/]*?:/.test(raw) ? raw.replace(/^[^/]*?:/, '') : null;
  return [raw, ...(afterColon !== null ? [afterColon] : [])].some(sensitiveForm);
};

function sensitiveForm(form: string): boolean {
  // Per segment: drop an NTFS stream (`x::$DATA`) and the trailing dots and spaces Win32 strips (`x.` opens `x`).
  const segs = form.split('/').map((seg, i) => (i === 0 && /^[a-z]:$/.test(seg) ? seg : seg.replace(/:.*$/, '').replace(/[. ]+$/, '')));
  if (segs.some(shortNameOfProtected)) return true;
  const s = segs.join('/');
  const base = segs[segs.length - 1] ?? '';
  if (/^\.env(\..+)?$/.test(base)) return !SAFE_EXAMPLE.test(base);
  if (/(^|\/)\.(ssh|gnupg)\//.test(s) && !/\.pub$/.test(base)) return true;
  if (/(^|\/)\.aws\/(credentials|config)$/.test(s)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)$/.test(base)) return true;
  if (/\.(pem|p12|pfx|keystore)$/i.test(base)) return true;
  if (/^\.(netrc|pgpass)$/.test(base)) return true;
  if (/\.tfstate(\..+)?$/.test(base) || /\.tfvars$/.test(base)) return true;
  return false;
}

const DENY: [RegExp, string][] = [
  [/\bgit\s+push\b(?:(?!\bgit\s+push\b)[^;&|\n])*(\s--force(?!-with-lease)(?=[\s=;&|)}`]|$)|\s-f(?=[\s;&|)}`]|$))/, 'force push (use --force-with-lease, and only on your own branch)'],
  [/\b(curl|wget)\b(?:(?!\b(?:curl|wget)\b)[^|\n])*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, 'piping a download straight into a shell'],
  [/\bchmod\b(?:(?!\bchmod\b)[^;&|\n])*\b0?777\b/, 'chmod 777'],
  [/\bdd\b(?:(?!\bdd\b)[^;&|\n])*\bof=\/dev\//, 'writing to a block device'],
];

const ASK: [RegExp, string][] = [
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard discards local changes'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean deletes untracked files'],
  [/\bgit\s+(?:(?:-[Cc]\s+\S+|--\S+)\s+)*(checkout|restore)\s+(--\s+)?\.(?=[\s;&|)}`]|$)/, 'discarding all working-tree changes'],
  [/\bgit\s+branch\s+-D\b/, 'force-deleting a branch'],
  [/(^|[;&|]\s*)sudo\b/, 'sudo'],
  [/\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/, 'publishing a package'],
  [/\bcdk\s+(destroy|deploy)\b/, 'CDK deploy or destroy'],
  [/\bterraform\s+(destroy|apply)\b/, 'Terraform apply or destroy'],
  [/\baws\b(?:(?!\baws\b)[^;&|\n])*\b(delete|terminate|remove|rb)\b/, 'destructive AWS CLI call'],
  [/\baws\s+s3\s+rm\b(?:(?!\baws\s+s3\s+rm\b)[^;&|\n])*--recursive/, 'recursive S3 delete'],
  [/\bkubectl\s+delete\b/, 'kubectl delete'],
  [/\bdocker\s+(system|volume|image)\s+prune\b/, 'docker prune'],
  [/\bgh\s+(repo|release)\s+delete\b/, 'deleting a GitHub repo or release'],
  [/\bvercel\b(?:(?!\bvercel\b)[^;&|\n])*--prod\b/, 'production deploy'],
  [/\bdrop\s+(table|database|schema)\b/i, 'SQL DROP'],
];

/** A subshell or substitution closing right after a word: `(rm -rf /)`, `(git push origin main)`. Not `}`: it ends a brace word. */
const CLOSERS = /[)`]+$/;
export const rmTargets = (cmd: string): { recursive: boolean; targets: string[]; fed: boolean }[] =>
  // A backtick opens a command too (`rm -rf /`), and rm may be spelled as a path (`xargs /bin/rm -rf`).
  [...cmd.matchAll(/(?:^|[;&|(`]\s*|\s)(?:[\w.~-]*\/)*rm\s+([^;&|\n]*)/g)].map((m) => {
    const toks = m[1].trim().split(/\s+/).filter(Boolean);
    const flags = toks.filter((t) => t.startsWith('-')).join('');
    const before = cmd.slice(0, m.index + m[0].length - m[1].length);
    // A closer ends a group opened before rm, as in `(rm -rf /)`; one in rm's own words (-$(cat tmp)) is part of a target.
    // A backtick is its own closer, so only an opener before the trailing closers counts as rm's own (`rm -rf /`).
    const closesOuter = !/[(`]/.test(m[1].trimEnd().replace(CLOSERS, '')) && /[(`]/.test(before);
    // `xargs … rm` in the same simple command: rm's targets come from stdin.
    const fed = /(?:^|[\s;&|(`])(?:xargs|parallel)(?![\w.-])[^;&|\n]*$/.test(before);
    return { recursive: /-[a-zA-Z]*[rR]|--recursive/.test(flags), targets: toks.filter((t) => !t.startsWith('-')).map((t) => unquote(closesOuter ? t.replace(CLOSERS, '') : t)), fed };
  });

// rimraf and del-cli delete recursively, like rm -rf: run through a package runner (npx, pnpm/yarn dlx, bunx, bun x,
// npm exec/x, pnpx) anywhere, or as the command word itself (a path to it reads as its name in the plain-head reading).
// Runner options may come before the subcommand too (`pnpm -s dlx`, `yarn --silent dlx`, `bun --bun x`), and pnpm and
// yarn run a local bin with `exec` or by its bare name (`pnpm rimraf`, `yarn rimraf`).
const RUN_OPT = String.raw`(?:\s+-{1,2}[\w-]+(?:=\S*)?)*`;
const RIMRAF_RUN = new RegExp(String.raw`(?:^|(?<=[\s;&|(` + '`' + String.raw`]))(?:npx|bunx|pnpx|(?:pnpm|yarn)${RUN_OPT}(?:\s+(?:dlx|exec))?|bun${RUN_OPT}\s+x|npm${RUN_OPT}\s+(?:exec|x))${RUN_OPT}(?:\s+--)?\s+['"]?(?:rimraf|del-cli)(?:@[^\s'"]*)?['"]?(?=\s|$)`, 'g');
const RIMRAF_HEAD = /(^|[;&|(`]\s*)rimraf(?:@\S*)?(?=\s|$)/g;
const rimrafAsRm = (t: string): string => (/rimraf|del-cli/.test(t) ? t.replace(RIMRAF_RUN, ' rm -rf').replace(RIMRAF_HEAD, '$1rm -rf') : t);
const checkRm = (cmd: string): Verdict | undefined => {
  for (const { recursive, targets, fed } of rmTargets(cmd)) {
    if (!recursive) continue;
    if (fed && !targets.length) return ['ask', 'recursive delete of paths read from stdin (xargs), which the guard cannot see'];
    // Windows too: a drive root (C:\, C:/, Git Bash's /c/) and the user profile.
    if (targets.some((t) => /^(\/|~|\$HOME|\/\*|~\/\*|\.|\.\.|\*|\.\/\*|[a-zA-Z]:[\\/]?\*?|\/[a-zA-Z]\/?\*?|\$USERPROFILE|%USERPROFILE%)$/.test(t))) return ['deny', 'recursive delete of root, home, current or parent directory'];
    if (!targets.every((t) => SAFE_RM_TARGETS.test(t))) return ['ask', 'recursive delete outside build and cache folders'];
  }
  return undefined;
};

const checkPushToMain = (cmd: string): Verdict | undefined => {
  for (const m of cmd.matchAll(/\bgit\s+push\b([^;&|\n]*)/g)) {
    const refs = m[1].trim().split(/\s+/).filter((t) => t && !t.startsWith('-')).flatMap((t) => t.replace(CLOSERS, '').split(':'));
    if (refs.some((r) => /^(refs\/heads\/)?(main|master)$/.test(r))) return ['deny', 'pushing to main or master (open a pull request from a branch instead)'];
  }
  return undefined;
};

// Package names an install command would add. Flags (with their values) may come before the
// subcommand, as in "pnpm --filter web add zod". Redirections, local paths and requirement files
// are not packages, so restoring from a lockfile adds nothing.
const addedPackages = (args: string, subcommands: Set<string>, valueFlags: Set<string>): string[] => {
  const toks = args.replace(REDIRECTION, ' ').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const skipFlags = () => {
    while (toks[i]?.startsWith('-')) i += valueFlags.has(toks[i]) ? 2 : 1;
  };
  skipFlags();
  if (toks[i] === 'pip') {
    i += 1; // "uv pip install"
    skipFlags();
  }
  if (!subcommands.has(toks[i])) return [];
  const names: string[] = [];
  for (i += 1; i < toks.length; i += 1) {
    if (valueFlags.has(toks[i])) i += 1;
    else if (!/^[-./~]/.test(toks[i])) names.push(toks[i]);
  }
  return names;
};

const checkInstall = (cmd: string, ctx: GuardCtx): Decision | undefined => {
  const js: string[] = [];
  const py: string[] = [];
  for (const m of cmd.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+([^;&|\n]*)/g)) js.push(...addedPackages(m[1], JS_ADD, VALUE_FLAGS));
  for (const m of cmd.matchAll(/\b(?:pip3?|uv)\s+([^;&|\n]*)/g)) py.push(...addedPackages(m[1], PY_ADD, PIP_VALUE_FLAGS));
  const found = [...js, ...py];
  if (found.length === 0) return undefined;
  const what = `adding dependency ${found.slice(0, 3).join(', ')}`;
  if (ctx.env.AGENT_GUARD_ALLOW_INSTALL === '1') {
    if (ctx.config?.checks.depVerify === false) return { kind: 'ask', reason: `Confirm adding ${found.join(', ')}.`, check: 'guard' };
    // The npm registry knows nothing of PyPI, so only JS names are verified.
    const jsDecision = js.length ? verifyPackages(js, { root: ctx.root, now: new Date(), lookup: ctx.lookup ?? defaultLookup, startedAt: ctx.startedAt }) : undefined;
    if (jsDecision?.kind === 'deny') return jsDecision;
    const reasons = [jsDecision && 'reason' in jsDecision ? jsDecision.reason : '', py.length ? `Confirm adding ${py.join(', ')}.` : ''];
    return { kind: 'ask', reason: reasons.filter(Boolean).join('; '), check: 'dep-verify' };
  }
  return toDecision(['deny', `${what}. Dependencies are added by a human: ask the user to run it`]);
};

// Tokens after "git" and its global options (-C dir, -c k=v, --no-pager, --git-dir=…): [subcommand, ...args].
// ponytail: a space-separated --git-dir X / --work-tree X value is read as the subcommand.
export function gitArgs(toks: string[]): string[] {
  let i = toks.indexOf('git') + 1;
  while (i > 0 && i < toks.length && toks[i].startsWith('-')) i += /^-[Cc]$/.test(toks[i]) ? 2 : 1;
  return i > 0 ? toks.slice(i) : [];
}

// The writers whose options name a file or folder they write, each read with the one getopt reader (core/options.ts):
// clusters, stuck values, `--name=v`, GNU long prefixes where the tool accepts them, single-dash long names.
const CP_OPTS: OptTable = {
  v: 'tSmog', lv: ['target-directory', 'suffix', 'mode', 'owner', 'group', 'strip-program'], lo: ['backup', 'preserve', 'no-preserve', 'sparse', 'reflink', 'context', 'update'],
  lf: ['no-target-directory', 'archive', 'force', 'interactive', 'link', 'dereference', 'no-clobber', 'recursive', 'symbolic-link', 'verbose', 'parents', 'remove-destination', 'strip', 'compare', 'directory', 'relative', 'logical', 'physical', 'no-dereference', 'one-file-system', 'attributes-only', 'copy-contents', 'debug', 'strip-trailing-slashes', 'exchange', 'keep-directory-symlink'],
  prefix: true,
};
const TARGET_DIR = ['-t', '--target-directory'];
/** GNU coreutils and tar under another name (Homebrew's g-prefix, bsdtar): read as the plain tool. */
export const WRITER_ALIAS: Record<string, string> = { gcp: 'cp', gmv: 'mv', gln: 'ln', ginstall: 'install', gtar: 'tar', bsdtar: 'tar', gpatch: 'patch', gsort: 'sort', hub: 'git' };
type Writer = { opts: OptTable; out: readonly string[]; pos?: (p: Parsed) => string[] };
const WRITERS: Record<string, Writer> = {
  curl: { opts: { v: 'oDcdHuxXeAEKbmrTUwYyzt', lv: ['output', 'output-dir', 'dump-header', 'cookie-jar', 'trace', 'trace-ascii', 'stderr', 'etag-save', 'data', 'header', 'user', 'proxy', 'request', 'referer', 'user-agent', 'cookie', 'config', 'max-time', 'range', 'upload-file', 'write-out', 'connect-timeout'] }, // curl takes no abbreviations (curl 8.7)
    out: ['-o', '--output', '--output-dir', '-D', '--dump-header', '-c', '--cookie-jar', '--trace', '--trace-ascii', '--stderr', '--etag-save'] },
  wget: { opts: { v: 'OoaPeUTtQwlAR', lv: ['output-document', 'output-file', 'append-output', 'directory-prefix', 'user-agent', 'tries', 'timeout', 'execute', 'header', 'level', 'accept', 'reject', 'user', 'password'], prefix: true },
    out: ['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix'] },
  sort: { opts: { v: 'oTktS', lv: ['output', 'key', 'field-separator', 'temporary-directory', 'buffer-size', 'parallel', 'files0-from', 'random-source', 'batch-size', 'compress-program'], lo: ['sort', 'check'], lf: ['reverse', 'unique', 'numeric-sort', 'general-numeric-sort', 'human-numeric-sort', 'ignore-case', 'merge', 'stable', 'zero-terminated'], prefix: true }, out: ['-o', '--output'] },
  time: { opts: { v: 'of', lv: ['output', 'format'], lf: ['append', 'verbose', 'portability', 'quiet'], prefix: true }, out: ['-o', '--output'] },
  cp: { opts: CP_OPTS, out: TARGET_DIR },
  mv: { opts: CP_OPTS, out: TARGET_DIR },
  ln: { opts: CP_OPTS, out: TARGET_DIR, pos: (p) => p.pos.slice(-1) }, // without -t, the last word is the link made
  install: { opts: CP_OPTS, out: TARGET_DIR, pos: (p) => p.pos.slice(-1) },
  // -o/-r/-d write; without -o the first positional is patched in place (-i only names the patch).
  patch: { opts: { v: 'BDFiopVYzrdg', lv: ['prefix', 'ifdef', 'fuzz', 'input', 'output', 'strip', 'version-control', 'basename-prefix', 'suffix', 'reject-file', 'directory', 'get', 'quoting-style', 'reject-format'], lo: ['read-only', 'merge'],
    lf: ['batch', 'force', 'silent', 'quiet', 'forward', 'reverse', 'dry-run', 'backup', 'posix', 'binary', 'ignore-whitespace', 'normal', 'context', 'unified', 'ed', 'remove-empty-files', 'set-time', 'set-utc', 'verbose', 'no-backup-if-mismatch', 'backup-if-mismatch', 'follow-symlinks'], prefix: true },
    out: ['-o', '--output', '-r', '--reject-file', '-d', '--directory'], pos: (p) => (valuesOf(p, ['-o', '--output']).length ? [] : p.pos.slice(0, 1)) },
  // xxd [options] [infile [outfile]]: its value options shift the positionals, so they are read, not counted.
  xxd: { opts: { v: 'clsogn', single: ['cols', 'len', 'seek', 'groupsize', 'name', 'offset'], sf: ['ps', 'postscript', 'plain', 'bits', 'include', 'revert', 'autoskip', 'capitalize', 'EBCDIC', 'little-endian', 'uppercase', 'version', 'help'] },
    out: [], pos: (p) => p.pos.slice(1, 2) },
  openssl: { opts: { single: ['out', 'keyout', 'outdir', 'sess_out', 'certout', 'keylogfile', 'respout', 'reqout'], lv: ['out', 'keyout', 'outdir', 'sess_out', 'certout', 'keylogfile', 'respout', 'reqout'] },
    out: ['-out', '-keyout', '-outdir', '-sess_out', '-certout', '-keylogfile', '-respout', '-reqout', '--out', '--keyout', '--outdir', '--sess_out', '--certout', '--keylogfile', '--respout', '--reqout'] },
};
// git: archive and format-patch use git's own parser, which takes an unambiguous long prefix; diff/log/show's --output is exact.
const GIT_WRITERS: Record<string, Writer> = {
  archive: { opts: { v: 'o', lv: ['output', 'format', 'prefix', 'remote', 'exec', 'add-file', 'add-virtual-file', 'mtime'], lf: ['list', 'verbose', 'worktree-attributes'], prefix: true }, out: ['-o', '--output'] },
  'format-patch': { opts: { v: 'ov', lv: ['output-directory', 'start-number', 'subject-prefix', 'to', 'cc', 'in-reply-to', 'signature', 'signature-file', 'suffix', 'base', 'reroll-count', 'interdiff', 'range-diff', 'creation-factor', 'from', 'notes', 'cover-from-description'], prefix: true }, out: ['-o', '--output-directory'] },
  bundle: { opts: { lv: ['version'], lf: ['progress', 'quiet', 'all', 'branches', 'tags'] }, out: [], pos: (p) => (p.pos[0] === 'create' ? p.pos.slice(1, 2) : []) },
  // `git clone <repo> [<dir>]`: the folder made is <dir>, or the repo's own name (`https://x/.harness.git` makes `.harness`).
  clone: { opts: { v: 'obucj', lv: ['origin', 'branch', 'upload-pack', 'template', 'config', 'reference', 'reference-if-able', 'depth', 'shallow-since', 'shallow-exclude', 'separate-git-dir', 'jobs', 'filter', 'bundle-uri', 'server-option', 'ref-format'],
    lo: ['recurse-submodules', 'shallow-submodules'], lf: ['local', 'no-hardlinks', 'shared', 'dissociate', 'quiet', 'verbose', 'progress', 'no-checkout', 'bare', 'mirror', 'single-branch', 'no-single-branch', 'no-tags', 'sparse', 'reject-shallow'], prefix: true },
    out: ['--separate-git-dir'], pos: (p) => [p.pos[1] ?? repoName(p.pos[0] ?? '')] },
};
const GIT_OUTPUT: Writer = { opts: { lv: ['output'] }, out: ['--output'] };
/** The folder `git clone <repo>` makes with no <dir>: the repo's last path part, `.git` dropped. */
const repoName = (r: string): string => r.replace(/[/\\]+$/, '').split(/[/\\:]/).pop()!.replace(/\.git$/, '');
// gh's local writes: downloads into a folder or file, and clones into a folder (gh repo/gist clone <r> [<dir>]).
const GH_LOCAL: Record<string, Writer> = {
  'release download': { opts: { v: 'DOpAR', lv: ['dir', 'output', 'pattern', 'archive', 'repo'], lf: ['clobber', 'skip-existing'] }, out: ['-D', '--dir', '-O', '--output'] },
  'run download': { opts: { v: 'DnpR', lv: ['dir', 'name', 'pattern', 'repo'] }, out: ['-D', '--dir'] },
  'repo clone': { opts: { v: 'u', lv: ['upstream-remote-name'], lf: ['no-upstream'] }, out: [], pos: (p) => p.pos.slice(1, 2) },
  'gist clone': { opts: {}, out: [], pos: (p) => p.pos.slice(1, 2) },
};

/** The files and folders `name` (with its words, from the command name on, unquoted) writes through its options or the
 *  positional the tool writes. */
function writerTargets(name: string, words: string[]): string[] {
  name = WRITER_ALIAS[name] ?? name;
  let w = Object.hasOwn(WRITERS, name) ? WRITERS[name] : undefined, args = withoutRedirects(words.slice(1));
  if (name === 'gh') {
    const [group = '', sub = ''] = readOptions(args, { v: 'R', lv: ['repo', 'hostname'] }).pos, key = `${group} ${sub}`;
    if (!Object.hasOwn(GH_LOCAL, key)) return [];
    [w, args] = [GH_LOCAL[key], args.slice(args.indexOf(sub) + 1)];
  } else if (name === 'git') {
    const [sub, ...rest] = gitArgs(['git', ...words.slice(1)]); // hub reads as git too
    [w, args] = [Object.hasOwn(GIT_WRITERS, sub ?? '') ? GIT_WRITERS[sub!] : GIT_OUTPUT, withoutRedirects(rest)];
  }
  if (!w) return [];
  const p = readOptions(args, w.opts);
  return [...valuesOf(p, w.out), ...(w.pos?.(p) ?? [])].filter(Boolean);
}

/** The destination folder of cp/mv/install/ln's -t/--target-directory (any spelling the getopt reader knows); null when none. */
export const targetDir = (args: string[]): string | null => valuesOf(readOptions(args, CP_OPTS), TARGET_DIR)[0] ?? null;

// Targets of in-place edits and redirections, as written in the command (callers map them with toRepoPath).
// ponytail: splits on ; & | even inside quotes, and ignores here-docs and subshells; upgrade to a real shell parser if bypasses matter.
export function fileWriteTargets(cmd: string): string[] {
  const out: string[] = [];
  const SCRIPT_FLAG = /^-[a-zA-Z]*[ef]$/; // value follows: sed -e SCRIPT, perl -pi -e SCRIPT
  for (const seg of cmd.split(/[;&|\n]+/)) {
    const toks = [...(seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? [])];
    let k = 0;
    while (k < toks.length - 1 && /^(sudo|env|xargs)$|^\w+=/.test(toks[k])) {
      const wrap = toks[k++];
      if (wrap.includes('=')) continue;
      while (toks[k]?.startsWith('-') && k < toks.length - 1) {
        k += (wrap === 'sudo' && /^-[ug]$/.test(toks[k])) || (wrap === 'xargs' && /^-[InPL]$/.test(toks[k])) ? 2 : 1;
      }
    }
    toks.splice(0, k); // look past sudo, env, VAR=value and xargs, with their flags
    const name = commandName(unquote(toks[0] ?? '')); // /usr/bin/time, "sed": the bare command name decides the branch
    for (const m of seg.matchAll(/\d*>>?\s*([^\s;&|>]+)/g)) {
      const t = m[1].replace(/^['"]+/, '').replace(/['"`)}]+$/, ''); // `)`, a backtick or quote ends a substitution ("$(… > f)")
      if (!t.startsWith('&') && t !== '/dev/null') out.push(t);
    }
    // The shell's words from the command name on, so a quoted flag name glued to its value ('--output'=F) is one word.
    const sw = shellWords(seg), at = sw.findIndex((w) => commandName(shellUnquote(w)) === name);
    out.push(...writerTargets(name, (at < 0 ? toks : sw.slice(at)).map(shellUnquote)));
    const c = toks.findIndex((t) => /^-[a-z]*c$/.test(t));
    if ((name === 'bash' || name === 'sh' || name === 'zsh') && c > 0 && toks[c + 1]) {
      out.push(...fileWriteTargets(unquote(toks[c + 1])));
      continue;
    }
    if (name === 'sed' || name === 'perl') {
      const flags = toks.slice(1).filter((t) => t.startsWith('-'));
      if (!flags.some((f) => /^-[a-zA-Z]*i|^--in-place/.test(f))) continue;
      const rest: string[] = [];
      for (let i = 1; i < toks.length; i += 1) {
        if (SCRIPT_FLAG.test(toks[i])) i += 1;
        else if (!toks[i].startsWith('-')) rest.push(toks[i]);
      }
      if (!flags.some((f) => SCRIPT_FLAG.test(f))) rest.shift(); // first positional is the script
      out.push(...rest.map(unquote));
    } else if (name === 'tee') {
      out.push(...toks.slice(1).filter((t) => !t.startsWith('-')).map(unquote));
    } else if (name === 'truncate') {
      for (let i = 1; i < toks.length; i += 1) {
        if (/^(-s|-r|--size|--reference)$/.test(toks[i])) i += 1;
        else if (!toks[i].startsWith('-')) out.push(unquote(toks[i]));
      }
    } else if (name === 'dd') {
      out.push(...toks.filter((t) => t.startsWith('of=')).map((t) => unquote(t.slice(3))));
    } else if (name === 'git') {
      const [sub, ...rest] = gitArgs(toks);
      if (sub === 'checkout') {
        const d = rest.indexOf('--');
        if (d >= 0) out.push(...rest.slice(d + 1).map(unquote));
      } else if (sub === 'restore') out.push(...rest.filter((t) => !t.startsWith('-')).map(unquote));
    }
  }
  return [...new Set(out)];
}

const msg = (v: 'deny' | 'ask', why: string) => (v === 'deny' ? `Blocked by guard: ${why}. If this is intended, ask the user to run it manually.` : `Confirm: ${why}`);
const deny = (why: string): Decision => ({ kind: 'deny', reason: msg('deny', why), check: 'guard' });
const toDecision = (v: Verdict): Decision => (v[0] === 'allow' ? { kind: 'allow' } : { kind: v[0], reason: msg(v[0], v[1]), check: 'guard' });

export function decidePaths(paths: string[]): Decision {
  for (const p of paths) {
    if (sensitivePath(p)) return deny('reading a secrets file (.env, SSH or AWS keys, PEM, Terraform state)');
  }
  return { kind: 'allow' };
}

/** `$IFS` and `${IFS…}` made spaces. A `${IFS` with no `}` after it matches nothing, so the braced form is only tried
 *  up to the last `}`: otherwise each such `${IFS` scans to the end (quadratic; re-review 22b, F4). */
const ifsSpaces = (c: string): string => {
  const k = c.lastIndexOf('}') + 1;
  return c.slice(0, k).replace(/\$(?:IFS(?!\w)|\{IFS(?!\w)[^}]*\})/g, ' ') + c.slice(k).replace(/\$IFS(?!\w)/g, ' ');
};
/**
 * The command as the shell splits it when it uses $IFS: `$IFS` and every `${IFS…}` (`${IFS:0:1}`, `${IFS%?}`,
 * `${IFS[0]}`) become a space (a word separator, or nothing, with the default IFS), and `$1`-`$9`, `$@`, `$*` become
 * nothing (empty in a fresh shell). Null when the command has no $IFS.
 * ponytail: quote-blind, so a quoted "$IFS" is read as a space too; an extra reading only adds hits, never removes one.
 */
export function ifsReading(command: string): string | null {
  if (!/\$\{?IFS(?!\w)/.test(command)) return null;
  return ifsSpaces(command).replace(/\$(?:[1-9@*]|\{[1-9@*]\})/g, '');
}

// Shell constructs that build words the guard cannot read: ${!x}, zsh ${(s:_:)x} ${=x}, ${x//a/b} ${x%a} ${x#a} ${x:…}
// (not the ${IFS…} forms, which ifsReading reads), $'…' and $"…", an IFS= assignment, eval with an expansion, and an
// expansion in command position.
/** A protected harness path named in the text: `.harness`, `.harness/…`, `.claude/settings*.json`. */
export const PROTECTED_TEXT = /\.harness(?![\w.-])|\.claude(?![\w./-])|\.claude[\\/]settings/i;
const BUILDS = /\$\{[!(=~^]|\$\{(?!IFS\W)(?:[^}$]|\$(?!\{))*?[/%#:,^@]|\$['"]|(?<!\w)IFS=/; // , ^ @: bash ${x,,} ${x^^} ${x@E}. A scan stops at the next `${`, which is its own start: linear (re-review 22b, F4)
/** True when the command builds words at run time and names harness or its CLI as a word (never a directory in a path:
 *  `cd /x/harness && …` does not count) or a protected path: the guard asks. ${CLAUDE_PLUGIN_ROOT…} is the skills' own form. */
export function buildsGuardedWords(command: string, w: Where): boolean {
  command = command.replace(/\$\{CLAUDE_PLUGIN_ROOT[^}]*\}/g, 'PLUGIN_ROOT');
  if (!names(NORM(command)) && !PROTECTED_TEXT.test(quoteFree(command))) return false;
  if (BUILDS.test(command) || (/\beval\b/.test(command) && command.includes('$'))) return true;
  return walkCommands(ifsReading(command) ?? command, w, ({ toks, k }) => (toks[k]?.includes('$') && !HARNESS_CMD.test(toks[k]) ? true : null)) ?? false;
}
const BUILDS_WHY = 'the command builds words at run time (a variable in command position, ${!…}, ${…/…}, $\'…\', IFS=, or eval) and names harness or a protected path, so the guard cannot read what it runs';

/** The text the data exemption trusts: no backslash before a newline (in a body too: `EO\` + `F` can be the end
 *  line), no whitespace but space, tab and newline, no `$'`, and every line outside a heredoc body accepted by lexLine,
 *  with heredocs nested at most MAX_NESTING deep. A body is lexed too when it holds a `<<` (a shell may read it, and its
 *  own bodies are exempt there). A body under an unquoted delimiter is data only when no line of it holds a backtick,
 *  `$(`, `${` or `$[` (the shell expands those as it feeds the body; `$NAME` is fine). Other text is decided as strictly
 *  as main decides it (round 22). Round 24: an allowlist, so nothing the lexer does not know can move where a body
 *  starts. Text with no `<<` has no body to find, so it needs no lexing. */
export const canonicalText = (c: string): boolean => (c.includes('<<') ? lexText(c) !== null : !ODD.test(c));
const ODD = /\\\n|[^\S \t\n]|\$'/;
const MAX_NESTING = 2;
/** After a heredoc operator, a substitution, process substitution (`<(`, `>(`, zsh `=(`) or `((` the shell reads across
 *  lines before the body. layout uses it on text that is not canonical, where main's decision is the floor anyway. */
export const SPANS_LINES = /`|\$[({[]|\(\(|[<>=]\(/;
/** What an unquoted delimiter's body expands and runs: a backtick, `$(`, `$((`, `${`, `$[`. */
export const EXPANDS = /`|\$[({[]/;
const HEREDOC_WORD = /-?[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))(?=[ \t;|&<>]|$)/y;
/** One token of a canonical line: blanks; an operator or redirection (`&&`, `||`, `;`, `&`, `|`, `>`, `>>`, `<`, `&>`,
 *  `&>>`, `>&`, and the here-string `<<<`; a digit before one is a word); a quoted string with no opener inside (`\"` escapes in "…", `$NAME` and
 *  `$1` allowed); an escape; `$NAME` or `$1`; or plain word characters. `<<` and `<<-` are read before this. Anything
 *  else (`$(`, `${`, `$[`, `$'`, `$"`, a backtick, `(`, `)`, `{`, `}`, `#`) matches nothing, so the line is refused. */
const LEX = /([ \t]+)|(&&|\|\||&>>?|>>|>&|[;&|<>])|('[^']*'|"(?:[^"\\$`]|\\.|\$(?=\w))*"|\\.|\$(?:[A-Za-z_]\w*|\d))|([^\s'"\\$`;&|<>(){}#]+)/y;
/** Plain words that open a compound command (bash and zsh), and `[[`. */
const OPENS = /^(?:if|case|for|select|while|until|function|coproc|repeat|foreach|\[\[)$/;
/** A heredoc operator on a line: its column, delimiter, `<<-`, and whether the delimiter is quoted. */
type Op = { at: number; word: string; dash: boolean; literal: boolean };
/** The heredocs one line outside a body opens and its quoted spans ([start, end) columns), or null when the line is not
 *  in the canonical grammar. It must end neutral: an open quote or a trailing backslash matches no token. */
export function lexLine(line: string): { ends: Op[]; quotes: [number, number][] } | null {
  if (/[^\S \t]/.test(line)) return null; // CR and other whitespace
  const ends: Op[] = [], quotes: [number, number][] = [];
  let i = 0, piece = false, keyword = false;
  while (i < line.length) {
    let isPiece = false, plain: string | undefined;
    if (line.startsWith('<<<', i) && line[i + 3] !== '<') i += 3; // a here-string: a redirection, its word is lexed next
    else if (line.startsWith('<<', i)) {
      HEREDOC_WORD.lastIndex = i + 2;
      const w = HEREDOC_WORD.exec(line);
      if (!w) return null; // `<<\EOF`, `<<$X`, `<<E"O"F`
      ends.push({ at: i, word: w[1] ?? w[2] ?? w[3], dash: line[i + 2] === '-', literal: w[3] === undefined });
      i = HEREDOC_WORD.lastIndex;
    } else {
      LEX.lastIndex = i;
      const m = LEX.exec(line);
      if (!m) return null;
      isPiece = m[3] !== undefined || m[4] !== undefined;
      if (m[3] && /^['"]/.test(m[3])) quotes.push([i, LEX.lastIndex]);
      plain = m[4];
      i = LEX.lastIndex;
    }
    if (keyword && !isPiece) return null; // a whole plain word that opens a compound command
    keyword = plain !== undefined && !piece && OPENS.test(plain);
    piece = isPiece;
  }
  return keyword ? null : { ends, quotes };
}
type Found = { quotes: [number, number, number][]; heredocs: (Op & { line: number; first: number; last: number })[] };
/** Every line from `from` that is not body text passes lexLine; each body runs to its end line, or to the end as the
 *  shell reads a body with none. Linear: a line is lexed once per level, and past MAX_NESTING levels the answer is no.
 *  `found` collects the top level's quotes and heredocs (line indexes; `last` is the end line, -1 for none). */
function canonicalLines(lines: string[], from: number, level: number, to = lines.length, found?: Found): boolean {
  for (let i = from; i < to; i++) {
    const lx = lexLine(lines[i]);
    if (!lx) return false;
    if (lx.ends.length && level >= MAX_NESTING) return false;
    for (const [s, e] of lx.quotes) found?.quotes.push([i, s, e]);
    let start = i + 1;
    for (const e of lx.ends) {
      let end = start, nested = false, expands = false;
      for (; end < to && (e.dash ? lines[end].replace(/^\t+/, '') : lines[end]) !== e.word; end++) {
        nested ||= lines[end].includes('<<');
        expands ||= !e.literal && EXPANDS.test(lines[end]);
      }
      if (expands || (nested && !canonicalLines(lines, start, level + 1, end))) return false;
      found?.heredocs.push({ ...e, line: i, first: start, last: end < to ? end : -1 });
      start = end + 1;
    }
    i = start - 1;
  }
  return true;
}
/** A top-level heredoc of canonical text, as offsets into it: the operator at `at` on the line starting at `lineStart`;
 *  its body and end line are [from, to), `to` -1 when it has no end line. */
export type LexedHeredoc = { lineStart: number; at: number; word: string; dash: boolean; literal: boolean; from: number; to: number };
let lexed: { c: string; r: { quotes: Quoted[]; heredocs: LexedHeredoc[] } | null } | undefined; // layout asks again for the same text
/** The quoted spans and heredocs of text with a `<<` that canonicalText accepts, as the lexer reads them; null for any
 *  other text. The guard's body layout (guard-readings) and withoutHeredocBodies both take their heredocs from here. */
export function lexText(c: string): { quotes: Quoted[]; heredocs: LexedHeredoc[] } | null {
  if (!c.includes('<<') || ODD.test(c)) return null;
  if (lexed?.c === c) return lexed.r;
  const lines = c.split('\n'), found: Found = { quotes: [], heredocs: [] };
  let r = null;
  if (canonicalLines(lines, 0, 0, lines.length, found)) {
    const starts = [0];
    for (const l of lines) starts.push(starts[starts.length - 1] + l.length + 1);
    r = {
      quotes: found.quotes.map(([l, s, e]) => ({ start: starts[l] + s, end: starts[l] + e, subs: [], line: starts[l] })),
      heredocs: found.heredocs.map((h) => ({ lineStart: starts[h.line], at: starts[h.line] + h.at, word: h.word, dash: h.dash, literal: h.literal,
        from: starts[h.first], to: h.last < 0 ? -1 : Math.min(starts[h.last + 1], c.length) })),
    };
  }
  lexed = { c, r };
  return r;
}
/** The stricter of two decisions: deny, then ask, then allow. */
const strictest = (a: Decision, b: Decision): Decision => (a.kind === 'deny' ? a : b.kind === 'deny' ? b : a.kind === 'ask' ? a : b);

/** How deep shells fed a heredoc nest (`bash <<'A'` holding `bash <<'B'` …), as the readers below find them, in the
 *  text as written and joined. Each level is read again inside the one around it, so the cost climbs with depth. */
export const MAX_SHELL_NESTING = 4;
export function shellNesting(c: string): number {
  let most = 0;
  for (const t of new Set([c, c.replace(JOIN, '$1')])) {
    const opens = new Array<number>(t.split('\n').length + 1).fill(0);
    for (const p of shellPrograms(t)) {
      if (!SHELLS.has(p.name) || !p.lines) continue;
      opens[p.lines[0]]++;
      opens[p.lines[1]]--;
    }
    let depth = 0;
    for (const n of opens) most = Math.max(most, (depth += n));
  }
  return most;
}
export const NESTING_WHY = `shells fed a heredoc nest more than ${MAX_SHELL_NESTING} deep, deeper than the guard reads`;

/** The guard's decision on one Bash command, within one work budget shared with main's reading (re-review 21, P1b):
 *  past it, WorkBudget is thrown and the dispatcher denies. */
export const decideCommand = (command: string, ctx: GuardCtx): Decision => withWorkBudget(() => decideBudgeted(command, ctx));
function decideBudgeted(command: string, ctx: GuardCtx): Decision {
  if (shellNesting(command) > MAX_SHELL_NESTING) return deny(NESTING_WHY); // fail closed, and fast (re-review 19, N8)
  if (canonicalText(command)) return decideNew(command, ctx); // no backslash-newline, so one reading is all of them
  // Odd text gets no data exemption: main's decision path reads it, and the stricter of that and this PR's rules, read
  // with every continuation joined as main joins them, wins. So it is never looser than main, nor than this PR's rules.
  const base = decideBase(command, ctx);
  return base.kind === 'deny' ? base : strictest(base, decideNew(joinAll(command), ctx));
}
function decideNew(joined: string, ctx: GuardCtx): Decision {
  try {
    return decideJoined(joined, ctx);
  } catch (e) {
    if (e instanceof ScanBudget) return toDecision(['ask', SCAN_BUDGET_WHY]);
    throw e;
  }
}
function decideJoined(joined: string, ctx: GuardCtx): Decision {
  const bodiless = commandSkeleton(joined).bodiless;
  // Read three ways and block if any sees the write: the heredoc-stripped reading, the raw line (a `# <<EOF` comment
  // can make the skeleton hide commands as a heredoc body), and the line with quotes and backslashes removed (a lone
  // `'` in a comment desyncs quote tracking otherwise, and `'%B\'>` must not leave an escaped `\>`). Re-review 16, P3/P4.
  const reads = [bodiless, joined, joined.replace(/[\\'"`]/g, '')];
  if (reads.some(writesGitOutputAndRunsFile)) return toDecision(['deny', GIT_OUTPUT_RUN_WHY]);
  if (reads.some(writesGitOutputToSensitivePath)) return toDecision(['deny', GIT_OUTPUT_CONFIG_WHY]);
  return decideAll(joined, ctx, 0);
}
/** Every reading of a command line, the stricter verdict winning: as written, the $IFS one, and command-position globs as ruled names. */
function decideAll(command: string, ctx: GuardCtx, depth: number): Decision {
  const d = decideRead(command, ctx, depth);
  if (d.kind === 'deny') return d;
  const ifs = ifsReading(command);
  const own = ifs === null ? [command] : [command, ifs];
  const globs = own.map(globReadings);
  const rs = [d];
  for (const t of [...own.slice(1), ...globs.flatMap((g) => g.texts)]) {
    const r = decideRead(t, ctx, depth);
    if (r.kind === 'deny') return r;
    rs.push(r);
  }
  if (globs.some((g) => g.capped)) rs.push(toDecision(['ask', GLOB_CAP_WHY]));
  // The plain-head reading: wrappers split off, every path or quoted word read as its name. When a wrapper's option is
  // unknown, two readings bracket what it might consume; the strictest wins, so either reading's deny is a deny and a
  // disagreement that is allow-vs-ask asks. Depth 3: the payloads inside are the same strings the reading as written
  // already judges (with their own plain heads), so they are not re-opened here.
  // Read on the text without its data heredoc bodies: a body nobody runs holds no command, and reading it costs (perf).
  const ph = plainHeads(withoutHeredocBodies(command), GUARDED_HEADS);
  for (const t of ph.texts) {
    const r = decideRead(t, ctx, 3);
    if (r.kind === 'deny') return r;
    rs.push(r);
  }
  if (ph.ask) rs.push(toDecision(['ask', GLOB_HEAD_WHY])); // a glob head that could be a guarded command

  // git runs its editor or pager on the message, so a message built by $(…) or a heredoc may run: ask at least.
  if (EDITOR_SET.test(command) && /\bgit\b/.test(command) && /\$\(|`|<</.test(command)) rs.push(toDecision(['ask', EDITOR_WHY]));
  // A substitution glued inside a word prints what the guard cannot know: read without it, a ruled reading asks.
  const spliced = splicedReading(command);
  if (spliced !== null && decideRead(spliced, ctx, depth).kind !== 'allow') rs.push(toDecision(['ask', SPLICE_WHY]));
  // `${x:-rm}` and the like hold a literal the shell may use: read with it, a ruled reading asks (the value is run-time).
  // Innermost first, a few levels deep (`${x:-${y:-rm}}`); read with every reading, so a path default (`/bin/rm`) and `${IFS}` count.
  let dflt = command;
  for (let n = 0; n < 4 && /\$\{\w+:?[-=+]/.test(dflt); n++) dflt = dflt.replace(/\$\{\w+:?[-=+]([^{}$`]*)\}/g, '$1');
  if (dflt !== command && (depth < 3 ? decideAll(dflt, ctx, depth + 1) : decideRead(dflt, ctx, depth)).kind !== 'allow') rs.push(toDecision(['ask', DEFAULT_WHY]));
  if (shellFedPastHead(withoutHeredocBodies(command))) rs.push(toDecision(['ask', FED_SHELL_WHY]));
  return rs.find((x) => x.kind === 'ask') ?? (buildsGuardedWords(command, ctx) ? toDecision(['ask', BUILDS_WHY]) : d);
}
const GIT_OUTPUT_RUN_WHY = 'the command writes git output (log, show, rev-parse or cat-file) to a file and runs a file, so an earlier commit message could become the script';
const GIT_OUTPUT_CONFIG_WHY = 'the command writes git output (log, show, rev-parse or cat-file) into .git/, a gitconfig or a hook, so an earlier commit message could become git config or a hook';
const EDITOR_WHY = 'the command sets an editor or pager for git (GIT_EDITOR, EDITOR, core.editor, …) and builds its message at run time, and git may run that program on the message';
// Command names the plain reading reads at any word when spelled as a path. Not harness or cli.mjs (they have their own
// path rule), and not a shell or eval: a re-runner counts only where the shell runs it (`git -C /tmp/sh commit -m "…"`
// runs no shell), and a `-c` payload is found wherever it sits.
const GUARDED_HEADS: ReadonlySet<string> = new Set(RULED.filter((n) => !/^(harness|cli\.m?js|eval)$/.test(n) && !SHELLS.has(n)));
const GLOB_HEAD_WHY = 'a glob in a command path could match a guarded command (rm, git, …), so the guard cannot tell what runs';
const GLOB_CAP_WHY = `the command has more glob readings than the guard reads (${MAX_READINGS}), so it cannot tell what runs`;
const SPLICE_WHY = 'a command substitution spliced into a word builds it at run time, and read without it the command hits a guard rule';
const DEFAULT_WHY = 'a word built at run time (${x:-…}, ${x:=…}, ${x:+…}) holds a literal that, read in its place, hits a guard rule';
const FED_SHELL_WHY = 'a download or a here-string reaches a shell behind a word the guard does not know, so it cannot read what the shell runs';
/** A downloaded stream (curl or wget upstream in the pipeline, or inside `<(…)`/`$(…)`) or a here-string reaching a shell
 *  behind a word the guard does not know (`curl x | zzwrap sh`). The shell counts only as the word right after that head
 *  (after a `--`), a plain command word or a glob that can match a shell, so `curl url | grep -c bash` and
 *  `grep -q zsh <<< "$SHELL"` stay allowed. A shell that is the command word is judged already (curl|sh, here-strings). */
function shellFedPastHead(cmd: string): boolean {
  if (!/\b(?:curl|wget)\b|<<</.test(cmd) || !([...SHELLS].some((s) => cmd.includes(s)) || /[*?[]/.test(cmd))) return false;
  const isShell = (w: string): boolean => {
    const u = shellUnquote(w), n = commandName(u);
    if (SHELLS.has(n)) return /^[\w./+-]+$/.test(u);
    const re = globRegex(n);
    return re !== null && [...SHELLS].some((s) => re.test(s));
  };
  const substituted = /(?:<\(|\$\()[^()]*\b(?:curl|wget)\b/.test(cmd); // `sh < <(curl …)`, `sh -c "$(curl …)"`
  let stream = false;
  for (const p of pieces(cmd)) {
    const ws = shellWords(p.text), names = ws.map((w) => commandName(shellUnquote(w)));
    const k = commandStart(ws.map(shellUnquote), (n) => SHELLS.has(n));
    const next = ws[k + 1] === '--' ? k + 2 : k + 1;
    if ((stream || substituted || ws.some((w) => w.startsWith('<<<'))) && ws[next] !== undefined && isShell(ws[next])) return true;
    stream = (stream || names.some((n) => n === 'curl' || n === 'wget')) && p.sep === '|';
  }
  return false;
}

const ANSI_C: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
/** The body of a bash `$'…'` string, decoded: \xHH, \NNN, \uHHHH, \UHHHHHHHH, \n and the other letters. */
export const decodeAnsiC = (s: string): string =>
  s.replace(/\\(x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|[0-7]{1,3}|.)/g, (_, e: string) =>
    /^[xuU]./.test(e) ? String.fromCodePoint(Math.min(parseInt(e.slice(1), 16), 0x10ffff)) : /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ANSI_C[e] ?? e);
/** The text rules' reading: $'…' decoded, $"…" read as "…", quotes taken off a word with no space inside ("push", pu""sh),
 *  and a backslash before a letter, digit or - dropped (g\it). Quoted prose with spaces keeps its quotes. */
export const quoteFree = (c: string): string =>
  c.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_, b: string) => decodeAnsiC(b)).replace(/\$"/g, '"').replace(/(?<!\\)(['"])([^'"\s\\]*)\1/g, '$2').replace(/\\(?=[\w-])/g, '');

function decideRead(command: string, ctx: GuardCtx, depth = 0): Decision {
  const d = decideCore(command, ctx);
  if (d.kind === 'deny') return d;
  const b = backstop(command);
  let own = d.kind === 'allow' && b ? toDecision(['ask', b.reason]) : d;
  if (depth >= 3) return own;
  // A -c payload, a program fed to a shell, or eval's words is a command line of its own, so its quotes do not hide a
  // text rule (sh -c 'git push -f'): judge it too.
  const inner = [
    ...cPayloads(command),
    ...shellPrograms(command).filter((p) => SHELLS.has(p.name)).map((p) => p.text),
    ...[...command.matchAll(/(?<![\w-])eval\s+([^;&|\n]*)/g)].map((m) => m[1].replace(/['"\\]/g, '')),
  ];
  for (const p of inner) {
    const r = decideAll(joinLines(p), ctx, depth + 1); // a shell fed a quoted-delimiter body joins its lines itself
    if (r.kind === 'deny') return r;
    if (r.kind === 'ask' && own.kind === 'allow') own = r;
  }
  return own;
}

function decideCore(command: string, ctx: GuardCtx): Decision {
  if (!command) return { kind: 'allow' };
  const unq = quoteFree(command); // `"git" push`, `g\it push`, `git $'push'`: quotes and escapes hide no text rule
  // The text rules read the command without its data: heredoc bodies nobody runs and quoted -m/--body messages.
  const view = textRulesView(command);
  const vUnq = view === command ? unq : quoteFree(view);
  const git = gitPlain(view);
  const texts = [view, vUnq, git];
  const tokens = `${command} ${unq}`.split(/[\s'"`=<>|;&()]+/).filter(Boolean);
  if (!/\.gitignore\b/.test(command) && tokens.some(sensitivePath)) return deny('touching a secrets file (.env, SSH or AWS keys, PEM, Terraform state)');
  const personOnly = personOnlyInvocation(command, ctx);
  if (personOnly) return personOnly.kind === 'deny' ? { kind: 'deny', reason: personOnly.reason, check: 'guard' } : toDecision(['ask', personOnly.reason]);
  const tddPaths = ctx.config?.checks.tdd ? ctx.config.tdd.paths : [];
  const inTdd = (t: string) => {
    const rel = tddPaths.length > 0 ? toRepoPath(ctx.root, t) : null;
    return rel !== null && matches(rel, tddPaths) ? rel : null;
  };
  for (const { targets } of rmTargets(command)) {
    if (targets.some((t) => { const rel = inTdd(t); return rel !== null && isTestFile(rel); })) return deny('deleting a test file in a TDD path');
  }
  // The quote-free view too: an env -S string's words come back quoted ('rm' '-rf' '/'), and $'\x72m' decodes to rm.
  const early = checkRm(rimrafAsRm(view)) ?? checkRm(rimrafAsRm(vUnq)) ?? checkPushToMain(view) ?? checkPushToMain(vUnq) ?? checkPushToMain(git);
  if (early) return toDecision(early);
  for (const [re, why] of DENY) if (texts.some((t) => re.test(t))) return deny(why);
  if (fileWriteTargets(command).some((t) => inTdd(t) !== null)) {
    return { kind: 'ask', reason: msg('ask', 'shell write into a TDD path; use the Edit or Write tool so the TDD gates see it'), check: 'guard' };
  }
  const install = checkInstall(command, ctx);
  if (install) return install;
  const preset = ctx.config?.preset && /\bgit\b/.test(command) ? walkCommands(command, ctx, presetVisit(command, ctx.config.preset)) : null;
  if (preset) return toDecision(['ask', preset.reason]);
  // gh/hub writes, GitLab push options and refs/remotes writes: found past wrappers and path heads by the walk, read with the getopt reader.
  // The quote-free text too, so a head spelled `g\h`, `"gh"` or `$'\x67h'` is read as gh.
  const ghText = vUnq === command ? command : `${command}\n${vUnq}`;
  if (/\b(?:gh|hub|update-ref|symbolic-ref|remote|fetch|pull)\b|merge_request|insteadof/i.test(ghText)) {
    const visit = ghWriteVisit(command, ctx);
    const gw = walkCommands(command, ctx, visit) ?? (vUnq !== command ? walkCommands(vUnq, ctx, visit) : null);
    if (gw) return gw;
  }
  for (const [re, why] of ASK) if (texts.some((t) => re.test(t))) return toDecision(['ask', why]);
  return { kind: 'allow' };
}

/** A gh or hub command that changes shared state, or a git push with a GitLab merge-request option: the reason to ask. */
// Commands that only read or print their words: a gh/hub word right after one of them is data (`echo gh pr merge`).
const NOT_RUNNERS = new Set(['echo', 'printf', 'man', 'which', 'whereis', 'type', 'grep', 'egrep', 'fgrep', 'rg', 'cat', 'less', 'more', 'head', 'tail', 'help', 'info', 'apropos', 'whatis',
  'alias', 'unalias', 'history', 'file', 'stat', 'ls', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'jq', 'yq', 'tee', 'printenv', 'export', 'set', 'unset', 'read', 'test', '[', 'true', 'false', 'brew', 'npm', 'pnpm', 'yarn', 'pip']);
/** A word as the shell passes it: quotes removed and `$'…'` decoded (`gh $'pr' merge`, `gh pr $'\x6derge'`). */
const plainWord = (t: string): string => (t.startsWith("$'") && t.endsWith("'") ? decodeAnsiC(t.slice(2, -1)) : shellUnquote(t)).replace(/\u0001/g, ' ');
/** A `$` or backtick the shell expands: outside single quotes (double quotes expand), `$'…'` included. Linear, quote-aware. */
function expandsOutsideSingleQuotes(s: string): boolean {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = ''; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '$' || c === '`') return true;
    if (q === '"') { if (c === '"') q = ''; continue; }
    if (c === "'" || c === '"') q = c;
  }
  return false;
}
/** gh/hub commands that are not known reads, hub's git passthrough judged as git, and GitLab merge-request push options. */
const ghWriteVisit = (raw: string, ctx: GuardCtx): Visit<Decision> => {
  // Once per line: a GraphQL query on it may be built at run time. A `$` inside single quotes is literal (GraphQL's own
  // `query($o:String!)`); one outside them (`"$Q"`, `$'…'`, `-F o=$O`), a backtick there, or a newline anywhere is not.
  const built = /\n/.test(raw) || expandsOutsideSingleQuotes(raw);
  return ({ toks, k }) => {
  let at = k, name = runnerName(plainWord(toks[k] ?? ''));
  // A head the guard doesn't know may run gh or hub later in its words (`op run -- gh …`, `direnv exec . gh …`, `zzwrap -q gh …`).
  if (!['gh', 'hub', 'git'].includes(name) && !NOT_RUNNERS.has(name)) {
    const j = toks.findIndex((t, i) => i > k && /^(gh|hub)$/.test(runnerName(plainWord(t))));
    if (j > k) [at, name] = [j, runnerName(plainWord(toks[j]))];
  }
  const args = toks.slice(at + 1).map(plainWord), ask = (why: string | null) => (why ? toDecision(['ask', why]) : null);
  if (name === 'gh') return ask(ghWriteWhy(args, built));
  if (name === 'hub') {
    const first = readOptions(args, { lf: ['help', 'version', 'noop'] }).pos[0] ?? '';
    if (first && !HUB_OWN.has(first)) { const d = decideRead(`git ${args.join(' ')}`, ctx, 3); return d.kind === 'allow' ? null : d; } // hub passes git commands on: `hub push -f` is `git push -f`
    return ask(hubWriteWhy(args, built));
  }
  if (name === 'git') {
    const [sub, ...rest] = gitArgs(['git', ...args]);
    const globals = sub === undefined ? args : args.slice(0, args.length - rest.length - 1);
    return ask((sub === 'push' ? pushOptionWhy(rest) : null) ?? pushConfigWhy(globals, sub, rest) ?? remoteRefWhy(globals, sub, rest));
  }
  return null;
  };
};

const NEW_BRANCH_FLAGS: Record<string, string[]> = {
  checkout: ['-b', '-B', '--orphan'], switch: ['-c', '-C', '--create', '--force-create', '--orphan'], worktree: ['-b', '-B'], // worktree's --orphan is a switch
};
const BRANCH_CREATE_FLAGS = /^(-f|--force|-t|--track(=\S*)?|--no-track|--create-reflog)$/;
const BRANCH_COPY = /^(-c|-C|--copy)$/;
/** The branch a git command creates: `checkout -b|-B|--orphan`, `switch -c|-C|--create|--force-create|--orphan`,
 *  `worktree add -b|-B` (also `--flag=name`, a stuck `-bname` and a cluster `-fb name`), `git branch <name> [<start>]` with only
 *  creation flags (`-d`, `-m`, `--list`, … create nothing), `git branch -c|-C|--copy [<old>] <new>`, and `worktree add
 *  <path>` with no branch flag, `--detach` or commit-ish (git names that branch after the path). */
function newBranch(sub: string | undefined, args: string[]): string | undefined {
  const positional = args.filter((t, i) => !t.startsWith('-') && args[i - 1] !== '--reason'); // worktree's --reason takes a value
  if (sub === 'branch') {
    if (args.some((t) => BRANCH_COPY.test(t))) return args.every((t) => !t.startsWith('-') || BRANCH_COPY.test(t) || /^(-f|--force)$/.test(t)) ? positional.at(-1) : undefined;
    return args.every((t) => !t.startsWith('-') || BRANCH_CREATE_FLAGS.test(t)) ? positional[0] : undefined;
  }
  if (sub === 'worktree' && args[0] !== 'add') return undefined;
  const flags = Object.hasOwn(NEW_BRANCH_FLAGS, sub ?? '') ? NEW_BRANCH_FLAGS[sub!] : [];
  for (const [i, t] of args.entries()) {
    if (flags.includes(t)) return args[i + 1];
    const eq = t.indexOf('=');
    if (t.startsWith('--') && eq > 0 && flags.includes(t.slice(0, eq))) return t.slice(eq + 1);
    if (/^-[a-zA-Z]./.test(t) && flags.includes(t.slice(0, 2))) return t.slice(2);
    if (/^-[a-zA-Z]+$/.test(t) && flags.includes(`-${t.at(-1)}`)) return args[i + 1];
  }
  if (sub === 'worktree' && positional.length === 2 && !args.some((t) => /^(-d|--detach)$/.test(t))) return positional[1].replace(/\/+$/, '').split('/').pop() || undefined;
  return undefined;
}
const AI_TRAILER = /Co-Authored-By:[^\n]*(Claude|noreply@anthropic\.com)|Generated with \[?Claude Code/i;
/** The preset's git asks for one segment whose command word is git (or a path to it): a commit while the command holds
 *  an AI trailer, a new branch without a listed prefix. */
// ponytail: the trailer is matched on the whole command, heredoc bodies included, so `echo "Co-Authored-By: Claude"; git
// commit -m x` asks too, and so does a human co-author named Claude (both accepted); a message from `-F <file>`, an
// editor, a template or a reused commit (`-C`, `--amend --no-edit`) is not visible to the guard at all.
function presetVisit(command: string, preset: NonNullable<NonNullable<GuardCtx['config']>['preset']>): Visit<Hit> {
  return ({ toks, k }) => {
    if (runnerName(toks[k] ?? '') !== 'git') return null;
    const [sub, ...args] = gitArgs(['git', ...toks.slice(k + 1)]);
    if (sub === 'commit' && preset.git.no_ai_trailer && AI_TRAILER.test(command))
      return { kind: 'ask', reason: `the agent is committing with an AI trailer, which the ${preset.id} preset bans` };
    const name = newBranch(sub, args);
    if (!name || preset.git.branch_prefixes.some((p) => name.startsWith(p))) return null;
    return { kind: 'ask', reason: `branch "${name}" has no listed prefix; use one of: ${suggestBranches(preset.git.branch_prefixes, name).join(', ')}` };
  };
}

/** `*.{a,b}` -> [`*.a`, `*.b`], innermost groups first, at most 256 results (the rest is checked unexpanded). */
export function expandBraces(glob: string): string[] {
  let out = [glob];
  for (let round = 0; round < 8; round++) {
    const next: string[] = [];
    let changed = false;
    for (const g of out) {
      const m = /\{([^{}]*)\}/.exec(g);
      if (!m) { next.push(g); continue; }
      changed = true;
      for (const alt of m[1].split(',')) next.push(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length));
    }
    if (!changed || next.length > 256) return changed ? [...out, ...next.slice(0, 256)] : out;
    out = next;
  }
  return out;
}

/** A `harness remember` in command position in any reading: an ask for it is the remember ask, or a deny (never a generic ask). */
const runsRemember = (cmd: string, w: Where): boolean => withWorkBudget(() => walkCommands(cmd, w, ({ toks, k }) => (HARNESS_CMD.test(toks[k] ?? '') && toks[k + 1] === 'remember') || null)) === true;

// Fail closed (final review I1): a command with `harness remember` behind any word but the allowlist's own prefixes
// (an unknown wrapper such as chronic or caffeinate) goes to the remember check, which denies it. Only the readings that
// keep a quoted string as one word, so a commit message or an echoed sentence that names it is not a command.
const viaPrefix = (toks: string[], k: number, j: number): boolean =>
  j === k || (j === k + 1 && (toks[k] === 'node' || toks[k] === 'npx')) || (j === k + 2 && toks[k] === 'npx' && toks[k + 1] === '--no-install');
const remembers: Visit<true> = ({ toks, k }) => toks.some((t, j) => j >= k && HARNESS_CMD.test(t) && toks[j + 1] === 'remember' && !viaPrefix(toks, k, j)) || null;
function wrappedRemember(cmd: string, w: Where, depth = 0): boolean {
  const text = withoutHeredocBodies(joinAll(cmd));
  if ([true, false].some((e) => walkReading(grouped(text, e), w, remembers, {}, depth) === true)) return true;
  const programs = [...cPayloads(text), ...shellPrograms(cmd).filter((p) => SHELLS.has(p.name)).map((p) => p.text)];
  return depth < 3 && programs.some((p) => wrappedRemember(p, w, depth + 1));
}

export const guard: Check = {
  name: 'guard',
  events: ['PreToolUse'],
  failClosed: true,
  pure: true,
  run(ctx) {
    if (ctx.config?.checks.guard === false) return { kind: 'allow' };
    const { tool_name, tool_input = {} } = ctx.input;
    if (isShell(tool_name)) {
      const cmd = String(tool_input.command ?? '');
      const d = decideCommand(cmd, ctx);
      if (d.kind !== 'deny' && withWorkBudget(() => wrappedRemember(cmd, ctx))) return rememberAsk(ctx, cmd);
      if (d.kind === 'ask' && (d.reason.includes(REMEMBER_WHY) || runsRemember(cmd, ctx))) return rememberAsk(ctx, cmd);
      // Harness does not parse PowerShell, so any mention of its own paths needs a person.
      if (tool_name === 'PowerShell' && d.kind === 'allow' && /\.harness|\.claude|\.env/i.test(cmd))
        return { kind: 'ask', reason: 'Harness does not parse PowerShell, so a PowerShell command that names .harness, .claude or .env needs your approval.', check: 'guard' };
      return d;
    }
    if (tool_name === 'Read') return decidePaths([String(tool_input.file_path ?? tool_input.path ?? '')]);
    if (tool_name === 'Grep') {
      // ponytail: each brace alternative is checked as written and with its wildcards dropped; `.e*v` is still missed.
      const globs = expandBraces(String(tool_input.glob ?? ''));
      return decidePaths([String(tool_input.path ?? ''), ...globs, ...globs.map((g) => g.replace(/[*?[\]{}]/g, ''))]);
    }
    return { kind: 'allow' };
  },
};
