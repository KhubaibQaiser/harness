// secret-scan (the gitleaks-commit item): before an agent `git commit` or `git stash`, gitleaks scans what it could
// take: the real index as staged, and the whole worktree staged into a throwaway index (`git add -A`, which honours
// .gitignore; PreToolUse runs before the command, so `commit -a` or a pathspec has not staged anything yet). The commit
// must be the only, plain command on the line, so nothing on it writes or stages after the scan. Commands that make
// commits from content harness can't scan first (merge, rebase, …) ask. Fails closed: no gitleaks, an error or a
// timeout denies. gitleaks runs with harness's own rules, inline allows ignored, every file diffed as text, no user
// attributes, no global or system git config and a plain diff format; a repo .gitleaksignore blocks, since gitleaks
// always reads it. So the repo can't hide a finding. Only rule, file and line are shown.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { esc } from '../core/config.js';
import { SAFE_GIT, SAFE_GIT_USER } from '../core/git-safe.js';
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
const SAFE_C = /^(user\.(name|email|signingkey)=|commit\.gpgsign=false$)/; // -c keys that can't change what is committed (signing runs gpg.program)
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

type Kind = 'commit' | 'stash' | 'ask';
/** What one segment is: a commit harness scans, one it must ask about, or neither. */
function kindOf({ toks, k, prev }: Seg): Kind | null {
  const head = toks[k] ?? '';
  const built = head.startsWith('$') || (k === 0 && (prev === ')' || prev === '`'));
  if (built) return toks.some((t) => COMMIT_WORD.test(t)) ? 'ask' : null;
  if (runnerName(head) !== 'git') return null;
  const { i, opts } = gitSub(toks, k);
  const sub = toks[i] ?? '';
  if (opts.some((o) => /^-c=alias\./.test(o)) || sub.startsWith('$')) return 'ask';
  if (sub === 'stash') return STASH_SCANNED.test(toks[i + 1] ?? '') ? 'stash' : toks[i + 1] === 'create' || toks[i + 1] === 'store' ? 'ask' : null;
  return sub === 'commit' ? 'commit' : UNSCANNED.has(sub) ? 'ask' : null;
}

function kinds(command: string, ctx: Ctx): Set<Kind> {
  const found = new Set<Kind>();
  walkCommands<never>(command, { root: ctx.root, env: ctx.env }, (seg) => {
    const k = kindOf(seg);
    if (k) found.add(k);
    return null;
  }, { whole: (w) => (w.includes('eval') && w.some((t) => COMMIT_WORD.test(t)) ? (found.add('commit'), null) : null) });
  return found;
}

// The one message idiom Claude Code writes: -m "$(cat <<'EOF' … EOF )". The delimiter is quoted, so the body runs nothing.
// Bash closes the heredoc at the FIRST line equal to the delimiter (bash 3.2 also at one that starts with it, `EOF)`), so a
// body holding such a line is code after it: not the idiom.
const QUOTED_CAT = /"\$\(cat <<(-?)'(\w+)'\n([\s\S]*?)\n\2\n\s*\)"/g;
const messages = (cmd: string): string =>
  cmd.replace(QUOTED_CAT, (m, dash: string, d: string, body: string) => (body.split('\n').some((l) => (dash ? l.replace(/^\t+/, '') : l).startsWith(d)) ? m : '"msg"'));

/** Why the line is not one plain `git commit`/`git stash` harness can scan as it will run, or null. */
function notPlain(command: string): string | null {
  const t = messages(command);
  if (/\$\(|`|<\(|>\(|<</.test(t)) return 'part of this line is built at run time (a `$(…)`, backtick, process substitution or heredoc), so harness can\'t tell what it stages; write the message with -m "…", -m "$(cat <<\'EOF\' … EOF)" or -F <file>';
  const ps = pieces(t);
  if (ps.length !== 1) return 'a git commit must be the only command on the line, so nothing else on it can write or stage a file after the scan; run the other commands first, in their own call';
  const ws = words(ps[0]!.text).map(unquote);
  if (runnerName(ws[0] ?? '') !== 'git') return 'run git commit as a plain command, with no variable assignment, wrapper, eval or shell in front of it';
  const { opts } = gitSub(ws, 0);
  if (opts.some((o) => ELSEWHERE.test(o))) return 'run git commit from the repo folder, without -C, --git-dir, --work-tree or other options that point git elsewhere';
  if (opts.some((o) => o.startsWith('-c=') && !SAFE_C.test(o.slice(3)))) return 'a git -c setting other than user.name, user.email, user.signingkey or commit.gpgsign=false can change what is committed (signing runs gpg.program)';
  return null;
}

// Command-line level git config for gitleaks's own git: a plain, uncoloured diff with the usual a/ b/ paths, whatever
// the repo's .git/config says (color.ui=always would put escape codes in the diff gitleaks parses), and no fsmonitor.
const SEALED_CONFIG: [string, string][] = [
  ['core.fsmonitor', 'false'], ['color.ui', 'never'], ['color.diff', 'never'], ['diff.colorMoved', 'no'], ['diff.noprefix', 'false'], ['diff.mnemonicPrefix', 'false'],
  ['diff.relative', 'false'], ['diff.srcPrefix', 'a/'], ['diff.dstPrefix', 'b/'], ['core.quotePath', 'true'],
];
const configEnv = (pairs: [string, string][]): Record<string, string> =>
  Object.fromEntries([['GIT_CONFIG_COUNT', String(pairs.length)], ...pairs.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])]);

// Any hook git may run around a commit or stash (pre-commit, post-commit, post-rewrite, reference-transaction, …) runs
// after the scan, so any runnable file counts, not a name list. Git skips one that is not executable (Windows: any file).
const runnable = (p: string, platform: NodeJS.Platform): boolean => {
  try {
    const st = statSync(p);
    return st.isFile() && (platform === 'win32' || (st.mode & 0o111) !== 0);
  } catch {
    return false;
  }
};

function hookFiles(dir: string, platform: NodeJS.Platform): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.endsWith('.sample') && runnable(join(dir, n), platform)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e; // failClosed: an unreadable hooks folder denies
  }
}

// Git config that names a program git may run during a commit or stash, after the scan, where it could stage files or
// make a commit of its own: matched by key pattern, not a list, so a key git adds later asks too. git-lfs's own filter
// lines (`git lfs install`) and true/false fsmonitor run nothing of the repo's. Namespaces git never reads during a commit
// or stash (credential helpers, diff and merge tools, mail, browsers, help) are left out: a credential helper is in most
// installs' system config, and asking on every commit for it would only teach people to say yes.
const PROGRAM_KEYS = '^commit\\.(gpgsign|verbose)$|(^|\\.)(program|command|cmd|editor|fsmonitor|helper|defaultkeycommand)$|^filter\\..*\\.(clean|smudge|process)$|^diff\\..*\\.textconv$|^diff\\.external$|^interactive\\.difffilter$';
const NOT_IN_COMMIT = /^(credential|difftool|mergetool|sendemail|browser|web|man|instaweb|gui|guitool)\./;
const LFS: Record<string, string> = { 'filter.lfs.clean': 'git-lfs clean -- %f', 'filter.lfs.smudge': 'git-lfs smudge -- %f', 'filter.lfs.process': 'git-lfs filter-process' };
const BOOL = /^(true|false|yes|no|on|off|1|0)$/i;
/** What this command makes git run: the editor, and signing. Stash opens no editor and signs nothing. */
/** signFlag: -S (true), --no-gpg-sign (false), or neither (null, commit.gpgsign decides); verboseFlag likewise for -v,
 *  --no-verbose and commit.verbose. */
export type Use = { editor: boolean; signFlag: boolean | null; verboseFlag: boolean | null };
const MSG_LONG = /^--(message|file|reuse-message)(=|$)/;
// git commit's other options, so anything else is unknown. VALUE ones take the next word unless given as --x=v.
const VALUE_LONG = /^--(template|author|date|cleanup|trailer|pathspec-from-file)(=|$)/;
const FLAG_LONG = /^--(all|include|only|patch|interactive|quiet|no-verify|verify|signoff|no-signoff|allow-empty|allow-empty-message|amend|dry-run|short|branch|porcelain|long|null|reset-author|status|no-status|pathspec-file-nul|no-post-rewrite|untracked-files(=.*)?)$/;
const FLAG_SHORT = 'aiopqnsz';
/** From a plain `git commit` line: the editor opens unless a message comes from -m, -F, -C or --no-edit, and always with
 *  -e, --edit, -c or --reedit-message; -S or --gpg-sign signs, --no-gpg-sign doesn't, otherwise commit.gpgsign decides.
 *  An option it doesn't know fails closed: the editor may open and the commit may sign. */
export function commitUse(command: string): Use {
  const ws = words(pieces(messages(command))[0]?.text ?? '').map(unquote);
  const { i } = gitSub(ws, 0);
  if (ws[i] !== 'commit') return { editor: false, signFlag: false, verboseFlag: false };
  let msg = false, edit = false, noEdit = false, unknown = false, signFlag: boolean | null = null, verboseFlag: boolean | null = null;
  for (let j = i + 1; j < ws.length; j++) {
    const w = ws[j]!;
    if (w === '--') break;
    if (w.startsWith('--')) {
      if (MSG_LONG.test(w)) { msg = true; if (!w.includes('=')) j++; }
      else if (/^--(fixup|squash)(=|$)/.test(w)) {
        const v = w.includes('=') ? w.slice(w.indexOf('=') + 1) : (ws[++j] ?? '');
        // Only a plain --fixup=<commit> writes the message itself; --squash and --fixup=amend:/reword: open the editor.
        if (w.startsWith('--fixup') && !/^(amend|reword):/.test(v)) msg = true; else edit = true;
      }
      else if (w === '--edit') edit = true;
      else if (w === '--no-edit') noEdit = true;
      else if (/^--reedit-message(=|$)/.test(w)) { edit = true; if (!w.includes('=')) j++; }
      else if (/^--gpg-sign(=|$)/.test(w)) signFlag = true;
      else if (w === '--no-gpg-sign') signFlag = false;
      else if (w === '--verbose') verboseFlag = true;
      else if (w === '--no-verbose') verboseFlag = false;
      else if (VALUE_LONG.test(w)) { if (!w.includes('=')) j++; }
      else if (!FLAG_LONG.test(w)) unknown = true;
      continue;
    }
    if (!w.startsWith('-') || w === '-') continue;
    for (let c = 1; c < w.length; c++) {
      const ch = w[c]!;
      if (ch === 'S') { signFlag = true; break; } // -S[<keyid>]: the rest is the key id
      if (ch === 'u') break; // -u[<mode>]: the rest is the mode
      if (ch === 'e') edit = true;
      else if (ch === 'v') verboseFlag = true;
      else if ('mFCct'.includes(ch)) {
        if (ch === 'c') edit = true; else if (ch !== 't') msg = true;
        if (c === w.length - 1) j++; // the value is the next word
        break; // the rest of the word is the value
      } else if (!FLAG_SHORT.includes(ch)) unknown = true;
    }
  }
  return unknown ? { editor: true, signFlag: true, verboseFlag: true } : { editor: edit || (!msg && !noEdit), signFlag, verboseFlag };
}

/** The program keys of the effective config (every scope, includes followed), or null when git config fails.
 *  SAFE_GIT_USER: SAFE_GIT turns fsmonitor off. */
function programRows(ctx: Ctx): [string, string][] | null {
  const r = spawnSync('git', [...SAFE_GIT_USER, 'config', '--get-regexp', PROGRAM_KEYS], { cwd: ctx.root, env: ctx.env, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 && r.status !== 1) return null; // 1: no such key
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf(' ');
    return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)];
  });
}

/** Of those rows, and the editor variables in `env`, the ones git would run for this command. */
export function runningPrograms(rows: [string, string][], use: Use, env: NodeJS.ProcessEnv): string[] {
  // Signing is on with -S, or with commit.gpgsign true in any scope (stricter than git's last-wins) unless --no-gpg-sign.
  const sign = use.signFlag ?? rows.some(([k, v]) => k === 'commit.gpgsign' && /^(true|yes|on|1)$/i.test(v));
  // textconv and diff.external run only when git renders a diff: for a commit, the verbose diff in its editor (-v or
  // commit.verbose, true or a level, in any scope, unless --no-verbose). Git for Windows ships diff.astextplain.textconv.
  const diff = use.editor && (use.verboseFlag ?? rows.some(([k, v]) => k === 'commit.verbose' && /^(true|yes|on|[1-9]\d*)$/i.test(v)));
  const runs = ([key, value]: [string, string]): boolean => {
    if (key === 'commit.gpgsign' || key === 'commit.verbose' || NOT_IN_COMMIT.test(key) || LFS[key] === value || (key === 'core.fsmonitor' && BOOL.test(value))) return false;
    if (key === 'sequence.editor') return false; // rebase -i only
    if (/^diff\.(.*\.textconv|external)$/.test(key)) return diff;
    if (key === 'core.editor') return use.editor && !/^\s*(true|:)\s*$/.test(value);
    if (/^gpg\.(.*\.)?(program|defaultkeycommand)$/.test(key)) return sign;
    return true;
  };
  // An editor of `true` or `:` runs nothing (the usual way to skip the editor).
  const editors = use.editor ? ['GIT_EDITOR', 'VISUAL', 'EDITOR'].filter((v) => env[v] && !/^\s*(true|:)\s*$/.test(env[v]!)) : [];
  return [...new Set([...rows.filter(runs).map(([k]) => esc(k)), ...editors])];
}

const ATTRS = '* diff\n';
/** The ids of the `* diff` blob and of the tree holding it as .gitattributes, as git would compute them. */
function attrTree(algo: 'sha1' | 'sha256'): { blob: string; tree: string } {
  const id = (type: string, body: Buffer) => createHash(algo).update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).digest();
  const blob = id('blob', Buffer.from(ATTRS));
  return { blob: blob.toString('hex'), tree: id('tree', Buffer.concat([Buffer.from('100644 .gitattributes\0'), blob])).toString('hex') };
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

function scan(ctx: Ctx, use: Use): Decision {
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
  // One call for the paths the commit itself uses (a GIT_INDEX_FILE in the session's env included) and the object format.
  // SAFE_GIT_USER: SAFE_GIT's own core.hooksPath override would hide the repo's hooks folder; rev-parse runs no hook.
  const where = spawnSync('git', [...SAFE_GIT_USER, 'rev-parse', '--git-path', 'index', '--git-path', 'info/attributes', '--git-path', 'hooks', '--git-path', 'objects', '--show-object-format'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8', timeout: Math.max(1, left()), stdio: ['ignore', 'pipe', 'pipe'] });
  const out = where.stdout?.trim().split('\n') ?? [];
  if (where.status !== 0 || out.length !== 5) return failed('git rev-parse', where);
  const [real, attrs, hooks, objects] = out.slice(0, 4).map((p) => resolve(ctx.root, p));
  // GIT_ATTR_SOURCE and an empty core.attributesFile cover .gitattributes and user attributes; info/attributes has no off switch.
  if (existsSync(attrs!) && /diff|binary/.test(readFileSync(attrs!, 'utf8'))) return deny(`.git/info/attributes has a diff or binary line, which would hide files from the secret scan. Ask the person to remove it, ${OFF}.`);
  // An attribute source whose only line is `* diff`: every file diffs as text, so neither .gitattributes nor a NUL byte hides it.
  // Its ids are computed here; git writes the two objects only when they aren't already in the repo as loose objects.
  const ids = attrTree(out[4] === 'sha256' ? 'sha256' : 'sha1');
  const loose = (id: string) => existsSync(join(objects!, id.slice(0, 2), id.slice(2)));
  if (!loose(ids.blob) || !loose(ids.tree)) {
    const blob = git(['hash-object', '-w', '--stdin'], ctx.env, ATTRS);
    if (blob.status !== 0) return failed('git hash-object', blob);
    const tree = git(['mktree'], ctx.env, `100644 blob ${blob.stdout.trim()}\t.gitattributes\n`);
    if (tree.status !== 0) return failed('git mktree', tree);
    if (blob.stdout.trim() !== ids.blob || tree.stdout.trim() !== ids.tree) return deny(`could not scan this commit for secrets: git wrote the attribute tree under an unexpected id, ${OFF}.`);
  }
  // gitleaks always reads <repo>/.gitleaksignore, whatever --gitleaks-ignore-path says; the index copy would be committed.
  const staged = git(['ls-files', '--cached', '--', ':(icase).gitleaksignore']);
  if (staged.status !== 0) return failed('git ls-files', staged);
  if (existsSync(join(ctx.root, '.gitleaksignore')) || staged.stdout.trim()) return deny(`a .gitleaksignore file is in the repo (worktree or index). gitleaks always reads it from the repo root, so it can hide a finding from this scan. Remove it (\`git rm --cached\` too if it is staged), or stop and ask the person, ${OFF}.`);
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
      ...ctx.env, GIT_ATTR_SOURCE: ids.tree, GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, HOME: home, XDG_CONFIG_HOME: home,
      ...configEnv([['core.attributesFile', empty], ...SEALED_CONFIG]),
    };
    const config = f('gitleaks.toml', RULES);
    const ignore = f('gitleaksignore');
    // git add skips writing an index it didn't change, so identical bytes mean the worktree adds nothing: one scan does.
    const same = existsSync(real!) && existsSync(worktree) && readFileSync(real!).equals(readFileSync(worktree));
    for (const [n, index] of (same ? [real] : [real, worktree]).entries()) {
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
    const rows = programRows(ctx);
    if (rows === null) return deny(`could not scan this commit for secrets: git config could not be read, ${OFF}.`);
    const progs = runningPrograms(rows, use, ctx.env);
    const run = hookFiles(hooks!, platform);
    const why = [
      ...(run.length ? [`hooks (${run.map(esc).join(', ')} in ${esc(hooks!)})`] : []),
      ...(progs.length ? [`git config that runs programs (${progs.join(', ')})`] : []),
    ];
    return why.length ? ask(`The repo has ${why.join(' and ')}. Git runs them after this secret scan, and they can change or stage files, so harness can't vouch for what gets committed. Confirm the command. To trust this repo's hooks and programs, a person can set checks.secretScan: false in .harness/config.yaml; the gitleaks-ci check and the CI verdict still apply.`) : { kind: 'allow' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The person's allowlists. Harness's scans ignore .gitleaks.toml, but gitleaks always reads <repo>/.gitleaksignore, so the
// scan itself blocks while one exists: that is the real control. This ask only flags a change early; a name built at
// run time (`.gitleaksig${n}nore`) or a checkout that restores the file is not seen here.
const ALLOWLIST = /(^|[\\/\s=<>])\.gitleaks(\.toml|ignore)(?![\w.-])/i;
const mentionsAllowlist = (text: string): boolean => ALLOWLIST.test(text) || ALLOWLIST.test(text.replace(/['"\\]/g, ''));
// Commit hooks run after the scan, so a new or changed hook (or hooks folder) is asked about. Early warning only, as above:
// the commit itself asks while a runnable hook exists. The configured hooks folder is read only when a hook name shows.
const HOOKS_TEXT = /(^|[\\/\s=<>])(\.git[\\/](hooks|config)|\.husky|\.githooks)([\\/\s]|$)|core\.(hookspath|fsmonitor)|filter\.\S*\.(clean|smudge|process)/i;
const HOOKS_ASK = 'This changes a git hook, core.hooksPath, core.fsmonitor, a filter or .git/config. Git runs those after harness\'s secret scan, and they can stage files. Confirm the change.';
function hooksDir(ctx: Ctx): string | null {
  // SAFE_GIT_USER: SAFE_GIT's own core.hooksPath override would hide the repo's.
  const r = spawnSync('git', [...SAFE_GIT_USER, 'rev-parse', '--git-path', 'hooks'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && r.stdout.trim() ? resolve(ctx.root, r.stdout.trim()) : null; // writes: a failure leaves the fixed patterns; a commit denies
}
const inside = (dir: string, p: string): boolean => {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const touchesHooks = (ctx: Ctx, text: string, path?: string): boolean => {
  if (HOOKS_TEXT.test(text) || HOOKS_TEXT.test(text.replace(/['"\\]/g, ''))) return true;
  if (!/pre-commit|commit-msg|hook/i.test(text)) return false; // no hook name: skip the git call (it runs on every tool call)
  const dir = hooksDir(ctx);
  if (!dir) return false;
  if (path !== undefined) return inside(dir, resolve(ctx.root, path));
  const rel = relative(ctx.root, dir).replace(/\\/g, '/');
  return !!rel && !rel.startsWith('..') && text.replace(/['"\\]/g, '').includes(rel);
};
const ALLOWLIST_ASK = 'This changes a gitleaks allowlist (.gitleaks.toml or .gitleaksignore), which can hide a secret from gitleaks; while a .gitleaksignore exists, harness blocks agent commits. Confirm the change.';

export const secretScan: Check = {
  name: 'secret-scan',
  events: ['PreToolUse'],
  failClosed: true,
  run(ctx) {
    if (!ctx.config?.checks.secretScan) return { kind: 'allow' };
    const target = editTarget(ctx.input);
    if (target !== null) return mentionsAllowlist(target) ? ask(ALLOWLIST_ASK) : touchesHooks(ctx, target, target) ? ask(HOOKS_ASK) : { kind: 'allow' };
    if (!isShell(ctx.input.tool_name)) return { kind: 'allow' };
    const command = String(ctx.input.tool_input?.command ?? '');
    const k = kinds(command, ctx);
    if (k.has('commit') || k.has('stash')) {
      const why = notPlain(command);
      const d = why ? deny(why + '.') : scan(ctx, k.has('commit') ? commitUse(command) : { editor: false, signFlag: false, verboseFlag: false });
      if (d.kind !== 'allow') return d;
    }
    if (k.has('ask')) return ask('This git command makes commits from content harness can\'t scan for secrets before they are made (a merge, rebase, cherry-pick, revert, am, pull, commit-tree, a stash create, a git alias or a git named at run time). Confirm it.');
    return mentionsAllowlist(command) ? ask(ALLOWLIST_ASK) : touchesHooks(ctx, command) ? ask(HOOKS_ASK) : { kind: 'allow' };
  },
};
