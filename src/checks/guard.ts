// Agent guard, ported from fitness-app scripts/agent-hooks/guard.mjs. A seatbelt, not a sandbox.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultLookup, type VerifyOpts, verifyPackages } from './dep-verify.js';
import { readCliPath, trustedCli } from '../core/cli-path.js';
import { cPayloads, SHELLS, stdinPrograms } from '../core/shell-words.js';
import { isTestFile, matches, toRepoPath } from '../core/paths.js';
import { isShell } from '../hooks/edit-target.js';
import { arithmeticTest, gitPlain, globReadings, MAX_READINGS, splicedReading, textRulesView } from './guard-readings.js';
import { Scan, SCAN_BUDGET_WHY, ScanBudget } from './guard-scan.js';
import { commandTests, EDITOR_SET } from './guard-sinks.js';
import type { Check, Ctx } from '../hooks/dispatch.js';
import type { Decision } from '../hooks/types.js';

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
export const runnerName = (t: string): string => t.split(/[\\/]/).pop()!.toLowerCase().replace(/^=/, '').replace(/\.(cmd|ps1|bat|exe)$/, '');
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
const PERSON_ONLY: Record<string, { kind: 'deny' | 'ask'; allowed: (args: string[]) => boolean; why: (run: (sub: string) => string) => string }> = {
  tdd: { kind: 'deny', allowed: (a) => ['on', 'status'].includes(a.filter((t) => !t.startsWith('-'))[0]), why: (run) => `Only a person can pause TDD: run ${run('tdd off')} in your own terminal.` },
  uninstall: { kind: 'ask', allowed: (a) => a.length > 0 && a.every((t) => t === '--dry-run'), why: () => 'the agent is uninstalling the harness, which removes every gate' },
  init: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is installing the harness, which writes its hooks, rules and settings' },
  update: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is updating the harness, which rewrites its hooks, rules and settings' },
  add: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is adding a harness item, which writes its files and settings' },
  remove: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is removing a harness item, which deletes its files and settings' },
  sync: { kind: 'ask', allowed: PREVIEW, why: () => 'the agent is syncing the harness items, which rewrites their files and settings' },
  git: { kind: 'ask', allowed: (a) => a[0] === 'branch' || a[0] === 'commit', why: () => 'the agent is pushing or opening a pull request for the harness changes' },
};
const isPersonOnly = (t: string | undefined): t is string => t !== undefined && Object.hasOwn(PERSON_ONLY, t);
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
      const e = toks.findIndex((x, i) => i > k && /^-(exec|execdir|ok|okdir)$/.test(x));
      if (e < 0) break;
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
 * The command with each data here-document body removed (sinkTest: a body is code unless it goes to a data sink,
 * and a code body stays as command lines). `<<` counts only outside quotes; the delimiter has its quotes taken
 * out (`<<E"O"F` is EOF); `<<-` ignores leading tabs on the end line, `<<` wants the line exactly. If anything is odd (a
 * delimiter with an expansion, a body with no end line) the command is returned whole, so nothing is hidden from the parser.
 */
export function withoutHeredocBodies(cmd: string): string {
  if (!cmd.includes('<<')) return cmd;
  const lines = cmd.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], inArithmetic = arithmeticTest(line);
    out.push(line);
    const ends: { word: string; dash: boolean; data: boolean }[] = [];
    let tests: ReturnType<typeof commandTests> | undefined;
    let quote = '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '\\') c++;
      else if (ch === '<' && line[c + 1] === '<' && line[c + 2] !== '<' && !inArithmetic(c)) {
        let d = c + 2;
        const dash = line[d] === '-';
        if (dash) d++;
        while (line[d] === ' ' || line[d] === '\t') d++;
        let word = '';
        let q = '';
        for (; d < line.length; d++) {
          const x = line[d];
          if (q) { if (x === q) q = ''; else word += x; } else if (x === '"' || x === "'") q = x;
          else if (/[\s;|&<>()]/.test(x)) break;
          else word += x;
        }
        if (q || !/^\w+$/.test(word)) return cmd;
        ends.push({ word, dash, data: (tests ??= commandTests(new Scan(line), false, cmd)).sink(0, c) });
        c = d - 1;
      }
    }
    for (const e of ends) {
      let found = false;
      while (++i < lines.length) {
        if (!e.data) out.push(lines[i]); // a body something runs is command lines
        if ((e.dash ? lines[i].replace(/^\t+/, '') : lines[i]) === e.word) { found = true; break; }
      }
      if (!found) return cmd;
    }
  }
  return out.join('\n');
}

/** One command segment of one reading: `k = commandStart(toks)`, `prev`/`next` the separators around it, `words` all the words of the reading. */
export type Seg = { toks: string[]; k: number; prev?: string; next?: string; words: string[] };
export type Visit<T> = (seg: Seg) => T | null;
/** `whole` sees each reading's words before that reading's segments; readings are interleaved (reading 2's `whole` runs
 *  after reading 1's visits, and payload readings come after all four). `script` sees each package-script body after it
 *  is walked. `tooDeep` is the result for a script body at depth 3 or more; without `tooDeep`, a body at depth 3 or more
 *  is not walked and the walk goes on. */
export interface WalkHooks<T> { whole?: (words: string[]) => T | null; script?: (body: string) => T | null; tooDeep?: T }

/** Walks every command segment of `command` the way the shell could read it; the first non-null result wins. */
export function walkCommands<T>(command: string, w: Where, visit: Visit<T>, hooks: WalkHooks<T> = {}, depth = 0): T | null {
  command = command.replace(/\\\r?\n/g, '');
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
      ? [...cPayloads(command), ...stdinPrograms(whole, (ws) => commandStart(ws, (n) => SHELLS.has(n))).filter((p) => SHELLS.has(p.name)).map((p) => p.text)]
          .reduce<T | null>((hit, p) => hit ?? walkCommands(p, w, visit, hooks, depth + 1), null)
      : null)
  );
}

// Why a harness invocation (in command position) needs the person, or null when the agent may run it.
// ponytail: a wrapper flag value not listed in WRAPPER_VALUE_FLAGS is read as the command, which then isn't harness.
function personOnlyInvocation(command: string, w: Where, depth = 0): Hit | null {
  return walkCommands(command, w, personOnlyVisit(w), {
    // eval re-parses its input, so any eval near a harness token and a person-only subcommand is denied.
    whole: (words) => (words.includes('eval') && words.some(isPersonOnly) && words.some((t) => HARNESS_CMD.test(t.replace(/^\w+=/, ''))) ? { kind: 'deny', reason: ANY_WHY } : null),
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
      for (const [name, rule] of Object.entries(PERSON_ONLY)) {
        const t = rest.indexOf(name);
        if (t >= 0 && !rule.allowed(rest.slice(t + 1))) return hit(name, toks[k]);
      }
    }
    const s = rest.findIndex((t) => !t.startsWith('-'));
    // `xargs harness` with no written subcommand: the words come from stdin.
    if (s < 0) return /^(\$\(|\(|`)$/.test(next ?? '') ? hidden : toks.slice(0, k).some((t) => runnerName(t) === 'xargs') ? { kind: 'ask', reason: BUILT } : null;
    if (/[$`]/.test(rest[s])) return /^\$[@*0-9]$/.test(rest[s]) ? { kind: 'ask', reason: BUILT } : hidden; // "$@", $*, $1: the caller's words
    // A brace, glob or character class the shell expands into the subcommand: `tdd off` shaped is denied, the rest asks.
    if (/[{*?[]/.test(rest[s])) return rest[s + 1] === 'off' ? hit('tdd', toks[k]) : { kind: 'ask', reason: BUILT };
    if (isPersonOnly(rest[s]) && !PERSON_ONLY[rest[s]].allowed(rest.slice(s + 1))) return hit(rest[s], toks[k]);
    return null;
  };
  return ({ toks, k, prev, next }) => {
    // $X tdd …, `…` tdd … or $(…) tdd …: the command name is hidden in a variable or substitution.
    // Whatever the hidden command is, the allowed arguments stay allowed.
    const at = toks[k]?.startsWith('$') && !HARNESS_CMD.test(toks[k]) ? k + 1 : k === 0 && /^[`)]$/.test(prev ?? '') ? 0 : -1;
    if (at >= 0 && isPersonOnly(toks[at]) && !PERSON_ONLY[toks[at]].allowed(toks.slice(at + 1))) return hidden;
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
const CHANGE = /(?<![\w-])(init|update|add|remove|sync|uninstall|push|pr)(?![\w-])/i;
const TDD_OFF = /(?<![\w-])tdd\W+off(?![\w-])/i;
const NORM = (t: string): string => t.replace(/\\\r?\n/g, '').replace(/['"\\]/g, '');
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
  raw = raw.replace(/\\\r?\n/g, '');
  const norm = NORM(raw); // `in''it` and `in\it` are init
  if (!names(norm)) return null;
  // Only words: a real `harness tdd off` the parser saw was denied before this. Prose, echo, grep, a commit message or a forwarding function asks.
  if (TDD_OFF.test(raw) || TDD_OFF.test(norm)) return { kind: 'ask', reason: 'the command names harness and `tdd off`, and the guard cannot tell that it does not run it. Only a person can pause TDD, in their own terminal' };
  // A function defined anywhere can forward the masked word (`function harness { command harness "$2"; }`): mask nothing then.
  const t = (s: string) => (FUNC_DEF.test(s) ? s : s.replace(VET_TARGET, '$1T'));
  if (!(CHANGE.test(t(raw)) || CHANGE.test(t(norm))) || previewOnly(raw)) return null;
  return { kind: 'ask', reason: 'the command names harness and a word that changes it (init, update, add, remove, sync, uninstall, push, pr), and the guard cannot tell that it is only a preview' };
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
  if (!p) return false;
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
  [/\bgit\s+push\b[^;&|\n]*(\s--force(?!-with-lease)(?=[\s=;&|)}`]|$)|\s-f(?=[\s;&|)}`]|$))/, 'force push (use --force-with-lease, and only on your own branch)'],
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, 'piping a download straight into a shell'],
  [/\bchmod\b[^;&|\n]*\b0?777\b/, 'chmod 777'],
  [/\bdd\b[^;&|\n]*\bof=\/dev\//, 'writing to a block device'],
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
  [/\baws\b[^;&|\n]*\b(delete|terminate|remove|rb)\b/, 'destructive AWS CLI call'],
  [/\baws\s+s3\s+rm\b[^;&|\n]*--recursive/, 'recursive S3 delete'],
  [/\bkubectl\s+delete\b/, 'kubectl delete'],
  [/\bdocker\s+(system|volume|image)\s+prune\b/, 'docker prune'],
  [/\bgh\s+(repo|release)\s+delete\b/, 'deleting a GitHub repo or release'],
  [/\bvercel\b[^;&|\n]*--prod\b/, 'production deploy'],
  [/\bdrop\s+(table|database|schema)\b/i, 'SQL DROP'],
];

/** A subshell or substitution closing right after a word: `(rm -rf /)`, `(git push origin main)`. Not `}`: it ends a brace word. */
const CLOSERS = /[)`]+$/;
export const rmTargets = (cmd: string): { recursive: boolean; targets: string[] }[] =>
  [...cmd.matchAll(/(?:^|[;&|(]\s*|\s)rm\s+([^;&|\n]*)/g)].map((m) => {
    const toks = m[1].trim().split(/\s+/).filter(Boolean);
    const flags = toks.filter((t) => t.startsWith('-')).join('');
    // A closer ends a group opened before rm, as in `(rm -rf /)`; one in rm's own words (-$(cat tmp)) is part of a target.
    const closesOuter = !/[(`]/.test(m[1]) && /[(`]/.test(cmd.slice(0, m.index + m[0].length - m[1].length));
    return { recursive: /-[a-zA-Z]*[rR]|--recursive/.test(flags), targets: toks.filter((t) => !t.startsWith('-')).map((t) => unquote(closesOuter ? t.replace(CLOSERS, '') : t)) };
  });

const checkRm = (cmd: string): Verdict | undefined => {
  for (const { recursive, targets } of rmTargets(cmd)) {
    if (!recursive) continue;
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
    const name = toks[0];
    for (const m of seg.matchAll(/\d*>>?\s*([^\s;&|>]+)/g)) {
      const t = m[1].replace(/^['"]+/, '').replace(/['"}]+$/, '');
      if (!t.startsWith('&') && t !== '/dev/null') out.push(t);
    }
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
    } else if (name === 'ln' || name === 'install') {
      const args = toks.slice(1).filter((t) => !t.startsWith('-'));
      const tf = toks.indexOf('-t');
      if (name === 'install' && tf > 0 && toks[tf + 1]) out.push(unquote(toks[tf + 1]));
      else if (args.length) out.push(unquote(args[args.length - 1]));
    } else if (name === 'cp') {
      const tf = toks.indexOf('-t');
      if (tf > 0 && toks[tf + 1]) out.push(unquote(toks[tf + 1]));
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

/**
 * The command as the shell splits it when it uses $IFS: `$IFS` and every `${IFS…}` (`${IFS:0:1}`, `${IFS%?}`,
 * `${IFS[0]}`) become a space (a word separator, or nothing, with the default IFS), and `$1`-`$9`, `$@`, `$*` become
 * nothing (empty in a fresh shell). Null when the command has no $IFS.
 * ponytail: quote-blind, so a quoted "$IFS" is read as a space too; an extra reading only adds hits, never removes one.
 */
export function ifsReading(command: string): string | null {
  if (!/\$\{?IFS(?!\w)/.test(command)) return null;
  return command.replace(/\$(?:IFS(?!\w)|\{IFS(?!\w)[^}]*\})/g, ' ').replace(/\$(?:[1-9@*]|\{[1-9@*]\})/g, '');
}

// Shell constructs that build words the guard cannot read: ${!x}, zsh ${(s:_:)x} ${=x}, ${x//a/b} ${x%a} ${x#a} ${x:…}
// (not the ${IFS…} forms, which ifsReading reads), $'…' and $"…", an IFS= assignment, eval with an expansion, and an
// expansion in command position.
/** A protected harness path named in the text: `.harness`, `.harness/…`, `.claude/settings*.json`. */
export const PROTECTED_TEXT = /\.harness(?![\w.-])|\.claude(?![\w./-])|\.claude[\\/]settings/i;
const BUILDS = /\$\{[!(=~^]|\$\{(?!IFS\W)[^}]*?[/%#:,^@]|\$['"]|(?<!\w)IFS=/; // , ^ @: bash ${x,,} ${x^^} ${x@E}
/** True when the command builds words at run time and names harness or its CLI as a word (never a directory in a path:
 *  `cd /x/harness && …` does not count) or a protected path: the guard asks. ${CLAUDE_PLUGIN_ROOT…} is the skills' own form. */
export function buildsGuardedWords(command: string, w: Where): boolean {
  command = command.replace(/\$\{CLAUDE_PLUGIN_ROOT[^}]*\}/g, 'PLUGIN_ROOT');
  if (!names(NORM(command)) && !PROTECTED_TEXT.test(quoteFree(command))) return false;
  if (BUILDS.test(command) || (/\beval\b/.test(command) && command.includes('$'))) return true;
  return walkCommands(ifsReading(command) ?? command, w, ({ toks, k }) => (toks[k]?.includes('$') && !HARNESS_CMD.test(toks[k]) ? true : null)) ?? false;
}
const BUILDS_WHY = 'the command builds words at run time (a variable in command position, ${!…}, ${…/…}, $\'…\', IFS=, or eval) and names harness or a protected path, so the guard cannot read what it runs';

export function decideCommand(command: string, ctx: GuardCtx): Decision {
  try {
    return decideAll(command.replace(/\\\r?\n/g, ''), ctx, 0); // a backslash-newline joins the lines for the shell
  } catch (e) {
    if (e instanceof ScanBudget) return toDecision(['ask', SCAN_BUDGET_WHY]);
    throw e;
  }
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
  // git runs its editor or pager on the message, so a message built by $(…) or a heredoc may run: ask at least.
  if (EDITOR_SET.test(command) && /\bgit\b/.test(command) && /\$\(|`|<</.test(command)) rs.push(toDecision(['ask', EDITOR_WHY]));
  // A substitution glued inside a word prints what the guard cannot know: read without it, a ruled reading asks.
  const spliced = splicedReading(command);
  if (spliced !== null && decideRead(spliced, ctx, depth).kind !== 'allow') rs.push(toDecision(['ask', SPLICE_WHY]));
  return rs.find((x) => x.kind === 'ask') ?? (buildsGuardedWords(command, ctx) ? toDecision(['ask', BUILDS_WHY]) : d);
}
const EDITOR_WHY = 'the command sets an editor or pager for git (GIT_EDITOR, EDITOR, core.editor, …) and builds its message at run time, and git may run that program on the message';
const GLOB_CAP_WHY = `the command has more glob readings than the guard reads (${MAX_READINGS}), so it cannot tell what runs`;
const SPLICE_WHY = 'a command substitution spliced into a word builds it at run time, and read without it the command hits a guard rule';

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
    ...stdinPrograms(command, (ws) => commandStart(ws, (n) => SHELLS.has(n))).filter((p) => SHELLS.has(p.name)).map((p) => p.text),
    ...[...command.matchAll(/(?<![\w-])eval\s+([^;&|\n]*)/g)].map((m) => m[1].replace(/['"\\]/g, '')),
  ];
  for (const p of inner) {
    const r = decideAll(p, ctx, depth + 1);
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
  const early = checkRm(view) ?? checkPushToMain(view) ?? checkPushToMain(vUnq) ?? checkPushToMain(git);
  if (early) return toDecision(early);
  for (const [re, why] of DENY) if (texts.some((t) => re.test(t))) return deny(why);
  if (fileWriteTargets(command).some((t) => inTdd(t) !== null)) {
    return { kind: 'ask', reason: msg('ask', 'shell write into a TDD path; use the Edit or Write tool so the TDD gates see it'), check: 'guard' };
  }
  const install = checkInstall(command, ctx);
  if (install) return install;
  for (const [re, why] of ASK) if (texts.some((t) => re.test(t))) return toDecision(['ask', why]);
  return { kind: 'allow' };
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
