import { describe, expect, test } from 'vitest';
import { runnerName, type Seg, walkCommands, type Where } from '../../src/checks/guard.js';
import { makeRepo } from '../install/helpers.js';

const w: Where = { root: '/nonexistent-harness-root', env: {} };
const record = (command: string, where: Where = w) => {
  const seen: string[] = [];
  walkCommands(command, where, (seg) => (seen.push(seg.toks.slice(seg.k).join(' ')), null));
  return seen;
};

describe('walkCommands', () => {
  test('visits every segment of a chain', () => {
    expect(record('a && b | c; d')).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
  });

  test('walks -c payloads and programs piped to a shell', () => {
    expect(record('bash -c "gh pr create"')).toContain('gh pr create');
    expect(record("echo 'gh pr create' | sh")).toContain('gh pr create');
  });

  test('finds the command past wrappers', () => {
    const segs: Seg[] = [];
    walkCommands('timeout 60 env X=1 /usr/local/bin/gh pr create', w, (s) => (segs.push(s), null));
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) expect(s.toks[s.k]).toBe('/usr/local/bin/gh');
  });

  test('walks package scripts and hands each body to the script hook', () => {
    const root = makeRepo({ 'package.json': JSON.stringify({ scripts: { ship: 'gh pr create --fill' } }) }, { git: false });
    const seen: string[] = [];
    const bodies: string[] = [];
    walkCommands('npm run ship', { root, env: {} }, (seg) => (seen.push(seg.toks.slice(seg.k).join(' ')), null), {
      script: (b) => (bodies.push(b), null),
    });
    expect(seen).toContain('gh pr create --fill');
    expect(bodies.map((b) => b.trim())).toContain('gh pr create --fill');
  });

  test('a substituted command name leaves the rest at k 0 after the )', () => {
    const segs: Seg[] = [];
    walkCommands('$(which gh) pr create', w, (s) => (segs.push(s), null));
    const s = segs.find((x) => x.toks.join(' ') === 'pr create');
    expect(s).toBeDefined();
    expect(s!.k).toBe(0);
    expect(s!.prev).toBe(')');
  });

  test('whole gets every word of each reading before any visit', () => {
    const log: string[] = [];
    walkCommands('a && b', w, (s) => (log.push(`visit:${s.toks.join(' ')}`), null), { whole: (words) => (log.push(`whole:${words.join(' ')}`), null) });
    expect(log[0]).toBe('whole:a && b');
    expect(log.indexOf('visit:a')).toBeGreaterThan(0);
    for (let i = 0; i < log.length; i++) if (log[i].startsWith('whole:')) expect(log[i + 1]).toMatch(/^visit:/);
  });

  test('the first non-null result wins and nothing after it is visited', () => {
    const seen: string[] = [];
    const r = walkCommands('a; b; c', w, (s) => (seen.push(s.toks.join(' ')), s.toks[0] === 'b' ? 'hit' : null));
    expect(r).toBe('hit');
    expect(seen).toEqual(['a', 'b']);
  });

  test('a whole result stops the walk before any visit', () => {
    const seen: string[] = [];
    expect(walkCommands('a; b', w, (s) => (seen.push(s.toks.join(' ')), null), { whole: () => 'stop' })).toBe('stop');
    expect(seen).toEqual([]);
  });
});

test('runnerName strips the path, the Windows extension and the case', () => {
  expect(runnerName('C:/x/gh.exe')).toBe('gh');
});
