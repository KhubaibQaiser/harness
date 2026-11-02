// Agent guard, ported from fitness-app scripts/agent-hooks/guard.mjs. A seatbelt, not a sandbox.
import { defaultLookup, type VerifyOpts, verifyPackages } from './dep-verify.js';
import { isTestFile, matches, toRepoPath } from '../core/paths.js';
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
const RUNNERS = new Set(['npx', 'npm', 'pnpm', 'dlx', 'exec', 'yarn', 'bunx', 'node', 'sudo', 'env', 'eval', 'bash', 'sh', 'zsh']);
const HARNESS_CMD = /(^|\/)harness(@\S+)?$|(^|\/)cli\.m?js$/;
// Subcommands only a person may run, with the arguments (after the subcommand) the agent may still use.
// One place: M3 adds remove, add, sync and update here.
const PERSON_ONLY: Record<string, { allowed: (args: string[]) => boolean; why: string }> = {
  tdd: { allowed: (a) => ['on', 'status'].includes(a.filter((t) => !t.startsWith('-'))[0]), why: 'Only a person can pause TDD: run "harness tdd off" in your own terminal.' },
  uninstall: { allowed: (a) => a.length > 0 && a.every((t) => t === '--dry-run'), why: 'Only a person can uninstall the harness: run "harness uninstall" in your own terminal (the agent may run "harness uninstall --dry-run").' },
};
const isPersonOnly = (t: string | undefined): t is string => t !== undefined && Object.hasOwn(PERSON_ONLY, t);
const ANY_WHY = 'Only a person can change or remove the harness gates: run the harness command in your own terminal.';
// Returns why a harness invocation (in command position) must be run by a person, or null when the agent may run it.
// ponytail: runner flag values (pnpm --filter x) are not understood; `harness` after one is missed.
function personOnlyInvocation(command: string): string | null {
  const plain = command.replace(/['"\\]/g, ''); // quotes and escapes must not hide the words
  const words = plain.split(/\s+/);
  // eval re-parses its input, so any eval near a harness token and a person-only subcommand is denied.
  const named = words.find(isPersonOnly);
  if (words.includes('eval') && named && words.some((t) => HARNESS_CMD.test(t.replace(/^\w+=/, '')))) return PERSON_ONLY[named].why;
  // A lone & separates commands; 2>&1, >&2 and &> are redirections.
  const parts = plain.split(/(&&|\|\||\$\(|(?<![<>])&(?!>)|[;|\n()`])/);
  for (let i = 0; i < parts.length; i += 2) {
    const toks = parts[i].trim().split(/\s+/).filter(Boolean);
    let k = 0;
    while (k < toks.length && (RUNNERS.has(toks[k]) || toks[k].startsWith('-') || /^\w+=/.test(toks[k]))) {
      const val = toks[k].replace(/^\w+=/, '');
      if (val !== toks[k] && HARNESS_CMD.test(val)) { toks[k] = val; break; } // CMD="harness tdd off"
      k += toks[k] === '-u' ? 2 : 1; // env -u NAME: the next token is a variable name
    }
    // $X tdd …, `…` tdd … or $(…) tdd …: the command name is hidden in a variable or substitution.
    // Whatever the hidden command is, the allowed arguments stay allowed.
    const hidden = toks[k]?.startsWith('$') ? k + 1 : k === 0 && /^[`)]$/.test(parts[i - 1] ?? '') ? 0 : -1;
    if (hidden >= 0 && isPersonOnly(toks[hidden]) && !PERSON_ONLY[toks[hidden]].allowed(toks.slice(hidden + 1))) return PERSON_ONLY[toks[hidden]].why;
    if (!toks[k] || !HARNESS_CMD.test(toks[k])) continue;
    const rest = toks.slice(k + 1);
    if (rest[0]?.startsWith('-')) { // no global flags in M1, so flag values cannot be told apart from subcommands
      for (const [name, rule] of Object.entries(PERSON_ONLY)) {
        const t = rest.indexOf(name);
        if (t >= 0 && !rule.allowed(rest.slice(t + 1))) return rule.why;
      }
    }
    const s = rest.findIndex((t) => !t.startsWith('-'));
    if (s < 0) {
      if (/^(\$\(|\(|`)$/.test(parts[i + 1] ?? '')) return ANY_WHY; // subcommand comes from a substitution
      continue;
    }
    if (/[$`]/.test(rest[s])) return ANY_WHY;
    if (isPersonOnly(rest[s]) && !PERSON_ONLY[rest[s]].allowed(rest.slice(s + 1))) return PERSON_ONLY[rest[s]].why;
  }
  return null;
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
  [/\bgit\s+push\b[^;&|\n]*(\s--force(?!-with-lease)(\s|=|$)|\s-f(\s|$))/, 'force push (use --force-with-lease, and only on your own branch)'],
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, 'piping a download straight into a shell'],
  [/\bchmod\b[^;&|\n]*\b0?777\b/, 'chmod 777'],
  [/\bdd\b[^;&|\n]*\bof=\/dev\//, 'writing to a block device'],
];

const ASK: [RegExp, string][] = [
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard discards local changes'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean deletes untracked files'],
  [/\bgit\s+(?:(?:-[Cc]\s+\S+|--\S+)\s+)*(checkout|restore)\s+(--\s+)?\.(\s|$)/, 'discarding all working-tree changes'],
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

export const rmTargets = (cmd: string): { recursive: boolean; targets: string[] }[] =>
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

export function decideCommand(command: string, ctx: GuardCtx): Decision {
  if (!command) return { kind: 'allow' };
  const tokens = command.split(/[\s'"`=<>|;&()]+/).filter(Boolean);
  if (!/\.gitignore\b/.test(command) && tokens.some(sensitivePath)) return deny('touching a secrets file (.env, SSH or AWS keys, PEM, Terraform state)');
  const personOnly = personOnlyInvocation(command);
  if (personOnly) return { kind: 'deny', reason: personOnly, check: 'guard' };
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
  const install = checkInstall(command, ctx);
  if (install) return install;
  for (const [re, why] of ASK) if (re.test(command)) return toDecision(['ask', why]);
  return { kind: 'allow' };
}

export const guard: Check = {
  name: 'guard',
  events: ['PreToolUse'],
  failClosed: true,
  pure: true,
  run(ctx) {
    if (ctx.config?.checks.guard === false) return { kind: 'allow' };
    const { tool_name, tool_input = {} } = ctx.input;
    if (tool_name === 'Bash') return decideCommand(String(tool_input.command ?? ''), ctx);
    if (tool_name === 'Read') return decidePaths([String(tool_input.file_path ?? tool_input.path ?? '')]);
    if (tool_name === 'Grep') {
      // ponytail: the glob is checked as written and with its wildcards dropped, not expanded, so `.e*v` is missed.
      const glob = String(tool_input.glob ?? '');
      return decidePaths([String(tool_input.path ?? ''), glob, glob.replace(/[*?[\]{}]/g, '')]);
    }
    return { kind: 'allow' };
  },
};
