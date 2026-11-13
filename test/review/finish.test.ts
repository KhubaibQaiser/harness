import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { PrFinding } from '../../src/ai/pr-review.js';
import { review } from '../../src/cli/review.js';
import { readEvents } from '../../src/core/events.js';
import { defaultExec, defaultExecBytes, type Exec } from '../../src/core/exec.js';
import { SAFE_GIT } from '../../src/core/git-safe.js';
import { commentable, diffArgs, parseDiff } from '../../src/review/diff.js';
import { writeGather, type GatherJson } from '../../src/review/gather.js';
import { readRecord, writeRecord, type ReviewRecord } from '../../src/review/record.js';
import { writeSnapshot } from '../../src/review/snapshot.js';
import { repoWith } from './repo.js';

// Synthetic repos, findings and verdicts, made up here. gh is faked; git runs in the temp repo.
const lines = Array.from({ length: 20 }, (_, i) => `line number ${i + 1}`).join('\n') + '\n';
function setup(g: Partial<GatherJson> = {}, gh: (a: string) => ReturnType<Exec> | undefined = () => undefined) {
  const r = repoWith({ 'b.ts': lines }, { 'a.ts': lines, 'img.bin': Buffer.from([0, 1, 2]) });
  const dir = join(r.root, '.harness', 'tmp', 'w-1');
  mkdirSync(dir, { recursive: true });
  const snap = writeSnapshot(defaultExecBytes, r.root, r.head, join(dir, 'head'), { ignore: () => false });
  const files = parseDiff(defaultExec('git', [...SAFE_GIT, ...diffArgs(r.base, r.head)], { cwd: r.root }).stdout);
  const gj: GatherJson = {
    repo: 'o/r', pr: 7, base: 'main', base_sha: r.base, head_sha: r.head, merge_base: r.base, nonce: 'c'.repeat(32), fork: null, labels: [], body_template: false, body_problems: [], max_findings: 15,
    files: files.map((f) => ({ path: f.path, status: f.status, binary: f.binary })), lines: commentable(files), map: snap.map, omitted: [], ...g,
  };
  writeGather(r.root, dir, gj);
  const calls: string[] = [];
  const exec: Exec = (c, a, o) => {
    if (c !== 'gh') return defaultExec(c, a, { cwd: r.root, ...o });
    const j = a.join(' ');
    calls.push(j);
    return gh(j) ?? (j === 'api user --jq .login' ? { status: 0, stdout: 'me\n' } : j.startsWith('api --paginate repos/o/r/pulls/7/reviews') ? { status: 0, stdout: '' } : { status: 1, stdout: '', stderr: `unexpected gh ${j}` });
  };
  return { root: r.root, dir, exec, calls, head: r.head };
}
const F: PrFinding = { id: 'f1', severity: 'medium', category: 'correctness', file: 'a.ts', line: 5, side: 'RIGHT', title: 'Looks wrong', evidence: { kind: 'quote', text: 'line number 5' }, fix: 'Fix it.' };
const at = (n: number, o: Partial<PrFinding> = {}): PrFinding => ({ ...F, id: `f${n}`, line: n, evidence: { kind: 'quote', text: `line number ${n}` }, ...o });
function finish(s: ReturnType<typeof setup>, findings: PrFinding[], verdicts: { id: string; supported: boolean; why: string }[], env: NodeJS.ProcessEnv = {}) {
  writeFileSync(join(s.dir, 'findings.json'), JSON.stringify({ findings, steering: [], summary: 'Summary text.', limits: 'Limits text.' }));
  writeFileSync(join(s.dir, 'judge.json'), JSON.stringify({ verdicts }));
  const out: string[] = [];
  const code = review(['--finish', s.dir, '--findings', join(s.dir, 'findings.json'), '--judge', join(s.dir, 'judge.json')], { root: s.root, env, out: (l) => out.push(...l.split('\n')) }, { exec: s.exec });
  const rec = readRecord(s.root, 7) as ReviewRecord;
  return { code, out, rec };
}
const yes = (...ids: string[]) => ids.map((id) => ({ id, supported: true, why: 'Shown.' }));

describe('finish', () => {
  test('placement, judge drops shown with the why, the record and the preview', () => {
    const s = setup();
    const r = finish(s, [at(5), at(9, { severity: 'critical' }), at(3, { file: 'b.ts' }), { ...F, id: 'bin', file: 'img.bin', line: 1, evidence: { kind: 'missing-test', search: 'img loader' } }, at(12, { evidence: { kind: 'quote', text: 'not in the file at all' } })],
      [...yes('f5', 'f3', 'bin'), { id: 'f9', supported: false, why: 'Line 9 is a plain string.' }]);
    expect(r.code, r.out.join('\n')).toBe(0);
    const by = Object.fromEntries(r.rec.findings.map((f) => [f.id, f]));
    expect(by.f5).toMatchObject({ placement: 'inline', judge_why: 'Shown.' });
    expect(by.f3).toMatchObject({ placement: 'summary' }); // b.ts is unchanged: no commentable line
    expect(by.bin).toMatchObject({ placement: 'summary' }); // binary: no lines
    expect(by.f9).toMatchObject({ placement: 'dropped', dropped_reason: 'judge: evidence does not support the claim', judge_why: 'Line 9 is a plain string.' });
    expect(by.f12).toMatchObject({ placement: 'dropped', dropped_reason: 'evidence not found near a.ts:12' });
    expect(r.rec.payload.comments).toEqual([{ path: 'a.ts', line: 5, side: 'RIGHT', body: '[medium] Looks wrong\n\nEvidence: line number 5\n\nFix: Fix it.' }]);
    expect(r.rec.payload_sha256).toBe(createHash('sha256').update(JSON.stringify(r.rec.payload)).digest('hex'));
    expect(r.rec.verdict).toBe('Comment');
    expect(r.rec.payload.body.trimEnd().endsWith('Code-only review: the app was not run.')).toBe(true);
    expect(r.rec.payload.body).toContain('b.ts:3 [medium] Looks wrong');
    expect(r.out).toContain('a.ts:5 [medium] Looks wrong');
    expect(r.out).toContain('dropped a.ts:9 [critical] Looks wrong: judge: evidence does not support the claim (judge: Line 9 is a plain string.)');
    expect(r.out).toContain('dropped a.ts:12 [medium] Looks wrong: evidence not found near a.ts:12');
    expect(r.out).toContain('Suggested verdict: Comment');
    expect(r.out.at(-1)).toBe('Record: .harness/reviews/7.json (local; nothing was posted)');
    const ev = readEvents(s.root).filter((e) => e.check === 'review');
    expect(ev.map((e) => e.decision)).toEqual(['review-finding-dropped', 'review-finding-dropped', 'review-previewed']);
    expect(ev.map((e) => e.reason)).toEqual([`pr 7 ${s.head.slice(0, 7)} evidence`, `pr 7 ${s.head.slice(0, 7)} judge`, `pr 7 ${s.head.slice(0, 7)} inline 1 summary 2 dropped 2`]);
  });
  test('16 kept with a cap of 15: 15 placed, most severe first, and a count line', () => {
    const s = setup();
    const fs = Array.from({ length: 16 }, (_, i) => at(i + 1, { severity: i === 15 ? 'critical' : 'nit' }));
    const r = finish(s, fs, yes(...fs.map((f) => f.id)));
    expect(r.rec.findings.filter((f) => f.placement !== 'dropped')).toHaveLength(15);
    expect(r.rec.findings.find((f) => f.id === 'f16')!.placement).toBe('inline');
    expect(r.rec.findings.find((f) => f.id === 'f15')).toMatchObject({ placement: 'dropped', dropped_reason: 'over review.max_findings' });
    expect(r.rec.payload.body).toContain('1 more findings not shown (review.max_findings is 15)');
    expect(r.rec.verdict).toBe('Request changes');
  });
  test('needs-human and the PR body check reach the summary; exit 0', () => {
    const s = setup({ labels: ['needs-human'], body_template: true, body_problems: ['empty sections: Security'] });
    const r = finish(s, [at(5)], yes('f5'));
    expect(r.code).toBe(0);
    expect(r.rec.payload.body).toContain('Needs human action before merge; do not auto-merge.');
    expect(r.rec.payload.body).toContain('PR body check: empty sections: Security');
  });
  test('an existing pending review is named; unattended says so last', () => {
    const s = setup({}, (a) => (a.startsWith('api --paginate repos/o/r/pulls/7/reviews/3/comments') ? { status: 0, stdout: '1\n2\n' }
      : a.startsWith('api --paginate repos/o/r/pulls/7/reviews') ? { status: 0, stdout: JSON.stringify(JSON.stringify({ id: 3, node_id: 'N', state: 'PENDING', user: { login: 'me' } })) + '\n' } : undefined));
    const r = finish(s, [at(5)], yes('f5'), { CI: 'true' });
    expect(r.out).toContain('Existing pending review: 3 with 2 comments');
    expect(r.out.at(-1)).toBe('pending review not posted: unattended run');
  });
  test('Review Focus 5: a second finish keeps the earlier posted block', () => {
    const s = setup();
    finish(s, [at(5)], yes('f5'));
    const posted = { review_id: 42, at: '2026-11-13T01:00:00.000Z', mode: 'new' as const };
    writeRecord(s.root, { ...(readRecord(s.root, 7) as ReviewRecord), posted });
    expect(finish(s, [at(5)], yes('f5')).rec.history).toEqual([posted]);
  });
  test('invalid judge verdicts, a gh failure and usage', () => {
    const s = setup();
    expect(finish(s, [at(5)], []).out).toEqual(['judge: not valid; run harness validate pr-judge first', 'verdicts: no verdict for "f5"']);
    const t = setup({}, (a) => (a === 'api user --jq .login' ? { status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' } : undefined));
    expect(finish(t, [at(5)], yes('f5'))).toMatchObject({ code: 1, out: ['review: gh api user failed (HTTP 401): gh: Bad credentials (HTTP 401)'] });
    expect(review(['--finish', s.dir], { root: s.root, env: {}, out: () => {} })).toBe(2);
  });
});

describe('review --keep', () => {
  test('logs the choice and names the record; a missing record is exit 1', () => {
    const s = setup();
    finish(s, [at(5)], yes('f5'));
    const out: string[] = [];
    expect(review(['--keep', '7'], { root: s.root, env: {}, out: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual(['Kept local: .harness/reviews/7.json']);
    expect(readEvents(s.root).at(-1)).toMatchObject({ check: 'review', decision: 'review-kept-local', reason: `pr 7 ${s.head.slice(0, 7)}` });
    const o2: string[] = [];
    expect(review(['--keep', '8'], { root: s.root, env: {}, out: (l) => o2.push(l) })).toBe(1);
    expect(o2).toEqual(['review: no review for PR #8; run the review first']);
    expect(review(['--keep', 'x'], { root: s.root, env: {}, out: () => {} })).toBe(2);
  });
});
