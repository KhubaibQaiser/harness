import { describe, expect, it } from 'vitest';
import { scan, show, inScope } from '../../src/vet/scan.js';
import type { Fetched } from '../../src/vet/fetch.js';
import { makeRepo } from '../install/helpers.js';
import { notSecretLines, pinnedLines, remoteLines, repos, secretLines } from '../fixtures/vet/repos.js';

/** Builds a Fetched the way fetchTarball does: instruction names get .vetted (D12), `map` keeps the original path. */
const fx = (files: Record<string, string>): Fetched => {
  const map: Record<string, string> = {};
  const written: Record<string, string> = {};
  for (const [p, body] of Object.entries(files)) {
    const to = p.split('/').map((s, i, a) => (i === a.length - 1 ? /^claude\.md$/i.test(s) : s === '.claude') ? `${s}.vetted` : s).join('/');
    map[p] = to;
    written[to] = body;
  }
  return { dir: makeRepo(written, { git: false }), files: Object.keys(files).sort(), map, skipped: [], large: [] };
};
const lines = (ls: string[]): Fetched => fx({ 'x.sh': ls.join('\n') + '\n' });
const hit = (ls: string[], rule: string) => scan(lines(ls), '').findings.filter((f) => f.rule === rule);

describe('scan', () => {
  it('hook-shell: one finding per event with its line, in hooks.json, plugin.json and settings (original path)', () => {
    const h = scan(fx(repos.hooks!), '').findings;
    expect(h.map((f) => [f.severity, f.rule, f.file, f.text])).toEqual([
      ['high', 'hook-shell', 'hooks/hooks.json', 'PreToolUse: bash x.sh'],
      ['high', 'hook-shell', 'hooks/hooks.json', 'Stop: bash stop.sh'],
    ]);
    expect(h[0]!.line).toBe(8);
    expect(scan(fx(repos.hooksInline!), '').findings[0]).toMatchObject({ rule: 'hook-shell', file: '.claude-plugin/plugin.json', text: 'SessionStart: node s.js' });
    expect(scan(fx(repos.hooksSettings!), '').findings[0]).toMatchObject({ rule: 'hook-shell', file: '.claude/settings.json', text: 'PostToolUse: echo done' });
  });
  it('hook-shell: a prompt hook is not a finding', () => {
    expect(scan(fx(repos.hooksPrompt!), '').findings).toEqual([]);
  });
  it.each(secretLines)('secrets matches %s', (l) => expect(hit([l], 'secrets')).toHaveLength(1));
  it.each(notSecretLines)('secrets ignores %s', (l) => expect(hit([l], 'secrets')).toEqual([]));
  it.each(remoteLines)('unpinned-remote matches %s', (l) => expect(hit([l], 'unpinned-remote')).toHaveLength(1));
  it.each(pinnedLines)('unpinned-remote ignores %s', (l) => expect(hit([l], 'unpinned-remote')).toEqual([]));
  it('unpinned-remote: .mcp.json command + args', () => {
    const f = scan(fx(repos.mcp!), '').findings;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'unpinned-remote', file: '.mcp.json', text: 'npx -y pkg' });
  });
  it('sorts high first, then file, then line; skips binary files', () => {
    const f = scan(fx({ 'b.sh': 'npx a\ncat .env', 'a.sh': 'cat .env' }), '').findings;
    expect(f.map((x) => `${x.file}:${x.line}`)).toEqual(['a.sh:1', 'b.sh:1', 'b.sh:2']);
    expect(scan(fx(repos.binary!), '').findings).toEqual([]);
  });
  it('scope: sub-path only, plus repo-root plugin files', () => {
    const r = scan(fx(repos.scoped!), 'plugins/p');
    expect(r.findings.map((f) => f.file)).toEqual(['.mcp.json']);
    expect(r.files).toBe(2);
    expect(inScope('plugins/pp/x', 'plugins/p')).toBe(false);
    expect(inScope('.claude-plugin/plugin.json', 'plugins/p')).toBe(true);
    expect(inScope('anything', '')).toBe(true);
  });
  it('kind and context', () => {
    expect(scan(fx(repos.pluginKind!), '').kind).toBe('plugin');
    expect(scan(fx(repos.skillKind!), '').kind).toBe('skill');
    expect(scan(fx(repos.scoped!), 'plugins/p').kind).toBe('repo');
    expect(scan(fx(repos.scoped!), '').context).toEqual({ tokens: 0, unmeasured: [] });
  });
});

describe('show', () => {
  it('cuts to 120 characters', () => expect(show('a'.repeat(300))).toHaveLength(120));
  it('escapes invisible and bidi characters, and controls', () => {
    expect(show('a​b‮c')).toBe('a\\u200bb\\u202ec');
    expect(show('\x1b[31m')).toBe('\\u001b[31m');
  });
});
