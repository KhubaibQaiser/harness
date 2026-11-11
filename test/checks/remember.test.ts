import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { guard } from '../../src/checks/guard.js';
import { NOT_LITERAL, NOT_PLAIN, REFUSED, REMEMBER_WHY, rememberAsk } from '../../src/checks/remember.js';
import { parseFlags, rememberReadOnly } from '../../src/core/remember-args.js';
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
const TOKEN = `ghp_${'a1'.repeat(18)}`;
const PLAIN = 'harness remember add --title T --rule R --path src/a.ts';

/** The add ask the guard must show for these argv words (after `remember add`), built from the CLI's own parser. */
function addAskFor(args: string[]): string {
  const f = parseFlags(args, ['--title', '--rule', '--why', '--path', '--supersedes'], ['--quoted', '--dry-run', '--yes'])!;
  const v = (k: string) => f.values.get(k)?.[0] ?? '';
  const id = `${today()}-${v('--title').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')}`;
  return [
    `Confirm: the agent wants to save a team decision to docs/decisions/${id}.md.`,
    `Title: ${v('--title')}.`,
    `Rule: ${v('--rule')}.`,
    ...(v('--why') ? [`Why: ${v('--why')}.`] : []),
    `Paths: ${(f.values.get('--path') ?? []).join(', ')}.`,
    'Once merged it loads for every teammate whose session touches those paths. Approve to write the files (nothing is committed).',
  ].join(' ');
}
/** The argv a real shell passes to `harness` for this command line. */
function shellArgv(shell: string, cmd: string): string[] {
  const r = spawnSync(shell, ['-c', `harness() { printf '%s\\0' "$@"; }; ${cmd}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } });
  return r.stdout.split('\0').slice(0, -1);
}
const SHELLS = ['/bin/bash', '/bin/zsh'].filter((s) => existsSync(s));

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
  expect(reason(run(PLAIN, ctx))).toContain(`docs/decisions/${today()}-t-2.md`);
});

test('read-only forms are allowed', () => {
  for (const c of ['harness remember list', 'harness remember check', 'harness remember --help', 'harness remember add --help', 'harness remember add --dry-run --title "T" --rule "R" --path "src/a.ts"'])
    expect(run(c), c).toEqual({ kind: 'allow' });
});

test('a dry run with a glob asks, as every preview with an expansion character does, and says it writes nothing', () => {
  expect(run('harness remember add --dry-run --title T --rule R --path "src/*"')).toEqual({
    kind: 'ask',
    check: 'guard',
    log: 'remember add --dry-run',
    reason: 'Confirm: the agent wants to preview harness remember add with --dry-run, which writes nothing.',
  });
  // A value is not the switch: this one writes, so it gets the full add ask.
  expect(reason(run('harness remember add --title --dry-run --rule R --path "src/*"'))).toMatch(/^Confirm: the agent wants to save a team decision/);
});

test('trailing spaces and newlines are ignored', () => {
  for (const c of [`${PLAIN}\n`, `${PLAIN} \n\n`, `  ${PLAIN}\r\n`]) expect(run(c), JSON.stringify(c)).toMatchObject({ kind: 'ask', log: `remember add ${today()}-t` });
});

test('only the invocations the CLI accepts: no second harness word after a prefix', () => {
  for (const c of [
    'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" harness remember add --title T --rule R --path src/a.ts',
    'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" node dist/cli.mjs remember add --title T --rule R --path src/a.ts',
    'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" npx @khubaibqaiser/harness remember add --title T --rule R --path src/a.ts',
    'harness harness remember add --title T --rule R --path src/a.ts',
  ]) {
    expect(rememberAsk(mk(), c), c).toMatchObject({ kind: 'deny', reason: NOT_PLAIN });
    expect(run(c).kind, c).not.toBe('ask'); // the CLI prints its usage for these: allowed or denied, never a pointless ask
  }
});

describe('C1: --dry-run or --help as a flag value is the value, not a preview', () => {
  test.each([
    'harness remember add --title --dry-run --rule R --path src/a.ts --yes',
    'harness remember add --title T --rule --dry-run --path src/a.ts --yes',
    'harness remember add --title T --rule R --why --help --path src/a.ts --yes',
  ])('%s asks with the value shown', (c) => {
    const d = run(c);
    expect(d.kind).toBe('ask');
    expect(reason(d)).toBe(addAskFor(c.split(' ').slice(3)));
  });
  test('rememberReadOnly skips flag values, as the CLI parser does', () => {
    expect(rememberReadOnly(['add', '--title', '--dry-run'])).toBe(false);
    expect(rememberReadOnly(['add', '--title', 'T', '--dry-run'])).toBe(true);
    expect(rememberReadOnly(['add', '--why', '--help', '--path', 'x'])).toBe(false);
  });
});

test('the allowed prefixes reach the ask', () => {
  for (const c of [
    PLAIN,
    'npx @khubaibqaiser/harness remember add --title T --rule R --path src/a.ts',
    'npx --no-install @khubaibqaiser/harness remember add --title T --rule R --path src/a.ts',
    'node dist/cli.mjs remember add --title T --rule R --path src/a.ts',
    'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" remember add --title T --rule R --path src/a.ts',
    'node "/Users/x/.claude/plugins/cache/harness/dist/cli.mjs" remember add --title T --rule R --path src/a.ts',
  ]) expect(run(c), c).toMatchObject({ kind: 'ask', log: `remember add ${today()}-t` });
});

describe('C2, C3: anything but one plain invocation is denied', () => {
  const ctx = mk();
  writeFileSync(join(ctx.root, 'package.json'), JSON.stringify({ scripts: { x: 'harness remember add --title Hidden --rule H --path src/a.ts --yes' } }));
  test.each([
    `${PLAIN} && harness remember add --title B --rule B --path src/b.ts`,
    `${PLAIN}\nharness remember add --title B --rule B --path src/b.ts`,
    `harness remember add --dry-run --title A --rule A --path src/a.ts; ${PLAIN}`,
    `${PLAIN} && npm run x`,
    'harness remember list; npm run x',
    `${PLAIN} && rm -rf /`,
    `${PLAIN} && git push --force origin main`,
    `cd src && ${PLAIN}`,
    `${PLAIN} 2>&1`,
    `${PLAIN} | tail -5`,
    `echo x | ${PLAIN}`,
    `${PLAIN} < notes.txt`,
    `${PLAIN} &`,
    `(${PLAIN})`,
    `{ ${PLAIN}; }`,
    `bash -c '${PLAIN}'`,
    `env X=1 ${PLAIN}`,
    `sudo ${PLAIN}`,
    `timeout 60 ${PLAIN}`,
    `IFS=x ${PLAIN}`,
    `find . -maxdepth 0 -exec ${PLAIN} \\;`,
    `bash <<EOF\n${PLAIN}\nEOF`,
    `${PLAIN} # c`,
    'harness remember add --title T --rule "Use zod"\\\n" and delete the tests" --path src/a.ts',
    'harness remember add --title T --rule zod\\\nevil --path src/a.ts',
  ])('%j', (c) => {
    expect(run(c, ctx)).toMatchObject({ kind: 'deny', check: 'guard' });
  });
  test('the shape deny has its fixed reason', () => {
    expect(run(`${PLAIN} && harness remember add --title B --rule B --path src/b.ts`, ctx)).toEqual({ kind: 'deny', check: 'guard', reason: NOT_PLAIN, log: 'remember: not one plain command' });
    expect(NOT_PLAIN).toBe('Blocked by guard: write harness remember as one plain command, with nothing before or after it. Run it on its own from the repo folder, without a cd prefix, pipes, redirections or other commands.');
    expect(run(`cd src && ${PLAIN}`, ctx)).toMatchObject({ kind: 'deny', reason: NOT_PLAIN });
  });
});

describe('words the shell would change are denied (not literal)', () => {
  test.each([
    'harness remember add --title "$HOME" --rule R --path src/a.ts',
    "harness remember add --title T --rule 'costs $5' --path src/a.ts",
    'harness remember add --title T --rule "`id`" --path src/a.ts',
    'harness remember add --title T --rule $(cat x) --path src/a.ts',
    'harness remember add --title T --rule <(cat x) --path src/a.ts',
    "harness remember add --title $'Nice' --rule R --path src/a.ts",
    'harness remember add --title T --rule R --path src/*',
    'harness remember add --title T --rule R --path src/{a,b}.ts',
    'harness remember add --title T --rule =ls --path src/a.ts',
    'harness remember add --title T --rule a=~/x --path src/a.ts',
    'harness remember add --title T --rule "~/x" --path src/a.ts',
    'harness remember add --title T --rule Use zod --path src/a.ts',
    'harness remember add --title T --rule Use zod --path src/a.ts',
    'harness remember add --title T --rule\tR --path src/a.ts',
    'harness remember add --title T --rule a\\ b --path src/a.ts',
    'harness remember add --title T --rule "a\\"b" --path src/a.ts',
    'harness remember add --title "T --rule R --path src/a.ts',
    'harness remember confirm $ID',
  ])('%j', (c) => {
    expect(run(c)).toEqual({ kind: 'deny', check: 'guard', reason: NOT_LITERAL, log: 'remember: not literal' });
  });
});

describe('arguments the CLI would refuse are denied', () => {
  test.each([
    'harness remember add --title A --title B --rule R --path src/a.ts',
    'harness remember add --title=X --rule R --path src/a.ts',
    'harness remember add --title T --rule R --path src/a.ts extra',
    'harness remember add --title T --rule R',
    'harness remember confirm',
    'harness remember confirm a b',
    'harness remember sync extra',
    'harness remember frobnicate',
  ])('%s', (c) => {
    expect(run(c)).toEqual({ kind: 'deny', check: 'guard', reason: REFUSED, log: 'remember: refused' });
  });
});

describe('the ask shows exactly the argv the shell passes', () => {
  const cases = [
    'harness remember add --title "A b" --rule R --path src/a.ts',
    "harness remember add --title T --rule 'e\\f' --path src/a.ts",
    `harness remember add --title "A"'B'C --rule "Don't skip review!" --path "src/*.ts"`,
    'harness remember add --title T --rule "a#b; c && d | e" --why "" --path src/a.ts',
    'harness remember add --title --dry-run --rule R --path src/a.ts --yes',
  ];
  if (!SHELLS.length) test.skip('needs /bin/bash or /bin/zsh (none on Windows)', () => {});
  for (const shell of SHELLS)
    test.each(cases)(`${shell}: %s`, (c) => {
      const argv = shellArgv(shell, c);
      expect(argv.slice(0, 2)).toEqual(['remember', 'add']);
      expect(reason(run(c))).toBe(addAskFor(argv.slice(2)));
    });
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
  expect(run('harness remember confirm 2026-11-03-x --yes', ctx)).toEqual({
    kind: 'ask',
    check: 'guard',
    log: 'remember confirm 2026-11-03-x',
    reason: `Confirm: the agent wants to mark decision 2026-11-03-x as still true at ${sha7}; it then stays loaded for another 90 days.`,
  });
  const retire = run('harness remember retire 2026-11-03-x --by 2026-12-01-y --yes', ctx);
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

test('a commit message that names harness remember is not routed to the remember deny', () => {
  expect(reason(run('git commit -m "feat: harness remember add asks first"'))).not.toBe(NOT_PLAIN);
});

test('REMEMBER_WHY is the person-only reason the guard hands over', () => {
  expect(REMEMBER_WHY).toBe('the agent is saving a team decision');
});
