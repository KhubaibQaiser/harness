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
    expect(projectsDir({ CLAUDE_CONFIG_DIR: '/x' }, '/h')).toBe(join('/x', 'projects'));
    expect(projectsDir({}, '/h')).toBe(join('/h', '.claude', 'projects'));
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
  it('does not follow a symlinked project folder', async () => {
    put('other', 's.jsonl', root);
    symlinkSync(join(proj, 'other'), join(proj, enc(root)));
    const r = await run(root);
    expect(r.sessions).toEqual([]);
    expect(r.skipped.symlink).toBe(1);
  });
  it('matches a case-folded folder only on darwin, through locateSessions', async () => {
    const lower = '/Users/x/repo';
    put(enc('/Users/X/Repo'), 's.jsonl', '/Users/X/Repo');
    expect((await run(lower, { platform: 'darwin' })).sessions).toHaveLength(1);
    expect((await run(lower, { platform: 'linux' })).sessions).toHaveLength(0);
  });
  it('fails closed on a cwd with .. or a relative cwd', async () => {
    put(enc(root), 'dots.jsonl', `${root}/../other`);
    put(enc(root), 'rel.jsonl', 'src');
    const r = await run(root);
    expect(r.sessions).toEqual([]);
    expect(r.skipped['outside-repo']).toBe(2);
  });
  it.skipIf(process.platform === 'win32')('does not follow symlinked subagent paths and counts them', async () => {
    // <id> dir is a link into another project's folder
    put('other', 'victim/subagents/agent-v.jsonl', root);
    put(enc(root), 'a.jsonl', root);
    symlinkSync(join(proj, 'other/victim'), join(proj, enc(root), 'a'));
    // subagents dir is a link
    put(enc(root), 'b.jsonl', root);
    put('other', 'subs/agent-s.jsonl', root);
    mkdirSync(join(proj, enc(root), 'b'));
    symlinkSync(join(proj, 'other/subs'), join(proj, enc(root), 'b/subagents'));
    // a subagent file is a link
    put(enc(root), 'c.jsonl', root);
    put(enc(root), 'c/subagents/agent-real.jsonl', root);
    symlinkSync(join(proj, 'other/subs/agent-s.jsonl'), join(proj, enc(root), 'c/subagents/agent-link.jsonl'));
    const r = await run(root);
    const by = Object.fromEntries(r.sessions.map((x) => [x.session, x.subagents.map((p) => p.split('/').pop())]));
    expect(by).toEqual({ a: [], b: [], c: ['agent-real.jsonl'] });
    expect(r.skipped.symlink).toBe(3);
  });
  it('counts an unreadable file at open', async () => {
    put(enc(root), 's.jsonl', root);
    const open = (() => { throw new Error('EACCES'); }) as unknown as typeof openSync;
    expect((await run(root, { open })).skipped.unreadable).toBe(1);
  });
  it('bounds a listing and counts truncation', async () => {
    for (const i of [1, 2, 3]) put(enc(root), `s${i}.jsonl`, root);
    const r = await run(root, { maxEntries: 2 });
    expect(r.sessions.length).toBeLessThanOrEqual(2);
    expect(r.skipped.truncated).toBe(1);
  });
  it('uses CLAUDE_CONFIG_DIR and tolerates a missing projects dir', async () => {
    expect((await run(root, { env: { CLAUDE_CONFIG_DIR: join(home, 'none') } })).sessions).toEqual([]);
  });
});

it('a filesystem root as the repo matches no session', async () => {
  const { insideRepo } = await import('../../src/report/locate.js');
  expect(insideRepo('/home/u/proj', ['/'], 'linux')).toBe(false);
  expect(insideRepo('C:\\proj', ['C:\\'], 'win32')).toBe(false);
  expect(insideRepo('/home/u/proj/src', ['/home/u/proj'], 'linux')).toBe(true);
});
