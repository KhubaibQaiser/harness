// Agent guard, ported from fitness-app scripts/agent-hooks/guard.mjs. A seatbelt, not a sandbox.
import { isTestFile, matches, toRepoPath } from '../core/paths.js';
import type { Check, Ctx } from '../hooks/dispatch.js';
import type { Decision } from '../hooks/types.js';

type GuardCtx = Pick<Ctx, 'config' | 'env' | 'root'>;
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
const RUNNERS = new Set(['npx', 'pnpm', 'exec', 'yarn', 'bunx', 'node', 'sudo', 'env', 'eval', 'bash', 'sh', 'zsh']);
const HARNESS_CMD = /(^|\/)harness(@\S+)?$|(^|\/)cli\.m?js$/;
const TDD_OFF_WHY = 'Only a person can pause TDD: run "harness tdd off" in your own terminal.';
// Allowlist: a harness invocation (in command position) may only run `tdd on` or `tdd status`.
// ponytail: runner flag values (pnpm --filter x) are not understood; `harness` after one is missed.
function tddInvocationDenied(command: string): boolean {
  const plain = command.replace(/['"\\]/g, ''); // quotes and escapes must not hide the words
  const words = plain.split(/\s+/);
  // eval re-parses its input, so any eval near a harness token and tdd is denied.
  if (words.includes('eval') && words.includes('tdd') && words.some((t) => HARNESS_CMD.test(t.replace(/^\w+=/, '')))) return true;
  // A lone & separates commands; 2>&1, >&2 and &> are redirections.
  const parts = plain.split(/(&&|\|\||\$\(|(?<![<>])&(?!>)|[;|\n()`])/);
  for (let i = 0; i < parts.length; i += 2) {
    const toks = parts[i].trim().split(/\s+/).filter(Boolean);
    let k = 0;
    while (k < toks.length && (RUNNERS.has(toks[k]) || toks[k].startsWith('-') || /^\w+=/.test(toks[k]))) {
      const val = toks[k].replace(/^\w+=/, '');
      if (val !== toks[k] && HARNESS_CMD.test(val)) { toks[k] = val; break; } // CMD="harness tdd off"
      k += 1;
    }
    // $X tdd …, `…` tdd … or $(…) tdd …: the command name is hidden in a variable or substitution.
    if ((toks[k]?.startsWith('$') && toks[k + 1] === 'tdd') || (k === 0 && toks[0] === 'tdd' && /^[`)]$/.test(parts[i - 1] ?? ''))) return true;
    if (!toks[k] || !HARNESS_CMD.test(toks[k])) continue;
    const rest = toks.slice(k + 1);
    if (rest[0]?.startsWith('-')) { // no global flags in M1, so flag values cannot be told apart from subcommands
      const t = rest.indexOf('tdd');
      if (t >= 0 && rest[t + 1] !== 'on' && rest[t + 1] !== 'status') return true;
    }
    const sub = toks.slice(k + 1).find((t) => !t.startsWith('-'));
    if (sub === undefined) {
      if (/^(\$\(|\(|`)$/.test(parts[i + 1] ?? '')) return true; // subcommand comes from a substitution
      continue;
    }
    if (/[$`]/.test(sub)) return true;
    if (sub !== 'tdd') continue;
    const arg = toks.slice(k + 1).filter((t) => !t.startsWith('-'))[1];
    if (arg !== 'on' && arg !== 'status') return true;
  }
  return false;
}
const unquote = (t: string) => t.replace(/^['"]|['"]$/g, '');

const sensitivePath = (p: string): boolean => {
  if (!p) return false;
  const s = String(p).replace(/^['"]|['"]$/g, '').replace(/^~(?=\/|$)/, '$HOME');
  const base = s.split('/').pop() ?? '';
  if (/^\.env(\..+)?$/.test(base)) return !SAFE_EXAMPLE.test(base);
  if (/(^|\/)\.(ssh|gnupg)\//.test(s) && !/\.pub$/.test(base)) return true;
  if (/(^|\/)\.aws\/(credentials|config)$/.test(s)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)$/.test(base)) return true;
  if (/\.(pem|p12|pfx|keystore)$/i.test(base)) return true;
  if (/^\.(netrc|pgpass)$/.test(base)) return true;
  if (/\.tfstate(\..+)?$/.test(base) || /\.tfvars$/.test(base)) return true;
  return false;
};

const DENY: [RegExp, string][] = [
  [/\bgit\s+push\b[^;&|\n]*(\s--force(?!-with-lease)(\s|=|$)|\s-f(\s|$))/, 'force push (use --force-with-lease, and only on your own branch)'],
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, 'piping a download straight into a shell'],
  [/\bchmod\b[^;&|\n]*\b0?777\b/, 'chmod 777'],
  [/\bdd\b[^;&|\n]*\bof=\/dev\//, 'writing to a block device'],
];

const ASK: [RegExp, string][] = [
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard discards local changes'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean deletes untracked files'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, 'discarding all working-tree changes'],
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

export const rmTargets =(cmd: string): { recursive: boolean; targets: string[] }[] =>
  [...cmd.matchAll(/(?:^|[;&|(]\s*|\s)rm\s+([^;&|\n]*)/g)].map((m) => {
    const toks = m[1].trim().split(/\s+/).filter(Boolean);
    const flags = toks.filter((t) => t.startsWith('-')).join('');
    return { recursive: /-[a-zA-Z]*[rR]|--recursive/.test(flags), targets: toks.filter((t) => !t.startsWith('-')).map(unquote) };
  });

const checkRm = (cmd: string): Verdict | undefined => {
  for (const { recursive, targets } of rmTargets(cmd)) {
    if (!recursive) continue;
    if (targets.some((t) => /^(\/|~|\$HOME|\/\*|~\/\*|\.|\.\.|\*|\.\/\*)$/.test(t))) return ['deny', 'recursive delete of root, home, current or parent directory'];
    if (!targets.every((t) => SAFE_RM_TARGETS.test(t))) return ['ask', 'recursive delete outside build and cache folders'];
  }
  return undefined;
};

const checkPushToMain = (cmd: string): Verdict | undefined => {
  for (const m of cmd.matchAll(/\bgit\s+push\b([^;&|\n]*)/g)) {
    const refs = m[1].trim().split(/\s+/).filter((t) => t && !t.startsWith('-')).flatMap((t) => t.split(':'));
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

const checkInstall = (cmd: string, env: NodeJS.ProcessEnv): Verdict | undefined => {
  const found: string[] = [];
  for (const m of cmd.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+([^;&|\n]*)/g)) found.push(...addedPackages(m[1], JS_ADD, VALUE_FLAGS));
  for (const m of cmd.matchAll(/\b(?:pip3?|uv)\s+([^;&|\n]*)/g)) found.push(...addedPackages(m[1], PY_ADD, PIP_VALUE_FLAGS));
  if (found.length === 0) return undefined;
  const what = `adding dependency ${found.slice(0, 3).join(', ')}`;
  // Task 7: verifyPackages
  if (env.AGENT_GUARD_ALLOW_INSTALL === '1') return ['ask', `${what}: confirm it exists and is intended`];
  return ['deny', `${what}. Dependencies are added by a human: ask the user to run it`];
};

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
    } else if (name === 'echo' || name === 'printf' || name === 'awk') {
      for (const m of seg.matchAll(/\d*>>?\s*([^\s;&|>]+)/g)) {
        const t = m[1].replace(/^['"]+/, '').replace(/['"}]+$/, '');
        if (!t.startsWith('&') && t !== '/dev/null') out.push(t);
      }
    }
  }
  return out;
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

export function decideCommand(command: string, ctx: GuardCtx): Decision {
  if (!command) return { kind: 'allow' };
  const tokens = command.split(/[\s'"`=<>|;&()]+/).filter(Boolean);
  if (!/\.gitignore\b/.test(command) && tokens.some(sensitivePath)) return deny('touching a secrets file (.env, SSH or AWS keys, PEM, Terraform state)');
  if (tddInvocationDenied(command)) return { kind: 'deny', reason: TDD_OFF_WHY, check: 'guard' };
  const tddPaths = ctx.config?.checks.tdd ? ctx.config.tdd.paths : [];
  const inTdd = (t: string) => {
    const rel = tddPaths.length > 0 ? toRepoPath(ctx.root, t) : null;
    return rel !== null && matches(rel, tddPaths) ? rel : null;
  };
  for (const { targets } of rmTargets(command)) {
    if (targets.some((t) => { const rel = inTdd(t); return rel !== null && isTestFile(rel); })) return deny('deleting a test file in a TDD path');
  }
  const early = checkRm(command) ?? checkPushToMain(command);
  if (early) return toDecision(early);
  for (const [re, why] of DENY) if (re.test(command)) return deny(why);
  if (fileWriteTargets(command).some((t) => inTdd(t) !== null)) {
    return { kind: 'ask', reason: msg('ask', 'shell write into a TDD path; use the Edit or Write tool so the TDD gates see it'), check: 'guard' };
  }
  const install = checkInstall(command, ctx.env);
  if (install) return toDecision(install);
  for (const [re, why] of ASK) if (re.test(command)) return toDecision(['ask', why]);
  return { kind: 'allow' };
}

export const guard: Check = {
  name: 'guard',
  events: ['PreToolUse'],
  failClosed: true,
  run(ctx) {
    if (ctx.config?.checks.guard === false) return { kind: 'allow' };
    const { tool_name, tool_input = {} } = ctx.input;
    if (tool_name === 'Bash') return decideCommand(String(tool_input.command ?? ''), ctx);
    if (tool_name === 'Read' || tool_name === 'Grep') return decidePaths([String(tool_input.file_path ?? tool_input.path ?? '')]);
    return { kind: 'allow' };
  },
};
