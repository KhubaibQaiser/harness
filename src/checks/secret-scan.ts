// secret-scan (the gitleaks-commit item): before an agent `git commit` or `git stash`, gitleaks scans what it could
// take: the real index as staged, and the whole worktree staged into a throwaway index (`git add -A`, which honours
// .gitignore; PreToolUse runs before the command, so `commit -a` or a pathspec has not staged anything yet). The commit
// must be the only, plain command on the line, so nothing on it writes or stages after the scan. Commands that make
// commits from content harness can't scan first (merge, rebase, …) ask. Fails closed: no gitleaks, an error or a
// timeout denies. gitleaks runs with harness's own rules, no ignore file, inline allows ignored, no repo or user
// attributes and no global or system git config, so the repo can't hide a finding. Only rule, file and line are shown.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { esc } from '../core/config.js';
import { SAFE_GIT } from '../core/git-safe.js';
import { redactSecrets } from '../core/secrets.js';
import { pieces, unquote, words } from '../core/shell-words.js';
import type { Check, Ctx } from '../hooks/dispatch.js';
import { editTarget, isShell } from '../hooks/edit-target.js';
import type { Decision } from '../hooks/types.js';
import { runnerName, type Seg, walkCommands } from './guard.js';
import { hookBudgetMs } from './pr-size/measure.js';
import { findOnPath, syncCommand } from './stop/runner.js';

const SHOWN = 5;
const LEAK_EXIT = 2; // gitleaks exits 1 on its own errors too, so a finding gets a code of its own
const RULES = '[extend]\nuseDefault = true\n';
const OFF = 'or turn the check off by running `harness remove gitleaks-commit` in your terminal';
const MISSING = `gitleaks is not on PATH, so this commit can't be scanned for secrets, and harness never skips the scan. Install gitleaks 8.30.1 (\`brew install gitleaks\`, or the release binary from https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1 checked against its checksums.txt), ${OFF}.`;
const deny = (why: string): Decision => ({ kind: 'deny', check: 'secret-scan', reason: `Blocked by secret-scan: ${why}` });
const ask = (why: string): Decision => ({ kind: 'ask', check: 'secret-scan', reason: why });
const first = (s: string | undefined) => esc((s ?? '').trim().split('\n')[0] ?? '');

// git's global options that take a value, and those that point git at another repo, worktree or attribute source.
const GLOBAL_VALUE = /^(-[Cc]|--(git-dir|work-tree|namespace|exec-path|super-prefix|config-env|attr-source|list-cmds))$/;
const ELSEWHERE = /^(-C|--(git-dir|work-tree|namespace|exec-path|super-prefix|config-env|attr-source))(=|$)/;
const SAFE_C = /^(user\.(name|email|signingkey)|commit\.gpgsign)=/; // -c keys that can't change what is committed
const SCANNED = new Set(['commit', 'stash']);
const UNSCANNED = new Set(['merge', 'cherry-pick', 'rebase', 'revert', 'am', 'commit-tree', 'pull']);
const STASH_SCANNED = /^(push|save|-.*)?$/; // `git stash` alone pushes; list/show/apply/pop/drop make no commit
const COMMIT_WORD = /^(commit|stash|merge|cherry-pick|rebase|revert|am|commit-tree|pull)$/;

/** Past git's global options: the subcommand's index and the options, as written. */
function gitSub(ws: string[], k: number): { i: number; opts: string[] } {
  const opts: string[] = [];
  let i = k + 1;
  for (; i < ws.length && ws[i]!.startsWith('-'); i++) {
    opts.push(GLOBAL_VALUE.test(ws[i]!) ? `${ws[i]}=${ws[++i] ?? ''}` : ws[i]!);
  }
  return { i, opts };
}

type Kind = 'scan' | 'ask';
/** What one segment is: a commit harness scans, one it must ask about, or neither. */
function kindOf({ toks, k, prev }: Seg): Kind | null {
  const head = toks[k] ?? '';
  const built = head.startsWith('$') || (k === 0 && (prev === ')' || prev === '`'));
  if (built) return toks.some((t) => COMMIT_WORD.test(t)) ? 'ask' : null;
  if (runnerName(head) !== 'git') return null;
  const { i, opts } = gitSub(toks, k);
  const sub = toks[i] ?? '';
  if (opts.some((o) => /^-c=alias\./.test(o)) || sub.startsWith('$')) return 'ask';
  if (sub === 'stash') return STASH_SCANNED.test(toks[i + 1] ?? '') ? 'scan' : toks[i + 1] === 'create' || toks[i + 1] === 'store' ? 'ask' : null;
  return SCANNED.has(sub) ? 'scan' : UNSCANNED.has(sub) ? 'ask' : null;
}

function kinds(command: string, ctx: Ctx): Set<Kind> {
  const found = new Set<Kind>();
  walkCommands<never>(command, { root: ctx.root, env: ctx.env }, (seg) => {
    const k = kindOf(seg);
    if (k) found.add(k);
    return null;
  }, { whole: (w) => (w.includes('eval') && w.some((t) => COMMIT_WORD.test(t)) ? (found.add('scan'), null) : null) });
  return found;
}

// The one message idiom Claude Code writes: -m "$(cat <<'EOF' … EOF )". The delimiter is quoted, so the body runs nothing.
const QUOTED_CAT = /"\$\(cat <<-?'(\w+)'\n[\s\S]*?\n\1\n\s*\)"/g;

/** Why the line is not one plain `git commit`/`git stash` harness can scan as it will run, or null. */
function notPlain(command: string): string | null {
  const t = command.replace(QUOTED_CAT, '"msg"');
  if (/\$\(|`|<\(|>\(|<</.test(t)) return 'part of this line is built at run time (a `$(…)`, backtick, process substitution or heredoc), so harness can\'t tell what it stages; write the message with -m "…", -m "$(cat <<\'EOF\' … EOF)" or -F <file>';
  const ps = pieces(t);
  if (ps.length !== 1) return 'a git commit must be the only command on the line, so nothing else on it can write or stage a file after the scan; run the other commands first, in their own call';
  const ws = words(ps[0]!.text).map(unquote);
  if (runnerName(ws[0] ?? '') !== 'git') return 'run git commit as a plain command, with no variable assignment, wrapper, eval or shell in front of it';
  const { opts } = gitSub(ws, 0);
  if (opts.some((o) => ELSEWHERE.test(o))) return 'run git commit from the repo folder, without -C, --git-dir, --work-tree or other options that point git elsewhere';
  if (opts.some((o) => o.startsWith('-c=') && !SAFE_C.test(o.slice(3)))) return 'a git -c setting other than user.name, user.email, user.signingkey or commit.gpgsign can change what is committed';
  return null;
}

/** Git 2.40 added GIT_ATTR_SOURCE, which the scan needs so .gitattributes can't mark a file binary and hide it. */
export function gitTooOld(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  return !m || Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 40);
}

type Finding = { RuleID?: unknown; File?: unknown; StartLine?: unknown };
function found(report: string): string {
  let list: Finding[];
  try {
    list = JSON.parse(readFileSync(report, 'utf8')) as Finding[];
  } catch {
    list = [];
  }
  if (!Array.isArray(list) || !list.length) return 'gitleaks reported a finding but its report could not be read. Ask the person to look';
  const show = (v: unknown) => esc(redactSecrets(String(v))); // a file name can hold a secret too
  const shown = list.slice(0, SHOWN).map((f) => `${show(f.RuleID)} in \`${show(f.File)}\` line ${Number(f.StartLine) || '?'}`);
  const more = list.length > SHOWN ? `, and ${list.length - SHOWN} more` : '';
  return `gitleaks found ${list.length} likely secret${list.length > 1 ? 's' : ''} in what this command could commit (the staged changes, and the unstaged and untracked files that are not ignored): ${shown.join('; ')}${more}. Values are not shown. Remove the secret, and rotate it if it was ever pushed. If it is a false positive, stop and ask the person: they can commit it from their own terminal or remove the gitleaks-commit item`;
}

function scan(ctx: Ctx): Decision {
  const platform = ctx.platform ?? process.platform;
  const bin = findOnPath('gitleaks', ctx.env, platform);
  if (!bin) return deny(MISSING);
  const left = () => hookBudgetMs(ctx.startedAt, Date.now);
  const git = (args: string[], env: NodeJS.ProcessEnv = ctx.env, input?: string) =>
    spawnSync('git', [...SAFE_GIT, ...args], { cwd: ctx.root, env, encoding: 'utf8', timeout: Math.max(1, left()), ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] as const } : { input }) });
  const failed = (what: string, r: ReturnType<typeof git>) => deny(`could not scan this commit for secrets: ${what} failed or timed out (${first(r.stderr || String(r.error ?? ''))}), ${OFF}.`);
  const ver = git(['version']);
  if (ver.status !== 0) return failed('git version', ver);
  if (gitTooOld(ver.stdout)) return deny(`could not scan this commit for secrets: git ${first(ver.stdout.replace(/^git version /, ''))} is older than 2.40, which the scan needs to ignore .gitattributes. Update git, ${OFF}.`);
  // The index and info/attributes the commit itself uses (a GIT_INDEX_FILE in the session's env included).
  const where = git(['rev-parse', '--git-path', 'index', '--git-path', 'info/attributes']);
  if (where.status !== 0) return failed('git rev-parse', where);
  const [real, attrs] = where.stdout.trim().split('\n').map((p) => resolve(ctx.root, p));
  // GIT_ATTR_SOURCE and an empty core.attributesFile cover .gitattributes and user attributes; info/attributes has no off switch.
  if (existsSync(attrs!) && /diff|binary/.test(readFileSync(attrs!, 'utf8'))) return deny(`.git/info/attributes has a diff or binary line, which would hide files from the secret scan. Ask the person to remove it, ${OFF}.`);
  const tree = git(['hash-object', '-t', 'tree', '--stdin'], ctx.env, '');
  if (tree.status !== 0) return failed('git hash-object', tree);
  const dir = mkdtempSync(join(tmpdir(), 'harness-gitleaks-'));
  try {
    const f = (name: string, text = '') => (writeFileSync(join(dir, name), text), join(dir, name));
    const home = join(dir, 'home');
    mkdirSync(home);
    const worktree = join(dir, 'index');
    if (existsSync(real!)) copyFileSync(real!, worktree); // keeps what is staged, deletions and intent-to-add included
    const add = git(['add', '-A'], { ...ctx.env, GIT_INDEX_FILE: worktree });
    if (add.status !== 0) return failed('git add into a throwaway index', add);
    const empty = f('empty');
    // No attributes but harness's (none), no global or system config: no textconv driver, binary mark or fsmonitor from the repo's setup.
    const sealed = {
      ...ctx.env, GIT_ATTR_SOURCE: tree.stdout.trim(), GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, HOME: home, XDG_CONFIG_HOME: home,
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.attributesFile', GIT_CONFIG_VALUE_0: empty, GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
    };
    const config = f('gitleaks.toml', RULES);
    const ignore = f('gitleaksignore');
    for (const [n, index] of [real, worktree].entries()) {
      if (!existsSync(index!)) continue; // a repo with nothing ever staged has no index yet
      const report = join(dir, `report-${n}.json`);
      const args = ['git', '--pre-commit', '--staged', '--redact', '--no-banner', '--ignore-gitleaks-allow', '--config', config, '--gitleaks-ignore-path', ignore, '--exit-code', String(LEAK_EXIT), '--report-format', 'json', '--report-path', report, ctx.root];
      const [file, a, opts] = platform === 'win32' ? syncCommand('gitleaks', args, platform, ctx.env) : [bin, args, {}];
      const ms = left();
      if (ms <= 0) return deny(`could not scan this commit for secrets in the hook's time budget, ${OFF}.`);
      // gitleaks output is never shown: with a broken --redact it could still carry a value.
      const r = spawnSync(file, a, { ...opts, cwd: ctx.root, env: { ...sealed, GIT_INDEX_FILE: index }, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'ignore', 'ignore'] });
      if (r.status === LEAK_EXIT) return deny(found(report) + '.');
      if (r.status === 0) continue;
      const why = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'gitleaks timed out' : `gitleaks exited ${r.status ?? r.signal ?? 'abnormally'}`;
      return deny(`could not scan this commit for secrets: ${why}. Run \`gitleaks git --pre-commit --staged --redact\` in your terminal to see why, ${OFF}.`);
    }
    return { kind: 'allow' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The person's allowlists: harness's scans ignore them, but the person's own gitleaks runs read them.
const ALLOWLIST = /(^|[\\/\s'"=<>])\.gitleaks(\.toml|ignore)(?![\w.-])/;
const ALLOWLIST_ASK = 'This changes a gitleaks allowlist (.gitleaks.toml or .gitleaksignore), which can hide a secret from gitleaks. Confirm the change.';

export const secretScan: Check = {
  name: 'secret-scan',
  events: ['PreToolUse'],
  failClosed: true,
  run(ctx) {
    if (!ctx.config?.checks.secretScan) return { kind: 'allow' };
    const target = editTarget(ctx.input);
    if (target !== null) return ALLOWLIST.test(target) ? ask(ALLOWLIST_ASK) : { kind: 'allow' };
    if (!isShell(ctx.input.tool_name)) return { kind: 'allow' };
    const command = String(ctx.input.tool_input?.command ?? '');
    const k = kinds(command, ctx);
    if (k.has('scan')) {
      const why = notPlain(command);
      const d = why ? deny(why + '.') : scan(ctx);
      if (d.kind !== 'allow') return d;
    }
    if (k.has('ask')) return ask('This git command makes commits from content harness can\'t scan for secrets before they are made (a merge, rebase, cherry-pick, revert, am, pull, commit-tree, a stash create, a git alias or a git named at run time). Confirm it.');
    return ALLOWLIST.test(command) ? ask(ALLOWLIST_ASK) : { kind: 'allow' };
  },
};
