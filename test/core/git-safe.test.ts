import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { realIO } from '../../src/budget/imports.js';
import { verifyPackages } from '../../src/checks/dep-verify.js';
import { measure } from '../../src/checks/pr-size/measure.js';
import { protect } from '../../src/checks/protect.js';
import { diffCoverage } from '../../src/checks/stop/diff-coverage.js';
import { defaultExec, type Exec, runStop } from '../../src/checks/stop/gate.js';
import { report } from '../../src/cli/report.js';
import { defaults, loadConfig } from '../../src/core/config.js';
import { gitIn, staleness } from '../../src/core/decisions-stale.js';
import { gitHead } from '../../src/core/harness-files.js';
import { gitRoot } from '../../src/core/repo-root.js';
import { readState } from '../../src/core/state.js';
import type { Ctx } from '../../src/hooks/dispatch.js';
import { detectBaseHead } from '../../src/hooks/session-setup.js';
import { detect } from '../../src/install/detect.js';
import { dirtyPaths } from '../../src/install/git-status.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();

/**
 * A repo whose .git/config points every program-running key at a script that appends to `marker`, with a
 * post-index-change hook (in .git/hooks, or in a core.hooksPath dir) and a stat-dirty file so a refresh would write the index.
 * HEAD is a (fake) signed commit.
 */
function poisoned(hooksPath: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'h-gitsafe-'));
  roots.push(dir);
  const root = join(dir, 'r'), marker = join(dir, 'marker'), evil = join(dir, 'evil.sh');
  writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 1\n`);
  chmodSync(evil, 0o755);
  mkdirSync(join(root, 'docs/decisions'), { recursive: true });
  mkdirSync(join(root, 'src'));
  git(dir, 'init', '-q', '-b', 'main', root);
  writeFileSync(join(root, 'src/a.ts'), 'one\n');
  writeFileSync(join(root, 'same.txt'), 'same\n');
  writeFileSync(join(root, 'docs/decisions/2026-11-01-a.md'), 'x\n');
  writeFileSync(join(root, '.gitattributes'), 'src/* diff=evil\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const body = git(root, 'cat-file', 'commit', 'HEAD').replace(/^(committer .*)$/m, '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n x\n -----END PGP SIGNATURE-----');
  const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: root, input: `${body}\n`, encoding: 'utf8' }).trim();
  git(root, 'update-ref', 'HEAD', sha);
  git(root, 'update-ref', 'refs/remotes/origin/main', sha);
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  writeFileSync(join(root, 'src/a.ts'), 'two\n');
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'same.txt'), later, later); // stat-dirty, content unchanged: a refresh rewrites the index
  const hooks = hooksPath ? join(dir, 'hooks') : join(root, '.git/hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'post-index-change'), readFileSync(evil, 'utf8'));
  chmodSync(join(hooks, 'post-index-change'), 0o755);
  if (hooksPath) git(root, 'config', 'core.hooksPath', hooks);
  for (const k of ['core.fsmonitor', 'diff.external', 'diff.evil.textconv', 'diff.evil.command', 'gpg.program']) git(root, 'config', k, evil);
  git(root, 'config', 'log.showSignature', 'true');
  return { root, marker, sha };
}

const stopCtx = (root: string, baseHead: string): Ctx => {
  const config = loadConfig(root).config;
  config.stop = { ...config.stop, steps: [], package_manager: 'none' };
  config.checks.tdd = false;
  const ctx = { input: { session_id: 's', cwd: root, hook_event_name: 'Stop' }, root, config, state: { ...readState(root, 's'), baseHead }, unattended: false, env: {}, save(s) { ctx.state = s; } } as Ctx;
  return ctx;
};

describe.skipIf(process.platform === 'win32').each([false, true])('a repo config never makes harness run a program (core.hooksPath: %s)', (hooksPath) => {
  test('the sanity check: plain git status and diff do run the scripts', () => {
    const { root, marker } = poisoned(hooksPath);
    execFileSync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain'], { cwd: root, stdio: 'ignore' });
    expect(readFileSync(marker, 'utf8')).toContain('post-index-change');
    rmSync(marker);
    try { execFileSync('git', ['diff'], { cwd: root, stdio: 'ignore' }); } catch { /* the script exits 1 */ }
    expect(existsSync(marker)).toBe(true);
  });

  test('every harness git path leaves the marker unwritten', async () => {
    const { root, marker, sha } = poisoned(hooksPath);
    expect(dirtyPaths(root)).toEqual(['src/a.ts']);
    expect(gitRoot(root)).toBeTruthy();
    expect(gitHead(root)).toBe(sha);
    expect(detectBaseHead(root)).toBe(sha);
    expect(realIO.lsFiles(root)).toContain('src/a.ts');
    expect(gitIn(root)(['rev-parse', 'HEAD']).out.trim()).toBe(sha);
    const cfg = defaults();
    expect(measure(root, { worktree: true }, { pr_size: cfg.pr_size, multi_file_gate: { generated: [] }, stop: cfg.stop })).toMatchObject({ files: 1 });
    const dec = { id: '2026-11-01-a', title: 't', status: 'active' as const, paths: ['src/**'], verified_at: sha, verified_on: '2026-11-01', body: 'b', rel: 'docs/decisions/2026-11-01-a.md' };
    expect(staleness(root, [dec], { today: '2026-11-10', expiryDays: 90, cap: 20 }).note).toBeNull();
    const c = loadConfig(root).config;
    c.tdd = { ...c.tdd, paths: ['src/**'] };
    await diffCoverage(root, c, defaultExec(root), { baseHead: sha, since: Date.now() / 1000 });
    // dep-verify's ls-files; the registry lookup is injected (no network).
    expect(verifyPackages(['left-pad'], { root, now: new Date(), lookup: () => ({ exists: true, created: '2000-01-01T00:00:00Z' }) }).kind).toBeTruthy();
    // protect's switch check: rev-parse and cat-file on the target ref.
    const pre = { input: { session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git checkout main' } }, root, config: loadConfig(root).config } as unknown as Ctx;
    expect(protect.run(pre)).toMatchObject({ kind: 'ask' });
    // The stop gate's status and diff; only git is really run.
    const onlyGit: Exec = (cmd, args, ms) => (cmd === 'git' ? defaultExec(root)(cmd, args, ms) : { status: 0, output: '', timedOut: false });
    await runStop(stopCtx(root, sha), onlyGit);
    expect(detect(root).defaultBranch).toBe('main');
    const home = mkdtempSync(join(tmpdir(), 'h-gitsafe-home-'));
    roots.push(home);
    await report([], { root, env: {}, out: () => undefined, home }); // its default git runs worktree list
    expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
  });
});

/**
 * Code with comments removed (newlines kept, so line numbers hold) and strings kept. Strings and regex literals are walked,
 * so a `//` in a URL or a quote inside /["']/ never starts a comment or a string.
 */
function stripComments(s: string): string {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i]!, n = s[i + 1];
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2), end = e < 0 ? s.length : e + 2; out += s.slice(i, end).replace(/[^\n]/g, ''); i = end; continue; }
    if (c === '/' && /(^|[(,=:[!&|?{};]|return)\s*$/.test(out.slice(-12))) { // a regex literal
      let j = i + 1, cls = false;
      while (j < s.length && s[j] !== '\n' && (cls || s[j] !== '/')) { if (s[j] === '\\') j++; else if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false; j++; }
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

const SPAWN = String.raw`\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|defaultExec|defaultExecBytes|syncCommand)\s*\(\s*`;
const GIT_STR = String.raw`(?:'git'|"git"|\x60git\x60)`;

/** Each spawn whose program is git (a literal or a const bound to one), with whether its argv starts with ...SAFE_GIT. */
function gitSpawns(code: string): { at: number; safe: boolean }[] {
  const aliases = [...code.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*${GIT_STR}`, 'g'))].map((m) => m[1]!);
  const prog = aliases.length ? `(?:${GIT_STR}|\\b(?:${aliases.join('|')})\\b)` : GIT_STR;
  return [...code.matchAll(new RegExp(`${SPAWN}${prog}\\s*,\\s*(\\S{0,24})`, 'g'))].map((m) => ({ at: m.index!, safe: /^\[\s*\.\.\.SAFE_GIT(?:_USER)?\b/.test(m[1]!) }));
}
/** Each 'diff' string in code outside a `new Set([...])`, with whether ...SAFE_DIFF follows it. */
function diffArgs(code: string): { at: number; safe: boolean }[] {
  return [...code.matchAll(/(?:'diff'|"diff"|`diff`)(\s*[,\]]\s*(?:\.\.\.SAFE_DIFF\b)?)?/g)]
    .filter((m) => !/new\s+Set\(\s*$/.test(code.slice(0, code.lastIndexOf('[', m.index!))))
    .map((m) => ({ at: m.index!, safe: /^\s*,\s*\.\.\.SAFE_DIFF\b/.test(m[1] ?? '') }));
}

describe('source scan: no git spawn skips the flags', () => {
  test('the scanner catches multi-line calls, an alias for git, a closing bracket after diff and a comment-only mention', () => {
    const bad = stripComments([
      "spawnSync(\n  'git',\n  ['status'], {});",
      "const G = 'git';\nexecFileSync(G, ['ls-files']);",
      "execFileSync('git', args); // SAFE_GIT",
      "run(['-c', 'x', 'diff']);",
      'run(["diff", "--name-only"]); /* ...SAFE_DIFF */',
      "const Q = /[\\\"']/; execFileSync('git', x);",
    ].join('\n'));
    expect(gitSpawns(bad).filter((s) => !s.safe)).toHaveLength(4);
    expect(diffArgs(bad).filter((d) => !d.safe)).toHaveLength(2);
    const good = stripComments("spawnSync(\n 'git',\n [...SAFE_GIT, 'diff', ...SAFE_DIFF]);\nconst R = new Set(['status', 'diff']);\nconst u = 'https://x//y';");
    expect([...gitSpawns(good), ...diffArgs(good)].every((s) => s.safe)).toBe(true);
    expect(good).toContain('https://x//y');
  });

  test('every git spawn in src starts with SAFE_GIT, every git diff adds SAFE_DIFF', () => {
    const src = join(__dirname, '../../src');
    const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
    const bad: string[] = [];
    let spawns = 0;
    for (const f of files(src)) {
      const code = stripComments(readFileSync(f, 'utf8'));
      const line = (at: number) => code.slice(0, at).split('\n').length;
      for (const s of gitSpawns(code)) { spawns++; if (!s.safe) bad.push(`${f} ~${line(s.at)}`); }
      for (const d of diffArgs(code)) if (!d.safe) bad.push(`${f} ~${line(d.at)} (diff)`);
    }
    expect(bad).toEqual([]);
    expect(spawns).toBeGreaterThanOrEqual(18); // the scan still sees the real sites
  });
});
