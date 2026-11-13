import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { secretScan } from '../../src/checks/secret-scan.js';
import { defaults } from '../../src/core/config.js';
import type { Ctx } from '../../src/hooks/dispatch.js';

// A full secret scan before `git commit` (git calls, the throwaway index, gitleaks) has to fit the ~9 s hook budget on
// every platform. A stand-in gitleaks runs gitleaks's own git diff, so the git work is real; the real gitleaks adds its
// own start-up and rule compile on top. The ceiling catches extra git spawns, not a few ms.
const CEILING_MS = { win32: 4000, darwin: 1500 }[process.platform as string] ?? 1500;
const RUNS = 7;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const dirs: string[] = [];
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function stub(): string {
  const dir = temp('scan-perf-stub-');
  writeFileSync(join(dir, 'gitleaks.js'), "const { execFileSync } = require('node:child_process'); const a = process.argv.slice(2); execFileSync('git', ['-C', a[a.length - 1], 'diff', '-U0', '--no-ext-diff', '--staged', '.']);\n");
  if (process.platform === 'win32') writeFileSync(join(dir, 'gitleaks.cmd'), '@node "%~dp0gitleaks.js" %*\r\n');
  else writeFileSync(join(dir, 'gitleaks'), `#!/bin/sh\nexec node "${join(dir, 'gitleaks.js')}" "$@"\n`, { mode: 0o755 });
  return dir;
}

test('a full scan before git commit stays well inside the hook budget', () => {
  const root = temp('scan-perf-repo-');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  for (let i = 0; i < 200; i++) writeFileSync(join(root, `f${i}.txt`), `line ${i}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(root, 'f1.txt'), 'staged\n');
  git('add', 'f1.txt');
  // No system or global git config: this measures speed, not config policy (Git for Windows' system config sets a textconv).
  const empty = join(temp('scan-perf-cfg-'), 'empty');
  writeFileSync(empty, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, PATH: `${stub()}${delimiter}${process.env.PATH ?? ''}` };
  const time = (command: string) => {
    const ms: number[] = [];
    for (let n = 0; n < RUNS; n++) {
      const config = defaults();
      config.checks.secretScan = true;
      const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command } };
      const t0 = performance.now();
      const d = secretScan.run({ input, root, config, unattended: false, env, platform: process.platform, startedAt: Date.now() } as unknown as Ctx) as { kind: string; reason?: string };
      ms.push(performance.now() - t0);
      expect(d.kind, d.reason).toBe('allow');
    }
    return median(ms);
  };
  const one = time('git commit -m x'); // the worktree adds nothing: one gitleaks run
  writeFileSync(join(root, 'f2.txt'), 'unstaged\n');
  const two = time('git commit -m x'); // an unstaged change: the real and the throwaway index are both scanned
  console.log(`secret scan median: ${one.toFixed(0)} ms (one index), ${two.toFixed(0)} ms (two), ceiling ${CEILING_MS} ms`);
  expect(one).toBeLessThan(CEILING_MS);
  expect(two).toBeLessThan(CEILING_MS);
}, 120_000); // setting up the repo is slow on Windows runners; only the scans are timed
