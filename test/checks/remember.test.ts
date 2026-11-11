import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { guard } from '../../src/checks/guard.js';
import { REMEMBER_WHY, rememberAsk } from '../../src/checks/remember.js';
import { loadConfig } from '../../src/core/config.js';
import { readEvents } from '../../src/core/events.js';
import type { Ctx } from '../../src/hooks/check.js';
import type { Decision } from '../../src/hooks/types.js';

const today = () => new Date().toISOString().slice(0, 10);
const mk = (o: { unattended?: boolean; root?: string } = {}): Ctx => {
  const root = o.root ?? mkdtempSync(join(tmpdir(), 'h-rem-'));
  return { input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash' }, root, config: loadConfig(root).config, unattended: !!o.unattended, env: {} } as unknown as Ctx;
};
const run = (cmd: string, ctx = mk()): Decision => guard.run({ ...ctx, input: { ...ctx.input, tool_input: { command: cmd } } }) as Decision;
const reason = (d: Decision) => ('reason' in d ? d.reason : '');
const log = (d: Decision) => ('log' in d ? d.log : undefined);
const ADD = 'harness remember add --title "Validate env with zod" --rule "Parse env with zod at startup" --why "Typos crashed prod" --path "src/env/**" --path "src/config.ts"';
const NOT_LITERAL = 'Blocked by guard: harness remember needs its text as plain quoted words, so the person sees exactly what is written. Remove $, backticks and substitutions.';
const TOKEN = `ghp_${'a1'.repeat(18)}`;

test('add asks with the decision text and the file it writes', () => {
  const d = run(ADD);
  const id = `${today()}-validate-env-with-zod`;
  expect(d).toEqual({
    kind: 'ask',
    check: 'guard',
    log: `remember add ${id}`,
    reason: `Confirm: the agent wants to save a team decision to docs/decisions/${id}.md. Title: Validate env with zod. Rule: Parse env with zod at startup. Why: Typos crashed prod. Paths: src/env/**, src/config.ts. Once merged it loads for every teammate whose session touches those paths. Approve to write the files (nothing is committed).`,
  });
});

test('the id takes the next free suffix, as the CLI does', () => {
  const ctx = mk();
  mkdirSync(join(ctx.root, 'docs/decisions'), { recursive: true });
  writeFileSync(join(ctx.root, `docs/decisions/${today()}-t.md`), 'x');
  expect(reason(run('harness remember add --title T --rule R --path src/a.ts', ctx))).toContain(`docs/decisions/${today()}-t-2.md`);
});

test('read-only forms are allowed', () => {
  for (const c of ['harness remember list', 'harness remember check', 'harness remember --help', 'harness remember add --dry-run --title "T" --rule "R" --path "src/a.ts"'])
    expect(run(c), c).toEqual({ kind: 'allow' });
});

test('a dry run with a glob asks, as every preview with an expansion character does', () => {
  expect(run('harness remember add --dry-run --title T --rule R --path "src/*"').kind).toBe('ask');
});

test('wrappers all reach rememberAsk', () => {
  for (const c of [
    'npx @khubaibqaiser/harness remember add --title T --rule R --path src/a.ts',
    `bash -c 'harness remember add --title "T" --rule R --path src/a.ts'`,
    'env X=1 harness remember add --title T --rule R --path src/a.ts',
    'node dist/cli.mjs remember add --title T --rule R --path src/a.ts',
  ]) {
    const d = run(c);
    expect(d.kind, c).toBe('ask');
    expect(log(d), c).toBe(`remember add ${today()}-t`);
  }
});

test('text the shell would change, or a command fed from stdin or a file, is denied', () => {
  for (const c of [
    'harness remember add --title "$HOME" --rule R --path src/a.ts',
    'harness remember add --title T --rule "`id`" --path src/a.ts',
    'harness remember add --title T --rule $(cat x) --path src/a.ts',
    'harness remember add --title T --rule <(cat x) --path src/a.ts',
    'echo x | harness remember add --title T --rule R --path src/a.ts',
    'harness remember add --title T --rule R --path src/*',
    'harness remember add --title T --rule R --path src/a.ts < notes.txt',
    'harness remember confirm $ID',
  ]) {
    const d = run(c);
    expect(d, c).toMatchObject({ kind: 'deny', check: 'guard', reason: NOT_LITERAL, log: 'remember: not literal' });
  }
});

test('a quoted glob is literal and asks', () => {
  expect(run('harness remember add --title T --rule R --path "src/*"')).toMatchObject({ kind: 'ask', log: `remember add ${today()}-t` });
});

test('a secret in a field is denied, naming the kind and field and never the value', () => {
  const d = run(`harness remember add --title T --rule "use ${TOKEN}" --path src/a.ts`);
  expect(d).toEqual({
    kind: 'deny',
    check: 'guard',
    log: 'remember: secret (GitHub token)',
    reason: 'Blocked by guard: this decision looks like it holds a secret (GitHub token in --rule). Decisions are committed to git. Remove it.',
  });
});

test('confirm names the commit and the expiry; retire and sync name their files', () => {
  const ctx = mk();
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: ctx.root, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  const sha7 = git('rev-parse', '--short=7', 'HEAD').stdout.trim();
  expect(run('harness remember confirm 2026-11-03-x', ctx)).toEqual({
    kind: 'ask',
    check: 'guard',
    log: 'remember confirm 2026-11-03-x',
    reason: `Confirm: the agent wants to mark decision 2026-11-03-x as still true at ${sha7}; it then stays loaded for another 90 days.`,
  });
  const retire = run('harness remember retire 2026-11-03-x --by 2026-12-01-y', ctx);
  expect(reason(retire)).toContain('docs/decisions/2026-11-03-x.md');
  expect(reason(retire)).toContain('.claude/rules/harness-decision-2026-11-03-x.md');
  expect(log(retire)).toBe('remember retire 2026-11-03-x');
  const sync = run('harness remember sync --yes', ctx);
  expect(sync).toMatchObject({ kind: 'ask', log: 'remember sync' });
  expect(reason(sync)).toContain('.claude/rules/');
});

test('unattended, an add logs one decision-candidate with the title and rule, secrets redacted', () => {
  const ctx = mk({ unattended: true });
  const d = rememberAsk(ctx, `harness remember add --title T --rule "use ${TOKEN}" --why "secret why" --path src/a.ts`);
  expect(d.kind).toBe('deny');
  const ev = readEvents(ctx.root).filter((e) => e.decision === 'decision-candidate');
  expect(ev).toEqual([expect.objectContaining({ check: 'remember', session: 's', reason: 'T | use [redacted]' })]);
});

test('the .env text rule still wins (drift 5)', () => {
  const d = run('harness remember add --title T --rule "never commit .env" --path src/a.ts');
  expect(d.kind).toBe('deny');
  expect(reason(d)).toContain('secrets file');
});

test('REMEMBER_WHY is the person-only reason the guard hands over', () => {
  expect(REMEMBER_WHY).toBe('the agent is saving a team decision');
});
