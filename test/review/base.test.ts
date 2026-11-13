import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultExecBytes, type ExecBytes } from '../../src/core/exec.js';
import { SAFE_GIT } from '../../src/core/git-safe.js';
import { BASE_PATHS, baseBlobs, driftCheck } from '../../src/review/base.js';
import { commit, repoWith } from './repo.js';

const AGENT = '.claude/agents/staff-reviewer.md';
const SETTINGS = (hooks: unknown, permissions: unknown = {}) => JSON.stringify({ hooks, permissions });
const BASE = { '.harness/config.yaml': 'version: 1\n', [AGENT]: 'agent v1\n', '.claude/settings.json': SETTINGS({ Stop: [1] }, { deny: ['a'] }), '.harness/hooks/dispatch.mjs': 'x\n' };

describe('baseBlobs', () => {
  test('reads constant paths from base; a missing blob is null', () => {
    const r = repoWith(BASE, { [AGENT]: 'agent from the PR\n' });
    const b = baseBlobs(defaultExecBytes, r.root, r.base);
    expect(Object.keys(b)).toEqual(BASE_PATHS);
    expect(b['.harness/config.yaml']).toBe('version: 1\n');
    expect(b[AGENT]).toBe('agent v1\n');
    expect(b['AGENTS.md']).toBeNull();
  });
  test('spawns git with the SAFE_GIT prefix, and never checkout, worktree or archive', () => {
    const r = repoWith(BASE, {});
    const calls: string[][] = [];
    const rec: ExecBytes = (c, a, m, i) => (calls.push([c, ...a]), defaultExecBytes(c, a, m, i));
    baseBlobs(rec, r.root, r.base);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c[0]).toBe('git');
      expect(c.slice(1, 1 + SAFE_GIT.length)).toEqual(SAFE_GIT);
      expect(c.some((a) => ['checkout', 'worktree', 'archive'].includes(a))).toBe(false);
    }
  });
});

describe('driftCheck', () => {
  const drift = (edit: (root: string) => void) => {
    const r = repoWith(BASE, { 'src/a.ts': 'a\n' });
    edit(r.root);
    return driftCheck(r.root, defaultExecBytes, r.base, baseBlobs(defaultExecBytes, r.root, r.base));
  };
  test('equal trees', () => {
    expect(drift(() => {})).toBeNull();
  });
  test('an edited agent names the file and the base', () => {
    const r = repoWith(BASE, {});
    writeFileSync(join(r.root, AGENT), 'agent edited\n');
    expect(driftCheck(r.root, defaultExecBytes, r.base, baseBlobs(defaultExecBytes, r.root, r.base)))
      .toBe(`review: ${AGENT} differs from ${r.base.slice(0, 7)}; run the review from ${r.base.slice(0, 7)} or a clean worktree of it`);
  });
  test('the PR branch checked out (head commit changed the agent) is drift', () => {
    const r = repoWith(BASE, {});
    const head = commit(r.root, { '.claude/skills/review-rubric/SKILL.md': 'rubric from the PR\n' });
    expect(head).toBeTruthy();
    expect(driftCheck(r.root, defaultExecBytes, r.base, baseBlobs(defaultExecBytes, r.root, r.base))).toMatch(/^review: \.claude\/skills\/review-rubric\/SKILL\.md differs from /);
  });
  test('settings.json: hooks count, permissions do not', () => {
    expect(drift((root) => writeFileSync(join(root, '.claude/settings.json'), SETTINGS({ Stop: [] }, { deny: ['a'] })))).toMatch(/^review: \.claude\/settings\.json differs/);
    expect(drift((root) => writeFileSync(join(root, '.claude/settings.json'), SETTINGS({ Stop: [1] }, { deny: ['b'] })))).toBeNull();
  });
  test('every file under .harness/hooks/: edited, added or removed', () => {
    expect(drift((root) => writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), 'y\n'))).toMatch(/^review: \.harness\/hooks\/dispatch\.mjs differs/);
    expect(drift((root) => { mkdirSync(join(root, '.harness/hooks/sub'), { recursive: true }); writeFileSync(join(root, '.harness/hooks/sub/extra.cjs'), 'z\n'); })).toMatch(/^review: \.harness\/hooks\/sub\/extra\.cjs differs/);
  });
  test('missing on one side is a difference', () => {
    expect(drift((root) => { mkdirSync(join(root, '.claude/agents'), { recursive: true }); writeFileSync(join(root, '.claude/agents/review-judge.md'), 'j\n'); })).toMatch(/review-judge\.md differs/);
  });
});
