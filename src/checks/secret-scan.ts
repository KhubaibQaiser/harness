// secret-scan (the gitleaks-commit item): before an agent `git commit`, gitleaks scans every change the commit could
// take. PreToolUse runs before a `git add … && git commit` on the same line stages anything, so the scan stages the
// whole worktree (`git add -A`, which honours .gitignore) into a throwaway index and scans that. Fails closed: no
// gitleaks, a gitleaks error or a timeout denies. A matched value never reaches a message: only rule, file and line.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { esc } from '../core/config.js';
import { SAFE_GIT } from '../core/git-safe.js';
import type { Check, Ctx } from '../hooks/dispatch.js';
import { isShell } from '../hooks/edit-target.js';
import type { Decision } from '../hooks/types.js';
import { runnerName, type Seg, walkCommands } from './guard.js';
import { hookBudgetMs } from './pr-size/measure.js';
import { findOnPath, syncCommand } from './stop/runner.js';

const SHOWN = 5;
const LEAK_EXIT = 2; // gitleaks exits 1 on its own errors too, so a finding gets a code of its own
const OFF = 'or turn the check off by running `harness remove gitleaks-commit` in your terminal';
const MISSING = `gitleaks is not on PATH, so this commit can't be scanned for secrets, and harness never skips the scan. Install gitleaks 8.30.1 (\`brew install gitleaks\`, or the release binary from https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1 checked against its checksums.txt), ${OFF}.`;
const deny = (why: string): Decision => ({ kind: 'deny', check: 'secret-scan', reason: `Blocked by secret-scan: ${why}` });

/** A `git commit` segment: git past its global options, or a command the shell names at run time with `commit` in it. */
function commitIn({ toks, k, prev }: Seg): true | null {
  const head = toks[k] ?? '';
  if (head.startsWith('$') || (k === 0 && (prev === ')' || prev === '`'))) return toks.includes('commit') || null;
  if (runnerName(head) !== 'git') return null;
  let i = k + 1;
  while (i < toks.length && toks[i]!.startsWith('-')) i += /^(-[Cc]|--git-dir|--work-tree|--namespace)$/.test(toks[i]!) ? 2 : 1;
  return toks[i] === 'commit' || null;
}

const commits = (command: string, ctx: Ctx): boolean =>
  walkCommands(command, { root: ctx.root, env: ctx.env }, commitIn, { whole: (w) => (w.includes('eval') && w.includes('commit') ? true : null) }) === true;

type Finding = { RuleID?: unknown; File?: unknown; StartLine?: unknown };
function found(report: string): string {
  let list: Finding[];
  try {
    list = JSON.parse(readFileSync(report, 'utf8')) as Finding[];
  } catch {
    list = [];
  }
  if (!Array.isArray(list) || !list.length) return 'gitleaks reported a finding but its report could not be read';
  const shown = list.slice(0, SHOWN).map((f) => `${esc(String(f.RuleID))} in \`${esc(String(f.File))}\` line ${Number(f.StartLine) || '?'}`);
  const more = list.length > SHOWN ? `, and ${list.length - SHOWN} more` : '';
  return `gitleaks found ${list.length} likely secret${list.length > 1 ? 's' : ''} in the changes this commit could take (staged, unstaged or untracked files that are not ignored): ${shown.join('; ')}${more}. Values are not shown. Remove the secret and rotate it if it was ever pushed; for a false positive, add a \`gitleaks:allow\` comment on the line or an allowlist in .gitleaks.toml`;
}

function scan(ctx: Ctx): Decision {
  const platform = ctx.platform ?? process.platform;
  const bin = findOnPath('gitleaks', ctx.env, platform);
  if (!bin) return deny(MISSING);
  const left = () => hookBudgetMs(ctx.startedAt, Date.now);
  const dir = mkdtempSync(join(tmpdir(), 'harness-gitleaks-'));
  try {
    const env = { ...ctx.env, GIT_INDEX_FILE: join(dir, 'index') };
    const git = (args: string[]) => spawnSync('git', [...SAFE_GIT, ...args], { cwd: ctx.root, env, encoding: 'utf8', timeout: Math.max(1, left()), stdio: ['ignore', 'pipe', 'pipe'] });
    const where = spawnSync('git', [...SAFE_GIT, 'rev-parse', '--git-path', 'index'], { cwd: ctx.root, env: ctx.env, encoding: 'utf8', timeout: Math.max(1, left()) });
    if (where.status !== 0) return deny(`could not scan this commit for secrets: git rev-parse failed (${esc((where.stderr || String(where.error ?? '')).trim().split('\n')[0] ?? '')}), ${OFF}.`);
    const real = resolve(ctx.root, where.stdout.trim());
    if (existsSync(real)) copyFileSync(real, env.GIT_INDEX_FILE); // keeps what is staged, deletions and intent-to-add included
    const add = git(['add', '-A']);
    if (add.status !== 0) return deny(`could not scan this commit for secrets: git add into a throwaway index failed or timed out (${esc((add.stderr || String(add.error ?? '')).trim().split('\n')[0] ?? '')}), ${OFF}.`);
    const report = join(dir, 'report.json');
    const args = ['git', '--pre-commit', '--staged', '--redact', '--no-banner', '--exit-code', String(LEAK_EXIT), '--report-format', 'json', '--report-path', report, ctx.root];
    const [file, a, opts] = platform === 'win32' ? syncCommand('gitleaks', args, platform, ctx.env) : [bin, args, {}];
    const ms = left();
    if (ms <= 0) return deny(`could not scan this commit for secrets in the hook's time budget, ${OFF}.`);
    // gitleaks output is never shown: with a broken --redact it could still carry a value.
    const r = spawnSync(file, a, { ...opts, cwd: ctx.root, env, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'ignore', 'ignore'] });
    if (r.status === 0) return { kind: 'allow' };
    if (r.status === LEAK_EXIT) return deny(found(report) + '.');
    const why = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'gitleaks timed out' : `gitleaks exited ${r.status ?? r.signal ?? 'abnormally'}`;
    return deny(`could not scan this commit for secrets: ${why}. Run \`gitleaks git --pre-commit --staged --redact\` in your terminal to see why, ${OFF}.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const secretScan: Check = {
  name: 'secret-scan',
  events: ['PreToolUse'],
  failClosed: true,
  run(ctx) {
    if (!ctx.config?.checks.secretScan || !isShell(ctx.input.tool_name)) return { kind: 'allow' };
    return commits(String(ctx.input.tool_input?.command ?? ''), ctx) ? scan(ctx) : { kind: 'allow' };
  },
};
