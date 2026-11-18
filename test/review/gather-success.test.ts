import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { gatherHash, type GatherJson } from '../../src/review/gather.js';
import { git } from './repo.js';
import { TOKEN, setup, fakeGh, run } from './gather-helpers.js';

describe('gather: success', () => {
  let s: ReturnType<typeof setup>, r: ReturnType<typeof run>, g: GatherJson, md: string;
  beforeAll(() => {
    s = setup();
    r = run(s, fakeGh(s, { title: 'Title \u001b[2J', body: 'See docs/spec.md, secret body text.' }).exec);
    expect(r.lines.join('\n')).toMatch(/^Gathered/);
    g = JSON.parse(r.read('gather.json')) as GatherJson;
    md = r.read('context.md');
  });

  test('prints the summary line and exits 0', () => {
    expect(r.lines).toEqual([`Gathered PR #7 at ${s.head.slice(0, 7)}: 2 files, 3 diff lines, 1 omitted.`]);
    expect(r.code).toBe(0);
  });
  test('gather.json', () => {
    expect(g).toMatchObject({ repo: 'o/r', pr: 7, base: 'main', base_sha: s.base, head_sha: s.head, merge_base: s.base, fork: null, labels: [], body_template: false });
    expect(g.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(g.omitted).toEqual([{ path: 'pnpm-lock.yaml', why: 'excluded by pr_size.exclude' }]);
    expect(g.files.find((f) => f.path === 'pnpm-lock.yaml')).toMatchObject({ skipped: true });
    expect(g.lines['src/a.ts']).toEqual({ RIGHT: [1, 2], LEFT: [] });
  });
  test('context.md: trusted base texts, a referenced spec, no raw control character, secrets redacted', () => {
    expect(md).toContain('RUBRIC TEXT');
    expect(md).toContain('AGENTS TEXT');
    expect(md).toContain(`:spec:docs/spec.md>>>\nSPEC TEXT`);
    expect(md).toContain('inline note');
    expect(md).toContain('#3 Issue');
    expect(md.replace(/[\n\t]/g, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(md).toContain('[redacted]');
    expect(md).not.toContain(TOKEN);
  });
  test('the head snapshot', () => {
    expect(readFileSync(join(s.root, s.dir, 'head/src/a.ts.pr-snapshot'), 'utf8')).toContain(TOKEN.slice(0, 4)); // the snapshot is the file; only context text is redacted
    expect(g.map['src/a.ts']).toBe('src/a.ts.pr-snapshot');
    expect(md).toContain('head/<path>.pr-snapshot');
  });
  test('the event holds counts, never PR text', () => {
    const e = readEvents(s.root).filter((x) => x.check === 'review');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ session: 'cli', decision: 'review-gathered', reason: `pr 7 ${s.head.slice(0, 7)} files 2 lines 3 omitted 1` });
    expect(JSON.stringify(e)).not.toMatch(/Title|secret body/);
  });
  test('Review Focus 1: one changed byte of gather.json is refused', () => {
    expect(gatherHash(s.root, s.dir)).toBe('ok');
    const p = join(s.root, s.dir, 'gather.json');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"pr": 7', '"pr": 8'));
    expect(gatherHash(s.root, s.dir)).toBe(`review: ${s.dir}/gather.json changed since gather; run the review again`);
  });
});

describe('gather: where it runs from', () => {
  test('a fork workflow fetches from the remote that is the repo (upstream), not origin', () => {
    const s = setup({ fork: true });
    expect(run(s, fakeGh(s).exec).code).toBe(0);
  });
  test('main moved past the base commit: a checkout of the tip is accepted and its rubric is used', () => {
    const s = setup({ tip: { '.claude/skills/review-rubric/SKILL.md': 'RUBRIC ON MAIN\n' } });
    const r = run(s, fakeGh(s).exec);
    expect(r.code, r.lines.join('\n')).toBe(0);
    expect(r.read('context.md')).toContain('RUBRIC ON MAIN');
    expect((JSON.parse(r.read('gather.json')) as GatherJson).base_sha).toBe(s.base);
  });
  test('a working tree matching neither the base commit nor the tip is drift', () => {
    const s = setup({ tip: { '.claude/skills/review-rubric/SKILL.md': 'RUBRIC ON MAIN\n' } });
    writeFileSync(join(s.root, '.claude/skills/review-rubric/SKILL.md'), 'rubric from the PR\n');
    expect(run(s, fakeGh(s).exec)).toMatchObject({ code: 1, lines: [`review: .claude/skills/review-rubric/SKILL.md differs from main (${s.base.slice(0, 7)} and ${s.tip.slice(0, 7)}); run the review from main or a clean worktree of it`] });
  });
  test('a session on the PR checkout is refused', () => {
    const s = setup();
    git(s.root, 'fetch', '-q', 'origin', 'refs/pull/7/head');
    git(s.root, 'checkout', '-q', 'FETCH_HEAD');
    expect(run(s, fakeGh(s).exec)).toMatchObject({ code: 1, lines: ['review: this checkout is not main or behind it (is it the PR branch?). Switch to main and start a fresh Claude Code session: this one may already have loaded the PR\'s CLAUDE.md, hooks or .mcp.json.'] });
  });
});
