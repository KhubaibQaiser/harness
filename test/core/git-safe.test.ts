import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { realIO } from '../../src/budget/imports.js';
import { measure } from '../../src/checks/pr-size/measure.js';
import { diffCoverage } from '../../src/checks/stop/diff-coverage.js';
import { defaultExec } from '../../src/checks/stop/gate.js';
import { defaults, loadConfig } from '../../src/core/config.js';
import { staleness } from '../../src/core/decisions-stale.js';
import { gitHead } from '../../src/core/harness-files.js';
import { gitRoot } from '../../src/core/repo-root.js';
import { detectBaseHead } from '../../src/hooks/session-setup.js';
import { dirtyPaths } from '../../src/install/git-status.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();

/** A repo whose .git/config points every program-running key at a script that appends to `marker`. HEAD is a (fake) signed commit. */
function poisoned() {
  const dir = mkdtempSync(join(tmpdir(), 'h-gitsafe-'));
  roots.push(dir);
  const root = join(dir, 'r'), marker = join(dir, 'marker'), evil = join(dir, 'evil.sh');
  writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 1\n`);
  chmodSync(evil, 0o755);
  mkdirSync(join(root, 'docs/decisions'), { recursive: true });
  mkdirSync(join(root, 'src'));
  git(dir, 'init', '-q', '-b', 'main', root);
  writeFileSync(join(root, 'src/a.ts'), 'one\n');
  writeFileSync(join(root, 'docs/decisions/2026-11-01-a.md'), 'x\n');
  writeFileSync(join(root, '.gitattributes'), 'src/* diff=evil\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const body = git(root, 'cat-file', 'commit', 'HEAD').replace(/^(committer .*)$/m, '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n x\n -----END PGP SIGNATURE-----');
  const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: root, input: `${body}\n`, encoding: 'utf8' }).trim();
  git(root, 'update-ref', 'HEAD', sha);
  git(root, 'update-ref', 'refs/remotes/origin/main', sha);
  writeFileSync(join(root, 'src/a.ts'), 'two\n');
  for (const k of ['core.fsmonitor', 'diff.external', 'diff.evil.textconv', 'diff.evil.command', 'gpg.program']) git(root, 'config', k, evil);
  git(root, 'config', 'log.showSignature', 'true');
  return { root, marker, sha };
}

describe.skipIf(process.platform === 'win32')('a repo config never makes harness run a program', () => {
  test('the sanity check: plain git does run the script', () => {
    const { root, marker } = poisoned();
    try { execFileSync('git', ['diff'], { cwd: root, stdio: 'ignore' }); } catch { /* the script exits 1 */ }
    expect(existsSync(marker)).toBe(true);
  });

  test('every harness git path leaves the marker unwritten', async () => {
    const { root, marker, sha } = poisoned();
    expect(dirtyPaths(root)).toEqual(['src/a.ts']);
    expect(gitRoot(root)).toBeTruthy();
    expect(gitHead(root)).toBe(sha);
    expect(detectBaseHead(root)).toBe(sha);
    expect(realIO.lsFiles(root)).toContain('src/a.ts');
    const cfg = defaults();
    expect(measure(root, { worktree: true }, { pr_size: cfg.pr_size, multi_file_gate: { generated: [] }, stop: cfg.stop })).toMatchObject({ files: 1 });
    const dec = { id: '2026-11-01-a', title: 't', status: 'active' as const, paths: ['src/**'], verified_at: sha, verified_on: '2026-11-01', body: 'b', rel: 'docs/decisions/2026-11-01-a.md' };
    expect(staleness(root, [dec], { today: '2026-11-10', expiryDays: 90, cap: 20 }).note).toBeNull();
    const c = loadConfig(root).config;
    c.tdd = { ...c.tdd, paths: ['src/**'] };
    await diffCoverage(root, c, defaultExec(root), { baseHead: sha, since: Date.now() / 1000 });
    expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('');
  });
});

// The behaviour test above covers the paths a fixture can reach; this one makes sure no git spawn skips the flags.
test('every git spawn in src starts with SAFE_GIT, every git diff adds SAFE_DIFF', () => {
  const src = join(__dirname, '../../src');
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const bad: string[] = [];
  for (const f of files(src)) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/\b(spawnSync|execFileSync|spawn|exec|defaultExec)\(\s*'git',/.test(line) && !line.includes('SAFE_GIT')) bad.push(`${f}:${i + 1}`);
      if (/'diff',/.test(line) && /git|run\(|q = /.test(line) && !/SAFE_DIFF|GIT_READ|READ_ONLY/.test(line)) bad.push(`${f}:${i + 1} (diff)`);
    });
  }
  expect(bad).toEqual([]);
});
