// With sandbox.filesystem.denyWrite on harness's files, a harness command the agent runs in Bash (remember, tdd on, …)
// can hit EPERM. The command then prints the person's own `!` command. The `!` line runs outside the sandbox, so it names
// only the trusted CLI (the repo's own node_modules install) and fires only for EPERM on a denyWrite path.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { deniedHint, isDenied, ownCommand } from '../../src/cli/own-command.js';

const repo = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'h-denied-')));
const err = (code: string, path?: string, dest?: string) => Object.assign(new Error(`${code}: operation not permitted`), { code, path, dest });

test('EPERM on a denyWrite path gives the `!` line with that command, naming npx when no trusted CLI is recorded', () => {
  const root = repo();
  const h = deniedHint(['remember', 'add', '--title', 'x y'], err('EPERM', join(root, '.harness/state/memory.json')), root);
  expect(h).toBe("Claude Code's sandbox blocks harness's own files. Run this yourself with Claude Code's `!` prefix (a `!` command runs outside the sandbox): npx @khubaibqaiser/harness remember add --title 'x y'");
  expect(h).not.toContain(process.argv[1]); // whatever ran this process could be the agent's own copy
  expect(deniedHint(['tdd', 'on'], { cause: err('EPERM', join(root, '.harness/config.yaml')) }, root)).toMatch(/ tdd on$/);
  // Linux bwrap mounts denied paths read-only, so the write fails with EROFS.
  expect(deniedHint(['tdd', 'on'], err('EROFS', join(root, '.harness/config.yaml')), root)).toMatch(/ tdd on$/);
  expect(deniedHint(['tdd', 'on'], err('EROFS', join(root, 'src/a.ts')), root)).toBeNull();
  // An atomic write renames a temp file onto the denied path: the rename's dest is what the sandbox denies.
  expect(deniedHint(['tdd', 'on'], err('EPERM', join(root, '.harness/config.yaml.tmp-1'), join(root, '.harness/config.yaml')), root)).toMatch(/ tdd on$/);
});

test('EACCES, EPERM elsewhere (writable harness folders, outside the repo), no path, and other errors give no `!` line', () => {
  const root = repo();
  expect(deniedHint(['tdd', 'on'], err('EACCES', join(root, '.harness/config.yaml')), root)).toBeNull();
  for (const p of ['.harness/reviews/r.md', '.harness/results/x.json', '.harness/logs/events.jsonl', '.harness/tmp/a', 'src/a.ts', '.harness/hooksX']) {
    expect(deniedHint(['review'], err('EPERM', join(root, p)), root), p).toBeNull();
  }
  expect(deniedHint(['review'], err('EPERM', '/etc/hosts'), root)).toBeNull();
  expect(deniedHint(['review'], err('EPERM'), root)).toBeNull();
  expect(deniedHint(['status'], err('ENOENT', join(root, '.harness/config.yaml')), root)).toBeNull();
  expect(deniedHint(['status'], new Error('boom'), root)).toBeNull();
});

test('the `!` line names the recorded trusted CLI, never an untrusted one', () => {
  const root = repo();
  const cli = join(root, 'node_modules/@khubaibqaiser/harness/dist/cli.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '');
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  writeFileSync(join(root, '.harness/state/cli-path'), cli);
  expect(ownCommand('tdd', ['on'], root)).toMatch(new RegExp(`: node "${cli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" tdd on$`));
  const evil = join(root, 'tmp/evil/dist/cli.mjs');
  mkdirSync(dirname(evil), { recursive: true });
  writeFileSync(evil, '');
  writeFileSync(join(root, '.harness/state/cli-path'), evil);
  expect(ownCommand('tdd', ['on'], root)).toMatch(/: npx @khubaibqaiser\/harness tdd on$/);
});

test('isDenied (apply errors) counts EPERM, EACCES and EROFS', () => {
  for (const c of ['EPERM', 'EACCES', 'EROFS']) expect(isDenied(err(c)), c).toBe(true);
  expect(isDenied({ cause: err('EROFS') })).toBe(true);
  expect(isDenied(err('ENOENT'))).toBe(false);
});
