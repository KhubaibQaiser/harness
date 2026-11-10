import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Prompt } from '../../src/cli/prompt.js';
import { remember, type RememberEnv } from '../../src/cli/remember.js';
import { decisionLines, list } from '../../src/cli/remember-read.js';
import { defaults } from '../../src/core/config.js';
import { TODAY, decision, installedRepo, writeDecision } from '../core/decisions-helpers.js';

const ID = `${TODAY}-validate-env`;
const DEC = `docs/decisions/${ID}.md`;
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const prompt: Prompt & { asked: number } = { asked: 0, async confirm() { prompt.asked++; return false; }, async edit(_l, v) { return v; } };
const commitAll = (root: string, m: string) => (git(root, 'add', '-A'), git(root, 'commit', '-q', '-m', m));

async function go(root: string, args: string[], extra: Partial<RememberEnv> = {}) {
  const lines: string[] = [];
  const code = await remember(args, { root, env: {}, out: (s) => lines.push(s), prompt, now: () => new Date(`${TODAY}T12:00:00Z`), ...extra });
  return { code, out: lines.join('\n') };
}

/** Installed, one decision added through the CLI (verified_at = HEAD), all committed. */
async function repo(): Promise<string> {
  const root = await installedRepo();
  mkdirSync(join(root, 'src/env'), { recursive: true });
  writeFileSync(join(root, 'src/env/schema.ts'), 'export {};\n');
  writeFileSync(join(root, 'src/config.ts'), 'export {};\n');
  commitAll(root, 'installed');
  expect((await go(root, ['add', '--title', 'Validate env', '--rule', 'R.', '--path', 'src/env/**', '--path', 'src/config.ts', '--yes'])).code).toBe(0);
  commitAll(root, 'decision');
  return root;
}

test('check: a clean repo exits 0 with the summary', async () => {
  const root = await repo();
  expect(await go(root, ['check'])).toEqual({ code: 0, out: 'ok decisions: 1 active, rules in sync\n1 decisions: 0 errors, 0 stale, 0 expired, 0 oversized, rules in sync' });
  expect(decisionLines(root, defaults(), TODAY).summary).toEqual({ n: 1, errors: 0, stale: 0, expired: 0, oversized: 0, inSync: true });
});

test('check: no decisions', async () => {
  const root = await installedRepo();
  expect(await go(root, ['check'])).toEqual({ code: 0, out: 'ok no team decisions yet\n0 decisions: 0 errors, 0 stale, 0 expired, 0 oversized, rules in sync' });
});

test('check: an invalid file exits 1', async () => {
  const root = await repo();
  writeFileSync(join(root, 'docs/decisions/2026-11-04-bad.md'), '---\nschema: harness-decision/1\nid: nope\n---\n');
  const r = await go(root, ['check']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('fix docs/decisions/2026-11-04-bad.md: id must match YYYY-MM-DD-<slug of a-z, 0-9 and ->: correct it by hand, then run harness remember sync');
  expect(r.out.split('\n').at(-1)).toBe('1 decisions: 1 errors, 0 stale, 0 expired, 0 oversized, rules in sync');
});

test('check: rules out of sync exits 1', async () => {
  const root = await repo();
  writeFileSync(join(root, DEC), readFileSync(join(root, DEC), 'utf8').replace('R.', 'S.'));
  const r = await go(root, ['check']);
  expect(r.code).toBe(1);
  expect(r.out.split('\n')).toEqual([
    'fix decision rules are out of sync with docs/decisions/: run harness remember sync',
    'ok decisions: 1 active, rules out of sync',
    '1 decisions: 0 errors, 0 stale, 0 expired, 0 oversized, rules out of sync',
  ]);
});

test('check: stale, expired and oversized are notes and exit 0', async () => {
  const root = await repo();
  writeFileSync(join(root, '.harness/config.yaml'), readFileSync(join(root, '.harness/config.yaml'), 'utf8').replace(/max_lines: 20/, 'max_lines: 7'));
  writeDecision(root, decision('2026-08-01-old', { verified_on: '2026-08-01' }));
  writeDecision(root, decision('2026-11-03-long', { body: `${'line\n'.repeat(10)}` }));
  expect((await go(root, ['sync', '--yes'])).code).toBe(0); // the config's cap, not the default
  writeFileSync(join(root, 'src/config.ts'), 'export const x = 1;\n');
  commitAll(root, 'change');
  const head = git(root, 'rev-parse', 'HEAD').trim();
  const r = await go(root, ['check'], { env: { CI: 'true' } }); // unattended: still runs, never prompts
  expect(r.code).toBe(0);
  const lines = r.out.split('\n');
  expect(lines).toContain(`note decision ${ID} is stale: 1 linked file changed since ${git(root, 'rev-parse', 'HEAD~1').trim().slice(0, 7)} (src/config.ts): check it still holds, then run harness remember confirm ${ID}`);
  expect(lines).toContain('note decision 2026-08-01-old expired: last confirmed 2026-08-01, over 90 days ago, so its rule no longer loads after the next sync: run harness remember confirm 2026-08-01-old or harness remember retire 2026-08-01-old');
  expect(lines.some((l) => l.startsWith('note decision 2026-11-03-long is oversized: its rule is 15 lines, cap 7, so it is cut'))).toBe(true);
  expect(lines.at(-1)).toBe('3 decisions: 0 errors, 1 stale, 1 expired, 1 oversized, rules in sync');
  expect(prompt.asked).toBe(0);
  expect(head).toBe(git(root, 'rev-parse', 'HEAD').trim());
  expect((await go(root, ['check', '--yes'])).code).toBe(2);
});

test('list: the staleness column', async () => {
  const root = await repo();
  const ref = git(root, 'rev-parse', 'HEAD').trim().slice(0, 7);
  writeFileSync(join(root, 'src/config.ts'), 'export const x = 1;\n');
  commitAll(root, 'change');
  expect(list(root, defaults(), TODAY)).toEqual([`${ID}  active   confirmed ${TODAY}  src/env/**, src/config.ts  stale: 1 linked file changed since ${ref}`]);
});
