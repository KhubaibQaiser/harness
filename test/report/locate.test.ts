import { chmodSync, openSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeProjectDir as enc, insideRepo, locateSessions, projectsDir, repoPaths, type GitRun } from '../../src/report/locate.js';

const noGit: GitRun = () => ({ status: 1, stdout: '' });
let home: string;
let proj: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'loc-')));
  proj = join(home, '.claude/projects');
  mkdirSync(proj, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function put(folder: string, file: string, cwd: string | null, mtimeS?: number): string {
  const p = join(proj, folder, file);
  mkdirSync(join(p, '..'), { recursive: true });
  const lines = [JSON.stringify({ type: 'summary' }), JSON.stringify(cwd === null ? { type: 'x' } : { type: 'user', cwd })];
  writeFileSync(p, lines.join('\n') + '\n');
  if (mtimeS) utimesSync(p, mtimeS, mtimeS);
  return p;
}
const run = (root: string, extra: Partial<Parameters<typeof locateSessions>[1]> = {}) =>
  locateSessions(root, { env: {}, home, sinceMs: 0, git: noGit, ...extra });

describe('names', () => {
  it('projectsDir honours CLAUDE_CONFIG_DIR', () => {
    expect(projectsDir({ CLAUDE_CONFIG_DIR: '/x' }, '/h')).toBe('/x/projects');
    expect(projectsDir({}, '/h')).toBe('/h/.claude/projects');
  });
  it('encodes every non-alphanumeric as a dash', () => {
    expect(enc('/private/tmp/a-b/.c')).toBe('-private-tmp-a-b--c');
  });
  it('insideRepo is case-folded on darwin only', () => {
    expect(insideRepo('/Users/X/Repo', ['/Users/x/repo'], 'darwin')).toBe(true);
    expect(insideRepo('/Users/X/Repo', ['/Users/x/repo'], 'linux')).toBe(false);
    expect(insideRepo('/a/harness-old', ['/a/harness'], 'linux')).toBe(false);
    expect(insideRepo('/a/harness/src', ['/a/harness'], 'linux')).toBe(true);
  });
  it('repoPaths adds worktrees, raw and real, deduped', () => {
    const real = join(home, 'real');
    mkdirSync(real);
    const link = join(home, 'link');
    symlinkSync(real, link);
    const git: GitRun = () => ({ status: 0, stdout: `worktree ${link}\nHEAD abc\n\nworktree ${join(home, 'wt')}\nHEAD def\n` });
    expect(repoPaths(link, git).sort()).toEqual([join(home, 'wt'), link, real].sort());
  });
});

describe('locateSessions', () => {
  const root = '/a/harness';
  it('finds root and subfolder sessions', async () => {
    put(enc(root), 's1.jsonl', root);
    put(`${enc(root)}-src`, 's2.jsonl', `${root}/src`);
    const r = await run(root);
    expect(r.sessions.map((s) => s.session).sort()).toEqual(['s1', 's2']);
    expect(r.projectsDir).toBe(proj);
  });
  it('drops a prefix collision as outside-repo', async () => {
    put(enc('/a/harness-old'), 's.jsonl', '/a/harness-old');
    const r = await run(root);
    expect(r.sessions).toEqual([]);
    expect(r.skipped['outside-repo']).toBe(1);
  });
  it('O1: parent-folder session is never a candidate', async () => {
    put(enc('/a'), 's.jsonl', '/a');
    const r = await run(root);
    expect(r.sessions).toEqual([]);
    expect(r.skipped).toEqual({});
  });
  it('lists subagents, ignores meta files', async () => {
    put(enc(root), 's1.jsonl', root);
    put(enc(root), 's1/subagents/agent-a1.jsonl', root);
    put(enc(root), 's1/subagents/agent-a1.meta.json', root);
    put(enc(root), 's1/subagents/agent-a1.prefix.json', root);
    put(enc(root), 'custom-title.json', root);
    const r = await run(root);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.subagents).toEqual([join(proj, enc(root), 's1/subagents/agent-a1.jsonl')]);
  });
  it('skips unsafe ids, symlinks, old files (unopened) and no-cwd', async () => {
    put(enc(root), 'a b.jsonl', root);
    const target = put(enc(root), 'real.jsonl', root);
    symlinkSync(target, join(proj, enc(root), 'link.jsonl'));
    put(enc(root), 'old.jsonl', root, 1000);
    put(enc(root), 'nocwd.jsonl', null);
    const opened: string[] = [];
    const open = ((f: string, fl: string) => (opened.push(f), openSync(f, fl))) as typeof openSync;
    const r = await run(root, { sinceMs: 5_000_000, open });
    expect(opened.some((f) => f.endsWith('old.jsonl'))).toBe(false);
    expect(opened.some((f) => f.endsWith('nocwd.jsonl'))).toBe(true);
    expect(r.skipped).toMatchObject({ 'unsafe-id': 1, symlink: 1, 'older-than-window': 1, 'no-cwd': 1 });
    expect(r.skipped.unreadable).toBeUndefined();
  });
  it('root given as a symlink finds both folder spellings', async () => {
    const real = join(home, 'real');
    const link = join(home, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    put(enc(link), 'a.jsonl', link);
    put(enc(real), 'b.jsonl', real);
    const r = await run(link);
    expect(r.sessions.map((s) => s.session).sort()).toEqual(['a', 'b']);
  });
  it('matches a worktree path', async () => {
    const git: GitRun = () => ({ status: 0, stdout: 'worktree /w/tree\n' });
    put(enc('/w/tree'), 'w.jsonl', '/w/tree');
    expect((await run(root, { git })).sessions.map((s) => s.session)).toEqual(['w']);
  });
  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('counts an unreadable folder', async () => {
    put(enc(root), 's.jsonl', root);
    const d = join(proj, enc(root));
    chmodSync(d, 0);
    try {
      expect((await run(root)).skipped.unreadable).toBe(1);
    } finally {
      chmodSync(d, 0o700);
    }
  });
  it('uses CLAUDE_CONFIG_DIR and tolerates a missing projects dir', async () => {
    expect((await run(root, { env: { CLAUDE_CONFIG_DIR: join(home, 'none') } })).sessions).toEqual([]);
  });
});
