import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ASSISTANT_SIGNALS, decisionNotes, decisionSignals, EXCERPT, MAX_HITS, PROMPT_SCAN, PROMPT_SIGNALS } from '../../src/checks/decisions-stop.js';
import { loadConfig } from '../../src/core/config.js';
import { readEvents } from '../../src/core/events.js';
import { readTail, TRANSCRIPT_TAIL } from '../../src/checks/multi-file.js';
import { readState, type SessionState } from '../../src/core/state.js';
import { registry } from '../../src/hooks/dispatch.js';
import type { Ctx } from '../../src/hooks/check.js';
import type { HookInput } from '../../src/hooks/types.js';
import { assistant, prompt, toolResult } from '../fixtures/transcripts/make.js';

type Opts = { input?: Partial<HookInput>; state?: Partial<SessionState>; yaml?: string; unattended?: boolean };
const mk = (o: Opts = {}): Ctx => {
  const root = mkdtempSync(join(tmpdir(), 'h-dstop-'));
  if (o.yaml) {
    mkdirSync(join(root, '.harness'));
    writeFileSync(join(root, '.harness/config.yaml'), o.yaml);
  }
  const ctx = {
    input: { session_id: 's', cwd: root, hook_event_name: 'UserPromptSubmit', ...o.input },
    root, config: loadConfig(root).config, state: { ...readState(root, 's'), ...o.state }, unattended: !!o.unattended, env: {},
    save(s: SessionState) { ctx.state = s; },
  } as Ctx;
  return ctx;
};
const say = (ctx: Ctx, text: string) => {
  ctx.input = { ...ctx.input, hook_event_name: 'UserPromptSubmit', prompt: text };
  expect(decisionSignals.run(ctx)).toEqual({ kind: 'allow' });
};
const stop = (ctx: Ctx, last?: string) => {
  ctx.input = { ...ctx.input, hook_event_name: 'Stop', ...(last === undefined ? {} : { last_assistant_message: last }) };
  expect(decisionSignals.run(ctx)).toEqual({ kind: 'allow' });
  return decisionNotes(ctx, []);
};
const ids = (ctx: Ctx) => (ctx.state.decisionHits ?? []).map((h) => h.pattern);
const candidates = (ctx: Ctx) => readEvents(ctx.root).filter((e) => e.decision === 'decision-candidate');

const P: [string, string, string][] = [
  ['P1', 'from now on use the env schema', 'we trade in futures'],
  ['P2', 'always use pnpm here', 'an always-on toggle'],
  ['P3', "don't use lodash", "don't worry about it"],
  ['P4', 'we decided to use zod', 'we decide later'],
  ['P5', 'our convention is kebab-case', 'our conventions are loose'],
];
const A: [string, string, string][] = [
  ['A1', "Done. I'll remember that.", 'I remembered the flag.'],
  ['A2', 'From now on, I will run lint first.', 'never mind, going forward we will see'],
];

test('shape: constants, P1 to P5 and A1 and A2, case-insensitive; registered for prompts and tool results, not pure', () => {
  expect([MAX_HITS, PROMPT_SCAN, EXCERPT]).toEqual([3, 4000, 120]);
  expect(PROMPT_SIGNALS.map(([id]) => id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
  expect(ASSISTANT_SIGNALS.map(([id]) => id)).toEqual(['A1', 'A2']);
  expect([...PROMPT_SIGNALS, ...ASSISTANT_SIGNALS].every(([, re]) => re.flags.includes('i'))).toBe(true);
  expect(decisionSignals.events).toEqual(['UserPromptSubmit', 'PostToolUse', 'Stop']);
  expect(decisionSignals.pure).toBeFalsy();
  expect(registry).toContain(decisionSignals);
});

test.each(P)('%s matches its sample, and its negative sample matches nothing', (id, yes, no) => {
  const c = mk();
  say(c, yes.toUpperCase());
  expect(ids(c)).toEqual([id]);
  const n = mk();
  say(n, no);
  expect(n.state.decisionHits).toBeUndefined();
});

test.each(A)('%s matches at Stop, and its negative sample gives no note', (_id, yes, no) => {
  expect(stop(mk(), yes)).toHaveLength(1);
  expect(stop(mk(), no)).toEqual([]);
});

test('the nudge copy, verbatim, with the first hit\'s excerpt; shown once per session', () => {
  const c = mk();
  say(c, 'from now on use the env schema');
  say(c, 'always use pnpm');
  expect(stop(c)).toEqual([
    'Harness: this session may hold a team decision (you said "from now on use the env schema"). To keep it for the team, ask Claude to save it with `harness remember add`; you approve the write and the PR reviews it. If it\'s only your own preference, Claude Code\'s auto memory is the place.',
  ]);
  expect(c.state.decisionNudged).toBe(true);
  expect(stop(c, "I'll remember that")).toEqual([]);
});

test('the excerpt is the 120 characters around the match, on one line, marked where cut', () => {
  const c = mk();
  say(c, `${'x\n'.repeat(200)}from now on use zod${' y'.repeat(200)}`);
  const ex = c.state.decisionHits![0].excerpt;
  expect(ex).toMatch(/^….*from now on use zod.*…$/);
  expect(ex).not.toContain('\n');
  expect(ex.length).toBeLessThanOrEqual(EXCERPT + 2);
});

test('only the first 4,000 characters of a prompt are read', () => {
  const c = mk();
  say(c, `${'a'.repeat(PROMPT_SCAN)} from now on use zod`);
  expect(c.state.decisionHits).toBeUndefined();
});

test('at most 3 hits are stored', () => {
  const c = mk();
  say(c, 'from now on always use zod; we decided. our rule is this. stop using lodash');
  say(c, 'from now on use x');
  expect(c.state.decisionHits).toHaveLength(MAX_HITS);
});

test('no nudge after a harness remember add ran; a failed one or another tool records nothing', () => {
  const post = (c: Ctx, tool: string, command: string, res: unknown) => {
    c.input = { ...c.input, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { command }, tool_response: res };
    decisionSignals.run(c);
  };
  const c = mk({ state: { decisionHits: [{ pattern: 'P1', excerpt: 'from now on' }] } });
  post(c, 'Bash', 'harness remember list', { stdout: '' });
  post(c, 'Bash', 'harness remember add --title x', { interrupted: true });
  post(c, 'Edit', 'remember add', {});
  expect(c.state.rememberAdded).toBeUndefined();
  post(c, 'Bash', 'harness remember list && git add .', { stdout: '' });
  post(c, 'Bash', 'harness remember add --title "Zod" --rule "use zod" --path src/a.ts --dry-run', { stdout: 'Would write' });
  post(c, 'Bash', 'echo remember to add tests', { stdout: '' });
  expect(c.state.rememberAdded).toBeUndefined(); // final review M4: only a real add that writes
  post(c, 'Bash', 'npx @khubaibqaiser/harness remember add --title "Zod" --rule "use zod" --path src/a.ts --yes', { stdout: 'Saved' });
  expect(c.state.rememberAdded).toBe(true);
  expect(stop(c)).toEqual([]);
});

test('no nudge with decisions.nudge: false; no signals with checks.decisions: false', () => {
  const off = mk({ yaml: 'decisions:\n  nudge: false\n' });
  say(off, 'from now on use zod');
  expect(stop(off)).toEqual([]);
  const none = mk({ yaml: 'checks:\n  decisions: false\n' });
  say(none, 'from now on use zod');
  expect(none.state.decisionHits).toBeUndefined();
});

test('unattended: no note, nothing stored to show, one redacted decision-candidate per hit', () => {
  const c = mk({ unattended: true });
  say(c, `from now on always use token=${'abc123'.repeat(3)} here`);
  expect(c.state.decisionHits).toBeUndefined();
  expect(stop(c, "I'll remember that")).toEqual([]);
  const ev = candidates(c);
  expect(ev.map((e) => e.reason?.split(':')[0])).toEqual(['P1', 'P2', 'A1']);
  expect(ev.every((e) => e.check === 'decisions')).toBe(true);
  expect(ev[0].reason).toContain('[redacted]');
  expect(JSON.stringify(ev)).not.toContain('abc123');
});

test('A signals fall back to the last assistant text in the transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-dstop-t-'));
  const t = join(dir, 't.jsonl');
  const recs = [prompt('lint please'), assistant({ content: [{ type: 'text', text: 'Sure.' }] }), assistant({ content: [{ type: 'text', text: 'Going forward, I will run lint first.' }] })];
  writeFileSync(t, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const c = mk({ input: { transcript_path: t } });
  const [note] = stop(c);
  // final review M2: text read from the transcript is never stored or shown, only the signal id
  expect(note).toMatch(/^Harness: this session may hold a team decision\. To keep it/);
  expect(c.state.decisionHits).toEqual([{ pattern: 'A2', excerpt: '' }]);
  expect(stop(mk({ input: { transcript_path: join(dir, 'missing.jsonl') } }))).toEqual([]);
});

test('a transcript that ends in a tool result still falls back to the assistant text before it', () => {
  const t = join(mkdtempSync(join(tmpdir(), 'h-dstop-tr-')), 't.jsonl');
  const recs = [prompt('lint please'), assistant({ content: [{ type: 'text', text: 'Going forward, I will run lint first.' }] }), toolResult('t1', { content: 'lint ok' })];
  writeFileSync(t, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  expect(stop(mk({ input: { transcript_path: t } }))[0]).toMatch(/^Harness: this session may hold a team decision\. To keep it/);
});

test('the fallback reads only the current turn: an earlier turn\'s text is never picked, nor logged twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-dstop-t-'));
  const write = (name: string, recs: Record<string, unknown>[]) => {
    writeFileSync(join(dir, name), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return join(dir, name);
  };
  const old = [prompt('a'), assistant({ content: [{ type: 'text', text: "I'll remember that." }] }), prompt('b')];
  expect(stop(mk({ input: { transcript_path: write('open.jsonl', old) } }))).toEqual([]);
  expect(stop(mk({ input: { transcript_path: write('next.jsonl', [...old, assistant({ content: [{ type: 'text', text: 'ok' }] })]) } }))).toEqual([]);
  const u = mk({ unattended: true, input: { transcript_path: write('u.jsonl', [prompt('a'), assistant({ content: [{ type: 'text', text: "I'll remember that." }] })]) } });
  stop(u);
  u.input = { ...u.input, transcript_path: write('u2.jsonl', [...old, assistant({ content: [{ type: 'text', text: 'Fixed lint.' }] })]) };
  stop(u);
  expect(candidates(u)).toHaveLength(1);
});

test('A hits are stored at Stop, under the cap, and shown from the stored state', () => {
  const c = mk({ yaml: 'checks:\n  stop: true\n' });
  c.input = { ...c.input, hook_event_name: 'Stop', last_assistant_message: "I'll remember that." };
  decisionSignals.run(c);
  expect(ids(c)).toEqual(['A1']);
  c.input = { ...c.input, last_assistant_message: 'Fixed lint.' };
  expect(decisionNotes(c, [])[0]).toContain('(Claude said "I\'ll remember that.")'); // final review M3
  const full = mk({ state: { decisionHits: [1, 2, 3].map((n) => ({ pattern: 'P1', excerpt: `e${n}` })) } });
  stop(full, "I'll remember that.");
  expect(full.state.decisionHits).toHaveLength(MAX_HITS);
});

test('readTail returns the last bytes of a file; the transcript cap is 8 MiB', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'h-dstop-tail-')), 'f');
  writeFileSync(p, '0123456789');
  expect([readTail(p, 4), readTail(p, 100)]).toEqual(['6789', '0123456789']);
  writeFileSync(p, 'ab\ncd\nef');
  expect(readTail(p, 4)).toBe('ef'); // the line the cut split is dropped
  expect(readTail(p, 5)).toBe('cd\nef'); // a cut on a line boundary keeps that whole line
  expect(TRANSCRIPT_TAIL).toBe(8 * 1024 * 1024);
});

test('final review M2: unattended, a hit read from the transcript logs only its signal id', () => {
  const t = join(mkdtempSync(join(tmpdir(), 'h-dstop-m2-')), 't.jsonl');
  writeFileSync(t, [prompt('a'), assistant({ content: [{ type: 'text', text: "I'll remember that secret plan." }] })].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const u = mk({ unattended: true, input: { transcript_path: t } });
  stop(u);
  expect(candidates(u).map((e) => e.reason)).toEqual(['A1']);
});

test('final review M3: the nudge quotes what the person said over what Claude said', () => {
  const c = mk({ state: { decisionHits: [{ pattern: 'A1', excerpt: "I'll remember that." }, { pattern: 'P1', excerpt: 'from now on use zod' }] } });
  const [note] = decisionNotes(c, []);
  expect(note).toContain('(you said "from now on use zod")');
  expect(note).not.toContain('remember that');
});
