import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Prompt } from '../../src/cli/prompt.js';
import { remember, type RememberEnv } from '../../src/cli/remember.js';
import { parseDecision } from '../../src/core/decision-file.js';
import type { Git } from '../../src/core/decisions-stale.js';
import { readEvents } from '../../src/core/events.js';
import { TODAY, decision, installedRepo, syncNow, writeDecision } from '../core/decisions-helpers.js';

const A = '2026-11-03-a';
const B = '2026-11-04-b';
const rel = (id: string) => `docs/decisions/${id}.md`;
const ruleOf = (id: string) => `.claude/rules/harness-decision-${id}.md`;
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const prompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const read = (root: string, id: string) => parseDecision(rel(id), readFileSync(join(root, rel(id)), 'utf8'), TODAY).decision!;
const events = (root: string) => readEvents(root).filter((e) => e.check === 'remember');

/** An installed repo with decisions A and B synced, src/env/ tracked, and everything committed. */
async function repo(): Promise<string> {
  const root = await installedRepo();
  mkdirSync(join(root, 'src/env'), { recursive: true });
  writeFileSync(join(root, 'src/env/schema.ts'), 'export {};\n');
  writeDecision(root, decision(A));
  writeDecision(root, decision(B));
  syncNow(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'installed');
  return root;
}

async function go(root: string, args: string[], extra: Partial<RememberEnv> = {}) {
  const lines: string[] = [];
  const code = await remember(args, { root, env: {}, out: (s) => lines.push(s), prompt, now: () => new Date(`${TODAY}T12:00:00Z`), ...extra });
  return { code, out: lines.join('\n') };
}

test('confirm: sets verified_at to HEAD and verified_on to today, prints the expiry', async () => {
  const root = await repo();
  const head = git(root, 'rev-parse', 'HEAD').trim();
  expect(await go(root, ['confirm', A, '--yes'])).toEqual({ code: 0, out: `Confirmed ${A} at ${head.slice(0, 7)} on ${TODAY}. It expires on 2027-02-08 unless confirmed again.` });
  expect(read(root, A)).toMatchObject({ status: 'active', verified_at: head, verified_on: TODAY });
  expect(readFileSync(join(root, ruleOf(A)), 'utf8')).toContain(`confirmed ${TODAY} at \`${head.slice(0, 7)}\``);
  expect(events(root).at(-1)).toMatchObject({ decision: 'confirmed' });
});

test('confirm: a dead path, an unknown id, a decision that is not active', async () => {
  const root = await repo();
  writeDecision(root, decision('2026-11-05-c', { paths: ['lib/**'] }));
  const before = readFileSync(join(root, rel('2026-11-05-c')), 'utf8');
  expect(await go(root, ['confirm', '2026-11-05-c', '--yes'])).toEqual({ code: 1, out: 'harness remember: lib/** matches no tracked file. Fix the path, or retire the decision.' });
  expect(readFileSync(join(root, rel('2026-11-05-c')), 'utf8')).toBe(before);
  expect(events(root).at(-1)).toMatchObject({ decision: 'refused', reason: 'dead-path' });
  expect(await go(root, ['confirm', '2026-11-03-x', '--yes'])).toEqual({ code: 1, out: 'harness remember: no decision 2026-11-03-x in docs/decisions/.' });
  await go(root, ['retire', B, '--yes']);
  expect(await go(root, ['confirm', B, '--yes'])).toEqual({ code: 1, out: `harness remember: ${B} is retired, not active. Only an active decision can be confirmed.` });
  expect((await go(root, ['confirm'])).code).toBe(2);
  expect((await go(root, ['confirm', A, B])).code).toBe(2);
});

test('confirm: HEAD with no commit is a clear refusal', async () => {
  const root = await repo();
  const fake: Git = () => ({ ok: false, out: '', reason: "fatal: ambiguous argument 'HEAD'" });
  expect(await go(root, ['confirm', A, '--yes'], { git: fake })).toEqual({ code: 1, out: 'harness remember: no commit to record as verified_at. Commit once, then run it again.' });
  expect(read(root, A).verified_on).toBe('2026-11-03');
});

test('retire: without --by, the rule goes and the file stays as retired', async () => {
  const root = await repo();
  expect(await go(root, ['retire', A, '--yes'])).toEqual({ code: 0, out: `Retired ${A}. Removed its rule. The decision file stays as a record.` });
  expect(read(root, A)).toMatchObject({ status: 'retired' });
  expect(read(root, A).superseded_by).toBeUndefined();
  expect(existsSync(join(root, ruleOf(A)))).toBe(false);
  expect(existsSync(join(root, ruleOf(B)))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8')).files.map((f: { rel: string }) => f.rel)).not.toContain(ruleOf(A));
  expect(events(root).at(-1)).toMatchObject({ decision: 'retired' });
});

test('retire --by: superseded, with the link', async () => {
  const root = await repo();
  expect(await go(root, ['retire', A, '--by', B, '--yes'])).toEqual({ code: 0, out: `Retired ${A} (superseded by ${B}). Removed its rule. The decision file stays as a record.` });
  expect(read(root, A)).toMatchObject({ status: 'superseded', superseded_by: B });
  expect(existsSync(join(root, ruleOf(A)))).toBe(false);
  expect(await go(root, ['retire', B, '--by', '2026-11-03-x', '--yes'])).toEqual({ code: 1, out: 'harness remember: no decision 2026-11-03-x in docs/decisions/.' });
  expect(await go(root, ['retire', B, '--by', B, '--yes'])).toEqual({ code: 1, out: 'harness remember: --by must name another decision.' });
  expect(await go(root, ['retire', A, '--yes'])).toEqual({ code: 1, out: `harness remember: ${A} is superseded, not active. Only an active decision can be retired.` });
});

test('retire --dry-run lists the files and writes nothing', async () => {
  const root = await repo();
  expect(await go(root, ['retire', A, '--dry-run'])).toEqual({ code: 0, out: `Would write ${rel(A)}\nWould remove ${ruleOf(A)}` });
  expect(read(root, A).status).toBe('active');
});

for (const sub of ['confirm', 'retire']) {
  test(`${sub}: the write gate (unattended, guard off) writes nothing`, async () => {
    const root = await repo();
    const before = readFileSync(join(root, rel(A)), 'utf8');
    expect(await go(root, [sub, A, '--yes'], { env: { CI: 'true' } })).toEqual({ code: 1, out: 'harness remember does not write in unattended runs (CI, cloud or no-prompt sessions). A person can save it later.' });
    expect(events(root).at(-1)).toMatchObject({ decision: 'refused', reason: 'unattended' });
    writeFileSync(join(root, '.harness/config.yaml'), readFileSync(join(root, '.harness/config.yaml'), 'utf8').replace(/guard: true/, 'guard: false'));
    expect((await go(root, [sub, A, '--yes'], { env: { CLAUDECODE: '1' } })).out).toBe("harness remember won't write from inside Claude Code while checks.guard is off, because nobody would be asked. Run it in your own terminal.");
    expect(await go(root, [sub, A], { tty: false })).toEqual({ code: 2, out: 'No terminal to answer prompts. Run with --yes, or use --dry-run to preview.' });
    expect(readFileSync(join(root, rel(A)), 'utf8')).toBe(before);
    expect(existsSync(join(root, ruleOf(A)))).toBe(true);
  });
}

// Fix round 1 (review 2026-11-11).
test('retire --yes touches only its own decision and rule; other drift gets one note', async () => {
  const root = await repo();
  const sib = join(root, rel(B));
  writeFileSync(sib, readFileSync(sib, 'utf8').replace('status: active', 'status: active\nbogus: 1'));
  const sibRule = readFileSync(join(root, ruleOf(B)), 'utf8');
  expect(await go(root, ['retire', A, '--yes'])).toEqual({ code: 0, out: `Retired ${A}. Removed its rule. The decision file stays as a record.\nOther decisions are out of sync; run harness remember sync.` });
  expect(readFileSync(join(root, ruleOf(B)), 'utf8')).toBe(sibRule);
  expect(existsSync(join(root, ruleOf(A)))).toBe(false);
  expect(await go(root, ['confirm', B, '--yes'])).toEqual({ code: 1, out: `harness remember: ${B} is invalid; run harness remember sync to see why` });
  expect((await go(root, ['add', '--title', 'T', '--rule', 'R', '--path', 'src/env/**', '--supersedes', B, '--yes'])).out).toBe(`harness remember: ${B} is invalid; run harness remember sync to see why`);
});

test('retire: no "Removed its rule." when the rule was already gone', async () => {
  const root = await repo();
  writeDecision(root, decision('2026-08-01-old', { verified_on: '2026-08-01' }));
  expect(await go(root, ['retire', '2026-08-01-old', '--yes'])).toEqual({ code: 0, out: 'Retired 2026-08-01-old. The decision file stays as a record.' });
});

test('retire --by must name an active decision', async () => {
  const root = await repo();
  await go(root, ['retire', B, '--yes']);
  expect(await go(root, ['retire', A, '--by', B, '--yes'])).toEqual({ code: 1, out: `harness remember: ${B} is retired, not active. Only an active decision can supersede another.` });
  expect(read(root, A).status).toBe('active');
});

test('confirm and retire: secrets in <id> or --by are refused unechoed', async () => {
  const root = await repo();
  const r = await go(root, ['confirm', 'token=abcdefgh12', '--yes']);
  expect(r).toEqual({ code: 1, out: 'harness remember: <id> looks like it holds a secret (assignment). Decisions are committed to git. Remove it.' });
  expect((await go(root, ['retire', A, '--by', 'token=abcdefgh12', '--yes'])).out).toBe('harness remember: --by looks like it holds a secret (assignment). Decisions are committed to git. Remove it.');
  expect(events(root).at(-1)).toMatchObject({ decision: 'refused', reason: 'secret' });
});

for (const sub of ['confirm', 'retire']) {
  test(`${sub}: a typed yes writes`, async () => {
    const root = await repo();
    const asked: string[] = [];
    const yes: Prompt = { async confirm(q) { asked.push(q); return true; }, async edit(_l, v) { return v; } };
    expect((await go(root, [sub, A], { tty: true, prompt: yes })).code).toBe(0);
    expect(asked).toEqual(['Write these files? [y/N]']);
    expect(read(root, A).status).toBe(sub === 'confirm' ? 'active' : 'retired');
  });
}
