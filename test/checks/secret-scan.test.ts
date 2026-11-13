import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { secretScan } from '../../src/checks/secret-scan.js';
import { defaults } from '../../src/core/config.js';
import { registry } from '../../src/hooks/dispatch.js';
import type { Ctx } from '../../src/hooks/dispatch.js';
import { makeRepo } from '../install/helpers.js';

// Built at run time so no source file holds a token-shaped literal (this repo's own CI runs gitleaks on its history).
const TOKEN = 'ghp' + '_' + 'Fak3T0k3nF0rT3sts'.padEnd(36, 'x');
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

/** A stand-in gitleaks on PATH: it reads the index git diff --cached sees (GIT_INDEX_FILE included), "finds" TOKEN, and
 *  writes an unredacted report and prints the value, so a test proves the check never repeats either. */
function stubBin(): { dir: string; argsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-gitleaks-stub-'));
  const argsFile = join(dir, 'args.json');
  const js = `const { execFileSync } = require('node:child_process'); const fs = require('node:fs');
const a = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(a));
const diff = execFileSync('git', ['diff', '--cached'], { cwd: a[a.length - 1], encoding: 'utf8' });
const m = /ghp_[A-Za-z0-9]{36}/.exec(diff);
if (!m) process.exit(0);
const report = a[a.indexOf('--report-path') + 1];
fs.writeFileSync(report, JSON.stringify([{ RuleID: 'github-pat', File: 'config/leak.txt', StartLine: 1, Secret: m[0], Match: m[0] }]));
console.log('leak ' + m[0]); console.error('leak ' + m[0]);
process.exit(Number(a[a.indexOf('--exit-code') + 1]));
`;
  writeFileSync(join(dir, 'gitleaks.js'), js);
  if (process.platform === 'win32') writeFileSync(join(dir, 'gitleaks.cmd'), '@node "%~dp0gitleaks.js" %*\r\n');
  else writeFileSync(join(dir, 'gitleaks'), `#!/bin/sh\nexec node "${join(dir, 'gitleaks.js')}" "$@"\n`, { mode: 0o755 });
  return { dir, argsFile };
}

function ctx(root: string, command: string, env: NodeJS.ProcessEnv, on = true): Ctx {
  const config = defaults();
  config.checks.secretScan = on;
  const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command } };
  return { input, root, config, unattended: false, env, platform: process.platform, startedAt: Date.now() } as unknown as Ctx;
}
const run = (c: Ctx) => secretScan.run(c) as ReturnType<typeof secretScan.run> & { kind: string; reason?: string };
const withStub = (s: { dir: string }) => ({ ...process.env, PATH: `${s.dir}${delimiter}${process.env.PATH ?? ''}` });

describe('secret-scan', () => {
  test('is registered, PreToolUse only, and fails closed', () => {
    expect(registry).toContain(secretScan);
    expect(secretScan.events).toEqual(['PreToolUse']);
    expect(secretScan.failClosed).toBe(true);
  });

  test('blocks a commit with a staged secret and never shows the value', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, 'leak.txt'), `token = ${TOKEN}\n`);
    git(root, 'add', 'leak.txt');
    const s = stubBin();
    const d = run(ctx(root, 'git commit -m "add config"', withStub(s)));
    expect(d.kind).toBe('deny');
    expect(d.reason).toContain('github-pat');
    expect(d.reason).toContain('`config/leak.txt` line 1');
    expect(d.reason).not.toContain(TOKEN);
    const args = JSON.parse(readFileSync(s.argsFile, 'utf8')) as string[];
    expect(args.slice(0, 4)).toEqual(['git', '--pre-commit', '--staged', '--redact']);
  });

  test('scans what the same command line stages: an untracked file added with git add, and commit -a', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, 'new.txt'), `token = ${TOKEN}\n`);
    const s = stubBin();
    expect(run(ctx(root, 'git add new.txt && git commit -m x', withStub(s))).kind).toBe('deny');
    expect(git(root, 'diff', '--cached', '--name-only')).toBe(''); // the throwaway index left the real one alone
    writeFileSync(join(root, 'README.md'), `hi ${TOKEN}\n`);
    git(root, 'rm', '-q', '--cached', '--ignore-unmatch', 'new.txt');
    expect(run(ctx(root, 'git commit -am x', withStub(s))).kind).toBe('deny');
  });

  test('a secret in an ignored file does not block', () => {
    const root = makeRepo({ 'README.md': 'hi\n', '.gitignore': '.env\n' });
    writeFileSync(join(root, '.env'), `TOKEN=${TOKEN}\n`);
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub(stubBin()))).kind).toBe('allow');
  });

  test('passes clean changes', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, 'a.txt'), 'nothing secret\n');
    git(root, 'add', 'a.txt');
    expect(run(ctx(root, 'git commit -m clean', withStub(stubBin()))).kind).toBe('allow');
  });

  test('blocks with the install message when gitleaks is missing', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const empty = mkdtempSync(join(tmpdir(), 'harness-nopath-'));
    const d = run(ctx(root, 'git commit -m x', { PATH: empty }));
    expect(d.kind).toBe('deny');
    expect(d.reason).toContain('gitleaks is not on PATH');
    expect(d.reason).toContain('brew install gitleaks');
    expect(d.reason).toContain('harness remove gitleaks-commit');
  });

  test('a gitleaks error or crash blocks too', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const s = stubBin();
    writeFileSync(join(s.dir, 'gitleaks.js'), 'console.error("boom"); process.exit(1);\n');
    const d = run(ctx(root, 'git commit -m x', withStub(s)));
    expect(d.kind).toBe('deny');
    expect(d.reason).toContain('could not scan');
  });

  test('other commands, and the check turned off, never run gitleaks', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const empty = { PATH: mkdtempSync(join(tmpdir(), 'harness-nopath-')) };
    for (const cmd of ['git status', 'git log --grep commit', 'echo git commit', 'ls']) expect(run(ctx(root, cmd, empty)).kind, cmd).toBe('allow');
    expect(run(ctx(root, 'git commit -m x', empty, false)).kind).toBe('allow');
  });

  test('reads git commit past global options, a path, a wrapper and sh -c', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const empty = { PATH: mkdtempSync(join(tmpdir(), 'harness-nopath-')) };
    for (const cmd of ['git -C . commit -m x', '/usr/bin/git commit -m x', 'env A=1 git commit -m x', 'sh -c "git commit -m x"', 'git -c user.name=a commit -m x', '$GIT commit -m x'])
      expect(run(ctx(root, cmd, empty)).kind, cmd).toBe('deny');
  });

  test('leaves no temp folder behind', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const s = stubBin();
    run(ctx(root, 'git commit -m x', withStub(s)));
    const args = JSON.parse(readFileSync(s.argsFile, 'utf8')) as string[];
    expect(existsSync(args[args.indexOf('--report-path') + 1])).toBe(false);
  });
});
