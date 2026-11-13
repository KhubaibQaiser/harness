import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultExecBytes, type ExecBytes } from '../../src/core/exec.js';
import { SAFE_GIT } from '../../src/core/git-safe.js';
import { BASE_PATHS, baseBlobs, driftCheck } from '../../src/review/base.js';
import { commit, git, repoWith } from './repo.js';

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

const commits = (root: string, ...shas: string[]) => shas.map((sha) => ({ sha, blobs: baseBlobs(defaultExecBytes, root, sha) }));
const check = (root: string, ...shas: string[]) => driftCheck(root, defaultExecBytes, 'main', commits(root, ...shas));
const err = (d: ReturnType<typeof check>) => ('error' in d ? d.error : null);

describe('driftCheck', () => {
  const drift = (edit: (root: string) => void) => {
    const r = repoWith(BASE, { 'src/a.ts': 'a\n' });
    edit(r.root);
    return err(check(r.root, r.base));
  };
  test('equal trees: the trusted text is the base commit\'s', () => {
    const r = repoWith(BASE, { 'src/a.ts': 'a\n' });
    expect(check(r.root, r.base)).toEqual({ blobs: baseBlobs(defaultExecBytes, r.root, r.base) });
  });
  test('an edited agent names the file and the base branch', () => {
    const r = repoWith(BASE, {});
    writeFileSync(join(r.root, AGENT), 'agent edited\n');
    expect(err(check(r.root, r.base))).toBe(`review: ${AGENT} differs from main (${r.base.slice(0, 7)}); run the review from main or a clean worktree of it`);
  });
  test('the PR branch checked out (head commit changed the rubric) is drift', () => {
    const r = repoWith(BASE, {});
    commit(r.root, { '.claude/skills/review-rubric/SKILL.md': 'rubric from the PR\n' });
    expect(err(check(r.root, r.base))).toMatch(/^review: \.claude\/skills\/review-rubric\/SKILL\.md differs from main /);
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

  // Git for Windows checks out with core.autocrlf=true: CRLF on disk is the same file, compared through git's own normalization.
  test('CRLF line endings from autocrlf are not drift; a real change in CRLF still is', () => {
    const r = repoWith(BASE, {});
    git(r.root, 'config', 'core.autocrlf', 'true');
    writeFileSync(join(r.root, AGENT), 'agent v1\r\n');
    writeFileSync(join(r.root, '.harness/hooks/dispatch.mjs'), 'x\r\n');
    expect(err(check(r.root, r.base))).toBeNull();
    writeFileSync(join(r.root, AGENT), 'agent from the PR\r\n');
    expect(err(check(r.root, r.base))).toMatch(/^review: \.claude\/agents\/staff-reviewer\.md differs from main /);
    writeFileSync(join(r.root, AGENT), 'agent v1\r\n');
    writeFileSync(join(r.root, '.harness/hooks/dispatch.mjs'), 'y\r\n');
    expect(err(check(r.root, r.base))).toMatch(/^review: \.harness\/hooks\/dispatch\.mjs differs/);
  });
  test('a .gitattributes eol=crlf checkout is not drift', () => {
    const r = repoWith({ ...BASE, '.gitattributes': '*.md text eol=crlf\n' }, {});
    writeFileSync(join(r.root, AGENT), 'agent v1\r\n');
    expect(err(check(r.root, r.base))).toBeNull();
  });

  // The base branch moved past the PR's base commit: a checkout of its tip is a base-branch commit too.
  describe('base commit or the base branch tip', () => {
    const moved = () => {
      const r = repoWith(BASE, { 'src/a.ts': 'a\n' });
      const tip = commit(r.root, { [AGENT]: 'agent v2 on main\n', '.harness/hooks/dispatch.mjs': 'd2\n', 'AGENTS.md': 'newer\n' });
      return { ...r, tip };
    };
    test('a working tree equal to the tip is accepted, and the agent text comes from the tip', () => {
      const r = moved();
      const d = check(r.root, r.base, r.tip);
      expect(err(d)).toBeNull();
      expect('blobs' in d && d.blobs[AGENT]).toBe('agent v2 on main\n');
      expect('blobs' in d && d.blobs['AGENTS.md']).toBeNull(); // not drift-checked: from the base commit, where it is absent
    });
    test('a working tree equal to the base commit is accepted against both', () => {
      const r = moved();
      writeFileSync(join(r.root, AGENT), 'agent v1\n');
      writeFileSync(join(r.root, '.harness/hooks/dispatch.mjs'), 'x\n');
      const d = check(r.root, r.base, r.tip);
      expect('blobs' in d && d.blobs[AGENT]).toBe('agent v1\n');
    });
    test('a working tree matching neither names both commits', () => {
      const r = moved();
      writeFileSync(join(r.root, AGENT), 'from the PR\n');
      expect(err(check(r.root, r.base, r.tip))).toBe(`review: ${AGENT} differs from main (${r.base.slice(0, 7)} and ${r.tip.slice(0, 7)}); run the review from main or a clean worktree of it`);
    });
  });
});
