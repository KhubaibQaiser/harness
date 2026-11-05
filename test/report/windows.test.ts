import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runSession } from '../../src/report/turns.js';
import { COUNT_FIELDS, MAIN_THREAD_ONLY, RX, windowsAcc, type WindowRule } from '../../src/report/windows.js';
import { assistant, prompt, toolResult, writeSession } from '../fixtures/transcripts/make.js';

const dir = mkdtempSync(join(tmpdir(), 'harness-windows-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let k = 0;
const text = (t: string) => assistant({ content: [{ type: 'text', text: t }] });
const use = (name: string, input: object, id = `t${++k}`) => assistant({ content: [{ type: 'tool_use', id, name, input }] });
const edit = (file: string) => use('Edit', { file_path: `/repo/${file}` });
const bash = (command: string) => use('Bash', { command });
const ask = (options: object[]) => use('AskUserQuestion', { questions: [{ question: 'Which?', options }] });

/** Runs each session (a list of records) through the real runSession, as `harness report` does. */
type Sess = object[] | { recs: object[]; sub: object[] };
const run = async (sessions: Sess[], opts: { tddGateOn?: boolean; cap?: number } = {}) => {
  const acc = windowsAcc({ tddGateOn: opts.tddGateOn ?? false, cap: opts.cap, root: '/repo' });
  for (const [i, x] of sessions.entries()) {
    const id = `w${++k}`, recs = Array.isArray(x) ? x : x.recs;
    const main = writeSession(dir, id, recs, Array.isArray(x) ? {} : { subagents: { a: x.sub } });
    await runSession({ main, subagents: Array.isArray(x) ? [] : [join(dir, id, 'subagents', 'agent-a.jsonl')] }, `s${i}`, [acc], 0);
  }
  return acc.result();
};
const got = async (rule: WindowRule, sessions: Sess[], opts?: { tddGateOn?: boolean }) => (await run(sessions, opts)).byRule[rule];

describe('RX', () => {
  it('is case-insensitive, listLine also multiline', () => {
    for (const r of Object.values(RX)) expect(r.flags).toContain('i');
    expect(RX.listLine.flags).toContain('m');
  });
});

describe('ask-first', () => {
  it('opens on a choice then an edit with no AskUserQuestion', async () => {
    const r = await got('ask-first', [[prompt('do it'), text("I'll go with option A"), edit('src/a.ts')]]);
    expect(r.total).toBe(1);
    expect(r.windows[0]).toMatchObject({ rule: 'ask-first', session: 's0', turn: 1, date: '2026-11-01', prompt: 'do it' });
    expect(r.windows[0]!.tools[0]).toMatch(/^Edit \((ok|error|no result)\)$/);
  });
  it('stays closed when AskUserQuestion comes before the edit, and counts asks', async () => {
    const opts = [{ label: 'A (recommended)' }, { label: 'B' }];
    const r = await got('ask-first', [[prompt('do it'), text("I'll go with option A"), ask(opts), ask([{ label: 'X' }]), edit('src/a.ts')]]);
    expect(r.total).toBe(0);
    expect(r.counters).toMatchObject({ asks: 2, asksWith2Options: 1, asksWithRecommendation: 1 });
  });
  it('does not count asks in a turn that ends up unknown', async () => {
    const r = await got('ask-first', [[prompt('x'), ask([{ label: 'A' }, { label: 'B' }]), { type: 7 }]]);
    expect(r.counters).toMatchObject({ asks: 0, asksWith2Options: 0 });
  });
  it('a git commit counts as the decision being acted on', async () => {
    expect((await got('ask-first', [[prompt('x'), text('I decided to split it'), bash('git commit -m x')]])).total).toBe(1);
  });
});

describe('no-invented-data', () => {
  it('opens on a number with a unit found in no tool result', async () => {
    const r = await got('no-invented-data', [[prompt('x'), bash('ls'), toolResult(`t${k}`, { content: 'done' }), text('This cuts latency by 40%.')]]);
    expect(r.total).toBe(1);
    expect(r.counters.numbers).toBe(1);
  });
  it('a label in the sentence closes it', async () => {
    const r = await got('no-invented-data', [[prompt('x'), text('Fast. This cuts latency by about 40%.')]]);
    expect(r).toMatchObject({ total: 0, counters: { numbersLabelled: 1 } });
  });
  it('the number in a tool result closes it', async () => {
    const r = await got('no-invented-data', [[prompt('x'), bash('bench'), toolResult(`t${k}`, { content: 'p50 dropped 40%' }), text('This cuts latency by 40%.')]]);
    expect(r).toMatchObject({ total: 0, counters: { numbersInResults: 1 } });
  });
  it('counts numbers past the 20-number cap and texts past 64 KB', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `about ${i}%`).join(', ');
    expect((await got('no-invented-data', [[prompt('x'), text(many)]])).counters).toMatchObject({ numbers: 20, numbersSkipped: 5, textsCut: 0 });
    expect((await got('no-invented-data', [[prompt('x'), text('a'.repeat(70 * 1024))]])).counters.textsCut).toBe(1);
  });
});

describe('fix-everything', () => {
  const findings = text('Found these issues:\n- one\n- two\n- three');
  it('opens when a findings list ends in a skip', async () => {
    const r = await got('fix-everything', [[prompt('review'), findings, edit('src/a.ts'), text('Fixed two. I skipped the third.')]]);
    expect(r).toMatchObject({ total: 1, counters: { findingsTurns: 1, editsAfter: 1 } });
  });
  it('stays closed with no skip word', async () => {
    expect((await got('fix-everything', [[prompt('review'), findings, edit('src/a.ts'), text('All three fixed.')]])).total).toBe(0);
  });
});

describe('readme-per-pr', () => {
  it('opens on gh pr create in a session that edited src/ and not README.md', async () => {
    const r = await got('readme-per-pr', [[prompt('ship'), edit('src/a.ts'), prompt('pr'), bash('gh pr create --fill')]]);
    expect(r).toMatchObject({ total: 1, counters: { prCreates: 1, prCreatesWithReadme: 0 } });
    expect(r.windows[0]!.turn).toBe(2);
  });
  it('resolves edits against the repo root for a session started in a subfolder; only the root README counts', async () => {
    const sub = { cwd: '/repo/pkg' };
    const r = await got('readme-per-pr', [[{ ...prompt('ship'), ...sub }, { ...edit('src/a.ts'), ...sub }, { ...edit('docs/README.md'), ...sub }, { ...bash('gh pr create'), ...sub }]]);
    expect(r).toMatchObject({ total: 1, counters: { prCreatesWithReadme: 0 } });
  });
  it('stays closed with a README edit', async () => {
    const r = await got('readme-per-pr', [[prompt('ship'), edit('src/a.ts'), edit('README.md'), bash('gh pr create --fill')]]);
    expect(r).toMatchObject({ total: 0, counters: { prCreates: 1, prCreatesWithReadme: 1 } });
  });
});

describe('paid-ok', () => {
  it('opens on git push after a prompt with no approval word', async () => {
    expect(await got('paid-ok', [[prompt('fix the test'), bash('git push origin x')]])).toMatchObject({ total: 1, counters: { paidCommands: 1 } });
  });
  it('stays closed after "yes, push it"', async () => {
    expect(await got('paid-ok', [[prompt('yes, push it'), bash('git push origin x')]])).toMatchObject({ total: 0, counters: { paidWithApproval: 1 } });
  });
});

describe('plain-communication', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  it('opens on an average sentence over 25 words', async () => {
    expect((await got('plain-communication', [[prompt('x'), text(`${words(30)}. ${words(30)}.`)]])).total).toBe(1);
  });
  it('ignores a fenced code block', async () => {
    expect((await got('plain-communication', [[prompt('x'), text(`${words(10)}.\n\`\`\`\n${words(200)}\n\`\`\``)]])).total).toBe(0);
  });
});

describe('tdd', () => {
  const s = [[prompt('x'), edit('src/a.ts'), edit('src/a.test.ts')]];
  it('opens when source is edited before its test with the gate off', async () => {
    expect(await got('tdd', s)).toMatchObject({ total: 1, counters: { bothKinds: 1 } });
  });
  it('makes no window with the gate on', async () => {
    expect((await got('tdd', s, { tddGateOn: true })).total).toBe(0);
  });
});

describe('caps, parts, unknown, decay', () => {
  const paid = (n: number) => Array.from({ length: n }, () => [prompt('fix'), bash('git push')]).flat();
  it('keeps 50 windows per rule, newest first, and counts the rest', async () => {
    const r = await got('paid-ok', Array.from({ length: 6 }, () => paid(10)));
    expect(r.windows).toHaveLength(50);
    expect(r.total).toBe(60);
    expect(r.windows[0]).toMatchObject({ session: 's5', turn: 10 });
  });
  it('cuts every part to 600 characters and flags control characters', async () => {
    const long = 'a'.repeat(2000);
    const r = await got('paid-ok', [[prompt(`${long}\u001b[2J`), text(long), text(long), ...Array.from({ length: 100 }, () => bash('git push'))]]);
    const w = r.windows[0]!;
    for (const part of [w.prompt, w.texts, ...w.tools]) expect(part.length).toBeLessThanOrEqual(600);
    expect(w.control).toBeUndefined(); // the escape sits past the cut
    const c = (await got('paid-ok', [[prompt('fix \u001b[2J'), bash('git push')]])).windows[0]!;
    expect(c.control).toBe(true);
    expect(c.prompt).toBe('fix \u001b[2J'); // raw, escaped later by the HTML
    expect((await got('paid-ok', [[prompt('fix\r\nnow'), bash('git push')]])).windows[0]!.control).toBeUndefined();
    expect((await got('paid-ok', [[prompt('fix \u200b\u202e'), bash('git push')]])).windows[0]!.control).toBe(true);
  });
  it('a turn with a bad record or a malformed tool use is unknown and makes no window', async () => {
    const r = await run([[prompt('fix'), bash('git push'), { type: 7 }], [prompt('fix'), assistant({ content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }] })]]);
    expect(r.unknown).toBe(2);
    expect(r.byRule['paid-ok'].total).toBe(0);
  });
  it('breaks same-day ties by timestamp, not scan order', async () => {
    const at = (ts: string, rs: object[]) => rs.map((r) => ({ ...r, timestamp: ts }));
    const r = await got('paid-ok', [at('2026-11-01T05:00:00.000Z', [prompt('fix'), bash('git push')]), at('2026-11-01T01:00:00.000Z', [prompt('fix'), bash('git push')])]);
    expect(r.windows.map((w) => w.session)).toEqual(['s0', 's1']);
  });
  it('counts records before the first prompt instead of putting them on turn 1', async () => {
    const r = await run([[{ type: 7 }, text('hi'), prompt('fix'), bash('git push')]]);
    expect(r.notes.beforeFirstPrompt).toBe(2);
    expect(r.unknown).toBe(0);
    expect(r.byRule['paid-ok'].total).toBe(1);
  });
  it('counts subagent records, which the main-thread-only rules do not see', async () => {
    const r = await run([{ recs: [prompt('fix'), text("I'll go with option A")], sub: [prompt('task'), edit('src/a.ts'), { type: 7 }] }]);
    expect(r.notes).toMatchObject({ sideRecords: 3, sideBad: 1 });
    expect(r.byRule['ask-first'].total).toBe(0);
    expect(MAIN_THREAD_ONLY).toEqual(['ask-first', 'fix-everything', 'no-invented-data', 'plain-communication']);
  });
  it('names the count-only fields an export may take', () => {
    expect(COUNT_FIELDS).toEqual({ rule: ['total', 'counters', 'byBucket', 'byCompact'], top: ['unknown', 'notes'] });
  });
  it('splits turns and windows by bucket and compaction', async () => {
    const r = await got('paid-ok', [[prompt('fix'), bash('git push'), prompt('ok thanks')]]);
    expect(r.byBucket['1-10']).toEqual({ turns: 2, windows: 1 });
    expect(r.byCompact).toEqual({ pre: { turns: 2, windows: 1 }, post: { turns: 0, windows: 0 } });
  });
});
