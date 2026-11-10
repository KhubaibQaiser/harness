import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Prompt } from '../../src/cli/prompt.js';
import { remember } from '../../src/cli/remember.js';
import { list } from '../../src/cli/remember-read.js';
import { defaults } from '../../src/core/config.js';
import { parseDecision } from '../../src/core/decision-file.js';
import { readEvents } from '../../src/core/events.js';
import { TODAY, decision, installedRepo, syncNow, writeDecision } from '../core/decisions-helpers.js';

const ID = `${TODAY}-validate-env-with-zod`;
const DEC = `docs/decisions/${ID}.md`;
const RULE = `.claude/rules/harness-decision-${ID}.md`;
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const fake = (answer = false): Prompt & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, async confirm(q) { asked.push(q); return answer; }, async edit(_l, v) { return v; } };
};

/** An installed repo with everything committed, and tracked files under src/env/ and src/config.ts. */
async function repo(): Promise<string> {
  const root = await installedRepo();
  mkdirSync(join(root, 'src/env'), { recursive: true });
  writeFileSync(join(root, 'src/env/schema.ts'), 'export {};\n');
  writeFileSync(join(root, 'src/config.ts'), 'export {};\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'installed');
  return root;
}

async function go(root: string, args: string[], o: { env?: NodeJS.ProcessEnv; tty?: boolean; prompt?: Prompt } = {}) {
  const lines: string[] = [];
  const code = await remember(args, { root, env: o.env ?? {}, tty: o.tty, out: (s) => lines.push(s), prompt: o.prompt ?? fake(), now: () => new Date(`${TODAY}T12:00:00Z`) });
  return { code, out: lines.join('\n') };
}

const ADD = ['add', '--title', 'Validate env with zod', '--rule', 'Parse env through src/env/schema.ts.', '--why', 'Two outages.', '--path', 'src/env/**', '--path', 'src/config.ts', '--yes'];
const events = (root: string) => readEvents(root).filter((e) => e.check === 'remember');

test('add: writes the decision and its rule, prints the three lines', async () => {
  const root = await repo();
  const r = await go(root, ADD);
  expect(r).toEqual({ code: 0, out: [
    `Wrote ${DEC}`,
    `Wrote ${RULE} (loads when src/env/**, src/config.ts are touched)`,
    'Nothing is committed. Open a PR so the team reviews it.',
  ].join('\n') });
  const d = parseDecision(DEC, readFileSync(join(root, DEC), 'utf8'), TODAY).decision!;
  expect(d).toMatchObject({ status: 'active', verified_at: git(root, 'rev-parse', 'HEAD').trim(), verified_on: TODAY, paths: ['src/env/**', 'src/config.ts'] });
  expect(d.body).toBe('**Rule:** Parse env through src/env/schema.ts.\n\n**Why:** Two outages.\n');
  expect(existsSync(join(root, RULE))).toBe(true);
});

test('add: side effects stay out of git and settings; events hold no field text', async () => {
  const root = await repo();
  const settings = readFileSync(join(root, '.claude/settings.json'), 'utf8');
  await go(root, ADD);
  const st = git(root, 'status', '--porcelain', '--untracked-files=all');
  expect(st).toContain(`?? ${DEC}`);
  expect(st).toContain(`?? ${RULE}`);
  expect(st.split('\n').filter((l) => /^[MADRC]/.test(l))).toEqual([]); // nothing staged
  expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toBe(settings);
  await go(root, ADD, { env: { CI: 'true' } });
  const ev = events(root);
  expect(ev.map((e) => [e.decision, e.reason])).toEqual([['added', undefined], ['refused', 'unattended']]);
  expect(JSON.stringify(ev)).not.toMatch(/Validate env|outages|schema\.ts/);
});

test('add: --supersedes marks the other decision superseded', async () => {
  const root = await repo();
  const OLD = '2026-11-03-old-env';
  writeDecision(root, decision(OLD, { paths: ['src/env/**'] }));
  syncNow(root);
  const r = await go(root, [...ADD, '--supersedes', OLD]);
  expect(r.code).toBe(0);
  const old = parseDecision(`docs/decisions/${OLD}.md`, readFileSync(join(root, `docs/decisions/${OLD}.md`), 'utf8'), TODAY).decision!;
  expect(old).toMatchObject({ status: 'superseded', superseded_by: ID });
  expect(existsSync(join(root, `.claude/rules/harness-decision-${OLD}.md`))).toBe(false);
  expect((await go(root, [...ADD, '--supersedes', '2026-11-03-x'])).out).toBe('harness remember: no decision 2026-11-03-x in docs/decisions/.');
});

test('add: the same title twice on one day gets -2', async () => {
  const root = await repo();
  await go(root, ADD);
  expect((await go(root, ADD)).out).toContain(`Wrote docs/decisions/${ID}-2.md`);
});

test('add: a rule over the cap is refused', async () => {
  const root = await repo();
  writeFileSync(join(root, '.harness/config.yaml'), readFileSync(join(root, '.harness/config.yaml'), 'utf8').replace(/max_lines: 20/, 'max_lines: 5'));
  const r = await go(root, ADD);
  expect(r).toEqual({ code: 1, out: 'harness remember: the rule would be 8 lines; the cap is 5 (decisions.max_lines). Shorten --rule or --why.' });
  expect(existsSync(join(root, DEC))).toBe(false);
});

test('add: field limits', async () => {
  const root = await repo();
  const add = (over: Record<string, string>, paths = ['src/env/**']) => {
    const f = { '--title': 'T', '--rule': 'R', '--why': '', ...over };
    return go(root, ['add', ...Object.entries(f).flat(), ...paths.flatMap((p) => ['--path', p]), '--yes']);
  };
  expect((await add({ '--title': 'x'.repeat(81) })).out).toBe('harness remember: --title must be one line of 1 to 80 characters');
  expect((await add({ '--title': 'a\nb' })).code).toBe(1);
  expect((await add({ '--rule': 'x'.repeat(301) })).out).toBe('harness remember: --rule must be one line of 1 to 300 characters');
  expect((await add({ '--rule': 'x'.repeat(300) })).code).toBe(0);
  expect((await add({ '--why': 'x'.repeat(501) })).out).toBe('harness remember: --why must be one line of 0 to 500 characters');
  expect((await add({ '--why': 'a\nb' })).code).toBe(1);
  expect((await add({}, Array(11).fill('src/env/**'))).out).toBe('harness remember: give 1 to 10 --path globs');
  expect((await add({}, ['**'])).out).toBe('harness remember: --path ** must not match the whole repo (put repo-wide rules in AGENTS.md or CLAUDE.md)');
  expect((await go(root, ['add', '--title', 'T', '--rule', 'R'])).code).toBe(2); // no --path
  expect((await go(root, ['add', '--title', 'T', '--rule', 'R', '--path', 'src/env/**', '--bogus'])).code).toBe(2);
});

test('add: a dead --path is refused', async () => {
  const root = await repo();
  const r = await go(root, ['add', '--title', 'T', '--rule', 'R', '--path', 'lib/**', '--yes']);
  expect(r).toEqual({ code: 1, out: 'harness remember: lib/** matches no tracked file. Fix the path, or retire the decision.' });
});

test('refusals: unattended, guard off, secret, no manifest', async () => {
  const root = await repo();
  expect(await go(root, ADD, { env: { CI: 'true' } })).toEqual({ code: 1, out: 'harness remember does not write in unattended runs (CI, cloud or no-prompt sessions). A person can save it later.' });
  expect(existsSync(join(root, 'docs/decisions'))).toBe(false);
  writeFileSync(join(root, '.harness/config.yaml'), readFileSync(join(root, '.harness/config.yaml'), 'utf8').replace(/guard: true/, 'guard: false'));
  expect((await go(root, ADD, { env: { CLAUDECODE: '1' } })).out).toBe("harness remember won't write from inside Claude Code while checks.guard is off, because nobody would be asked. Run it in your own terminal.");
  const s = await go(root, ['add', '--title', 'T', '--rule', 'R', '--why', 'token=abcdefgh12', '--path', 'src/env/**', '--yes']);
  expect(s).toEqual({ code: 1, out: 'harness remember: --why looks like it holds a secret (assignment). Decisions are committed to git. Remove it.' });
  expect(s.out).not.toContain('abcdefgh12');
  expect(events(root).at(-1)).toMatchObject({ decision: 'refused', reason: 'secret' });
  rmSync(join(root, '.harness/manifest.json'));
  expect(await go(root, ADD)).toEqual({ code: 1, out: 'Harness is not installed here (no .harness/manifest.json). Run /harness:init first.' });
  expect(existsSync(join(root, 'docs/decisions'))).toBe(false);
});

test('prompt: no writes nothing; --yes skips it; --dry-run lists files', async () => {
  const root = await repo();
  const noYes = ADD.filter((a) => a !== '--yes');
  const p = fake(false);
  const r = await go(root, noYes, { tty: true, prompt: p });
  expect(r.code).toBe(1);
  expect(p.asked).toEqual(['Write these files? [y/N]']);
  expect(r.out).toContain(DEC);
  expect(existsSync(join(root, 'docs/decisions'))).toBe(false);
  expect(events(root).at(-1)).toMatchObject({ decision: 'refused', reason: 'declined' });
  const d = await go(root, [...noYes, '--dry-run'], { tty: true, prompt: p });
  expect(d).toEqual({ code: 0, out: `Would write ${DEC}\nWould write ${RULE}` });
  expect(existsSync(join(root, 'docs/decisions'))).toBe(false);
  const y = fake(true);
  expect((await go(root, ADD, { tty: true, prompt: y })).code).toBe(0);
  expect(y.asked).toEqual([]);
});

test('sync: in sync, then one Wrote line after a hand edit', async () => {
  const root = await repo();
  await go(root, ADD);
  expect(await go(root, ['sync', '--yes'])).toEqual({ code: 0, out: 'Rules in sync: 1 decisions, 1 rules (0 expired or retired, left out).' });
  writeFileSync(join(root, DEC), readFileSync(join(root, DEC), 'utf8').replace('Two outages.', 'Three outages.'));
  expect(await go(root, ['sync', '--yes'])).toEqual({ code: 0, out: `Wrote ${RULE}` });
  expect(readFileSync(join(root, RULE), 'utf8')).toContain('Three outages.');
  expect(events(root).at(-1)).toMatchObject({ decision: 'synced' });
});

test('list: one sorted line per decision', async () => {
  const root = await repo();
  expect(await go(root, ['list'])).toEqual({ code: 0, out: 'No team decisions in docs/decisions/.' });
  writeDecision(root, decision('2026-11-04-b', { status: 'retired', paths: ['src/config.ts'] }));
  writeDecision(root, decision('2026-11-03-a', { paths: ['src/env/**', 'src/config.ts'] }));
  expect(list(root, defaults(), TODAY)).toEqual([
    '2026-11-03-a  active   confirmed 2026-11-03  src/env/**, src/config.ts',
    '2026-11-04-b  retired  confirmed 2026-11-03  src/config.ts',
  ]);
  expect((await go(root, ['list'])).out.split('\n')).toHaveLength(2);
  expect((await go(root, ['nope'])).code).toBe(2);
});
