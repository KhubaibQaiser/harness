import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../../src/core/events.js';
import type { TimingLine } from '../../src/core/timing.js';
import type { SessionCtx } from '../../src/report/acc.js';
import { gatesAcc } from '../../src/report/metrics/gates.js';
import { parseRecords, type TRec } from '../../src/report/transcript.js';
import { turnSplitter, type Turn } from '../../src/report/turns.js';
import { assistant, attachment, prompt, system, toolResult } from '../fixtures/transcripts/make.js';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const rec = (at: number, r: object): TRec[] => parseRecords(JSON.stringify({ timestamp: iso(at), ...r }));
const use = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const ev = (at: number, check: string, decision: string, o: Partial<HarnessEvent> = {}): HarnessEvent => ({ ts: iso(at), session: 's1', check, decision, ...o });
const ctx: SessionCtx = { id: 's1', turns: 0, compactions: 0, edited: [] };
/** Feeds records through the accumulator the way runSession does. */
const run = (events: HarnessEvent[], recs: TRec[], timing: TimingLine[] = []) => {
  const a = gatesAcc(events, timing, 0);
  const turns: Turn[] = [];
  const sp = turnSplitter((t) => turns.push(t));
  for (const r of recs) { sp.push(r); a.rec!(ctx, r); }
  sp.end();
  turns.forEach((t) => a.turn!(ctx, t));
  return a.result();
};
const approved = { permissionDecision: { decision: 'accept', source: 'user_temporary' } };
const timing = (ms: number, o: Partial<TimingLine> = {}): TimingLine => ({ ts: iso(0), session: 's1', event: 'PreToolUse', outcome: 'allow', ms, ...o });

describe('ask approved', () => {
  const tool = (at: number) => rec(at, assistant({ content: [use('toolu_1', 'Edit', { file_path: 'a.ts' })] }));
  it('joins on use exactly', () => {
    const r = run([ev(0, 'tdd', 'ask', { use: 'toolu_1' })], [...rec(0, prompt('go')), ...tool(10), ...rec(20, toolResult('toolu_1', approved))]);
    expect(r.falseBlocks).toMatchObject([{ signal: 'ask-approved', fuzzy: false, check: 'tdd' }]);
  });
  it('falls back to the nearest tool use within 2 s, marked fuzzy', () => {
    const recs = [...rec(0, prompt('go')), ...tool(1000), ...rec(1100, toolResult('toolu_1', approved))];
    expect(run([ev(1500, 'tdd', 'ask')], recs).falseBlocks).toMatchObject([{ signal: 'ask-approved', fuzzy: true }]);
    expect(run([ev(4000, 'tdd', 'ask')], recs).falseBlocks).toEqual([]);
  });
  it('counts one ask event once', () => {
    const twice = [...rec(0, prompt('go')), ...tool(10), ...rec(20, toolResult('toolu_1', approved)), ...rec(30, toolResult('toolu_1', approved))];
    expect(run([ev(0, 'tdd', 'ask', { use: 'toolu_1' })], twice).falseBlocks).toHaveLength(1);
    expect(run([ev(15, 'tdd', 'ask')], twice).falseBlocks).toHaveLength(1);
  });
  it('ignores a plain accept from a rule', () => {
    const r = run([ev(0, 'tdd', 'ask', { use: 'toolu_1' })], [...rec(0, prompt('go')), ...tool(10), ...rec(20, toolResult('toolu_1', { permissionDecision: { decision: 'accept', source: 'config' } }))]);
    expect(r.falseBlocks).toEqual([]);
  });
});

describe('deny then retry', () => {
  const turn = (retry: object) => [...rec(0, prompt('go')), ...rec(10, assistant({ content: [use('t1', 'Edit', { file_path: 'a.ts' })] })), ...rec(20, toolResult('t1', { isError: true, content: 'denied' })), ...rec(30, assistant({ content: [retry] })), ...rec(40, toolResult('t2'))];
  const deny = [ev(5, 'tdd', 'deny', { use: 't1', reason: 'write a test first' })];
  it('flags the same tool and target in the same turn with no event, with a quote', () => {
    const r = run(deny, turn(use('t2', 'Edit', { file_path: 'a.ts' })));
    expect(r.falseBlocks).toMatchObject([{ signal: 'deny-retry', turn: 1, fuzzy: false, quote: 'write a test first' }]);
  });
  it('ignores another target, a retry that also has an event, and a malformed tool use', () => {
    expect(run(deny, turn(use('t2', 'Edit', { file_path: 'b.ts' }))).falseBlocks).toEqual([]);
    expect(run([...deny, ev(35, 'tdd', 'deny', { use: 't2' })], turn(use('t2', 'Edit', { file_path: 'a.ts' }))).falseBlocks).toEqual([]);
    const r = run(deny, turn({ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }));
    expect(r.falseBlocks).toEqual([]);
    expect(r.notes.unknownTools).toBe(1);
  });
  it('does not call a different command with the same first word a retry', () => {
    const bash = (d: string, c: string) => [...rec(0, prompt('go')), ...rec(10, assistant({ content: [use('t1', 'Bash', { command: d })] })), ...rec(30, assistant({ content: [use('t2', 'Bash', { command: c })] })), ...rec(40, toolResult('t2'))];
    expect(run(deny, bash('git push --force', 'git status')).falseBlocks).toEqual([]);
    expect(run(deny, bash('git push --force', 'git push origin')).falseBlocks).toHaveLength(1);
  });
  it('does not call a failed retry a retry', () => {
    const recs = [...rec(0, prompt('go')), ...rec(10, assistant({ content: [use('t1', 'Edit', { file_path: 'a.ts' })] })), ...rec(30, assistant({ content: [use('t2', 'Edit', { file_path: 'a.ts' })] })), ...rec(40, toolResult('t2', { isError: true }))];
    expect(run(deny, recs).falseBlocks).toEqual([]);
  });
  it('links a deny with no use by time and reason, marked fuzzy', () => {
    const noUse = [ev(5, 'tdd', 'deny', { reason: 'write a test first' })];
    const recs = (gap: number) => [...rec(0, prompt('go')), ...rec(10 + gap, assistant({ content: [use('t1', 'Edit', { file_path: 'a.ts' })] })), ...rec(20 + gap, toolResult('t1', { isError: true, content: 'Blocked: write a test first' })), ...rec(30 + gap, assistant({ content: [use('t2', 'Edit', { file_path: 'a.ts' })] })), ...rec(40 + gap, toolResult('t2'))];
    expect(run(noUse, recs(0))).toMatchObject({ falseBlocks: [{ signal: 'deny-retry', fuzzy: true }], notes: { denyUnlinked: 0 } });
    const far = run(noUse, recs(3000));
    expect(far.falseBlocks).toEqual([]);
    expect(far.notes.denyUnlinked).toBe(1);
  });
  describe('fuzzy deny link', () => {
    const recs = (text: string) => [...rec(0, prompt('go')), ...rec(10, assistant({ content: [use('t1', 'Edit', { file_path: 'a.ts' })] })), ...rec(20, toolResult('t1', { isError: true, content: text })), ...rec(30, assistant({ content: [use('t2', 'Edit', { file_path: 'a.ts' })] })), ...rec(40, toolResult('t2'))];
    it('does not link when the reason is not in the result text', () => {
      const r = run([ev(5, 'tdd', 'deny', { reason: 'write a test first' })], recs('ENOENT: no such file'));
      expect(r.falseBlocks).toEqual([]);
      expect(r.notes.denyUnlinked).toBe(1);
    });
    it('does not link an empty or short reason to any error', () => {
      for (const reason of [undefined, '', '  no  ']) {
        const r = run([ev(5, 'tdd', 'deny', reason === undefined ? {} : { reason })], recs('anything at all'));
        expect(r.falseBlocks).toEqual([]);
        expect(r.notes.denyUnlinked).toBe(1);
      }
    });
    it('pairs a co deny with its twin instead of counting it unlinked', () => {
      const r = run([ev(5, 'tdd', 'deny', { reason: 'write a test first' }), ev(6, 'guard', 'deny', { reason: 'protected file here', co: true })], recs('Blocked: write a test first'));
      expect(r.falseBlocks).toHaveLength(1);
      expect(r.notes.denyUnlinked).toBe(0);
    });
  });
  it('matches a Bash retry by first word and path arguments', () => {
    const bash = (c: string) => [...rec(0, prompt('go')), ...rec(10, assistant({ content: [use('t1', 'Bash', { command: 'rm -rf dist/x' })] })), ...rec(30, assistant({ content: [use('t2', 'Bash', { command: c })] })), ...rec(40, toolResult('t2'))];
    expect(run(deny, bash('rm dist/x')).falseBlocks).toHaveLength(1);
    expect(run(deny, bash('rm dist/y')).falseBlocks).toEqual([]);
  });
});

describe('stop gate', () => {
  const blocked = ev(0, 'stop', 'block', { reason: 'lint failed (attempt 1/3): x' });
  const stop = (at: number) => rec(at, system('stop_hook_summary', { preventedContinuation: false }));
  const edit = rec(30_000, assistant({ content: [use('e1', 'Edit', { file_path: 'a.ts' })] }));
  it('counts a flake when the next stop passes with no edit between', () => {
    const r = run([blocked], [...rec(0, prompt('go')), ...stop(500), ...stop(60_000)]);
    expect(r.stopSteps).toMatchObject([{ step: 'lint', blocks: 1, flakes: 1 }]);
    expect(r.falseBlocks).toMatchObject([{ signal: 'stop-flake', step: 'lint', fuzzy: true }]);
  });
  it('counts none when an edit came between', () => {
    expect(run([blocked], [...rec(0, prompt('go')), ...stop(500), ...edit, ...stop(60_000)]).stopSteps[0]).toMatchObject({ flakes: 0 });
  });
  it('counts a shell write as a reset, a read-only command as none', () => {
    const sh = (c: string) => rec(30_000, assistant({ content: [use('b1', 'Bash', { command: c })] }));
    expect(run([blocked], [...rec(0, prompt('go')), ...stop(500), ...sh('sed -i s/a/b/ a.ts'), ...stop(60_000)]).stopSteps[0]).toMatchObject({ flakes: 0 });
    expect(run([blocked], [...rec(0, prompt('go')), ...stop(500), ...sh('ls'), ...stop(60_000)]).stopSteps[0]).toMatchObject({ flakes: 1 });
  });
  it('says when there is no timing log to give step latency', () => {
    expect(run([blocked], []).notes.noTimingLog).toBe(true);
    expect(run([blocked], [], [timing(5)]).notes.noTimingLog).toBe(false);
  });
  it('merges runs and percentiles from the timing log', () => {
    const t = [10, 20, 30].map((ms) => timing(ms, { event: 'Stop', step: 'lint' }));
    expect(run([blocked], [], t).stopSteps).toEqual([{ step: 'lint', runs: 3, blocks: 1, flakes: 0, p50: 20, p95: 30 }]);
  });
});

describe('counts and overrides', () => {
  it('tallies like stats and flags gave-up and overrides', () => {
    const r = run([ev(0, 'harness-files', 'stop-gave-up'), ev(1, 'tdd', 'paused'), ev(2, 'multi-file', 'approved'), ev(3, 'multi-file', 'allow-log'), ev(4, 'harness-files', 'harness-files-changed', { reason: '.harness/config.yaml' }), ev(5, 'harness-files', 'harness-files-changed', { reason: 'src/a.ts' })], []);
    expect(r.overrides).toEqual({ 'tdd paused': 1, 'multi-file approvals': 2, 'allow-log': 1 });
    expect(r.tally['multi-file allow-log']).toBe(1);
    expect(r.falseBlocks.map((f) => f.signal).sort()).toEqual(['gave-up', 'override', 'override', 'override', 'override']);
  });
  it('counts hallucination checks', () => {
    const r = run([ev(0, 'stop', 'block', { reason: 'typecheck failed (attempt 1/3)' }), ev(1, 'stop', 'block', { reason: 'test failed (attempt 1/3)' }), ev(2, 'dep-verify', 'deny'), ev(3, 'dep-verify', 'ask')], []);
    expect(r.hallucination).toEqual({ typecheckBlocks: 1, testBlocks: 1, registryChecks: 2, registryDenies: 1 });
  });
  it('counts bad events instead of dropping them', () => {
    expect(run([{ ts: 'x', session: 's', check: 'a', decision: 'b' }, { check: 1 } as unknown as HarnessEvent], []).notes).toMatchObject({ noTime: 1, badEvents: 1 });
  });
});

describe('latency', () => {
  it('uses nearest rank and keeps a timeout apart from a block', () => {
    const t = [...Array.from({ length: 100 }, (_, i) => timing(i + 1)), timing(5000, { outcome: 'timeout' })];
    const rows = run([], [], t).latency;
    expect(rows.find((x) => x.outcome === 'allow')).toMatchObject({ source: 'timing', n: 100, p50: 50, p95: 95, max: 100, timeouts: 0 });
    expect(rows.find((x) => x.outcome === 'timeout')).toMatchObject({ n: 1, timeouts: 1 });
    expect(rows.find((x) => x.outcome === 'block')).toBeUndefined();
  });
  it('counts a transcript timeout with no duration, without a 0 ms sample', () => {
    const rows = run([], rec(0, attachment('hook_cancelled', { hookEvent: 'Stop', command: 'node .harness/hooks/dispatch.mjs', timedOut: true }))).latency;
    expect(rows).toEqual([{ source: 'transcript', event: 'Stop', n: 0, p50: 0, p95: 0, max: 0, timeouts: 1 }]);
  });
  it('reads only dispatch.mjs hooks from the transcript', () => {
    const hook = (command: string, ms: number) => rec(0, attachment('hook_success', { hookEvent: 'PreToolUse', command, durationMs: ms }));
    const rows = run([], [...hook('node /r/.harness/hooks/dispatch.mjs', 40), ...hook('node other-plugin/hook.js', 900)]).latency;
    expect(rows).toEqual([{ source: 'transcript', event: 'PreToolUse', n: 1, p50: 40, p95: 40, max: 40, timeouts: 0 }]);
  });
});
