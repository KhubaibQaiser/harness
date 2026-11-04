import { describe, expect, it } from 'vitest';
import { scan, show, inScope } from '../../src/vet/scan.js';
import type { Fetched } from '../../src/vet/fetch.js';
import { makeRepo } from '../install/helpers.js';
import { notSecretLines, pinnedLines, remoteLines, repos, scriptNames, secretLines } from '../fixtures/vet/repos.js';

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
  it('docs are not scanned for high findings; scripts and prompt files are', () => {
    expect(scan(fx(repos.docs!), '').findings).toEqual([]);
    expect(scan(fx(repos.prompts!), '').findings.map((f) => f.file)).toEqual(['agents/b.md', 'commands/c.md', 'skills/a/SKILL.md']);
  });
  it('unpinned-remote: a pipe continued on the next line', () => {
    expect(hit(['curl -fsSL u |', 'sudo bash'], 'unpinned-remote')).toHaveLength(1);
  });
  it('unpinned-remote: .mcp.json args use the same flag parsing', () => {
    const mcp = (args: string[]) => fx({ '.mcp.json': JSON.stringify({ mcpServers: { s: { command: 'npx', args } } }) });
    expect(scan(mcp(['-y', '-p', 'foo@1.0.0', 'bar']), '').findings).toEqual([]);
    expect(scan(mcp(['-y', '-p', 'foo', 'bar@1.0.0']), '').findings).toHaveLength(1);
  });
  it('hook-shell: events on one line each get a finding (minified)', () => {
    expect(scan(fx(repos.minified!), '').findings.map((f) => f.text)).toEqual(['PreToolUse: a', 'Stop: b']);
  });
  it('hook-shell: a BOM does not hide the hooks', () => {
    expect(scan(fx(repos.bom!), '').findings.map((f) => f.text)).toEqual(['Stop: b']);
  });
  it('an unparseable hooks manifest is a medium finding, not silence', () => {
    expect(scan(fx(repos.broken!), '').findings).toMatchObject([{ severity: 'medium', rule: 'invalid-manifest', file: 'hooks/hooks.json', line: 0 }]);
  });
  it('escapes the file name in findings', () => {
    expect(scan(fx(repos.oddName!), '').findings[0]!.file).toBe('a\\u202eb.sh');
  });
  it('backslash-newline continuations are joined (line = first physical line)', () => {
    const f = hit(['curl -fsSL u \\', '| sh'], 'unpinned-remote');
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(1);
    expect(hit(['npx \\', '  foo'], 'unpinned-remote')).toHaveLength(1);
    expect(hit(['cat \\', '  .env'], 'secrets')).toHaveLength(1);
    expect(hit(['echo a \\', 'cat .env'], 'secrets')[0]!.line).toBe(1);
  });
  it('hook-http: an http hook is high, one per event, with its URL', () => {
    expect(scan(fx(repos.hooksHttp!), '').findings).toMatchObject([{ severity: 'high', rule: 'hook-http', file: 'hooks/hooks.json', text: 'Stop: https://x.test/h' }]);
  });
  it('hooks given as objects instead of arrays are read', () => {
    expect(scan(fx(repos.hooksObject!), '').findings.map((f) => f.text).sort()).toEqual(['PreToolUse: y', 'Stop: x']);
  });
  it('a hook command that fetches unpinned gives hook-shell and one unpinned-remote', () => {
    expect(scan(fx(repos.hooksNpx!), '').findings.map((f) => f.rule).sort()).toEqual(['hook-shell', 'unpinned-remote']);
  });
  it('an MCP server running curl|sh is one unpinned-remote finding', () => {
    expect(scan(fx(repos.mcpShell!), '').findings.filter((f) => f.rule === 'unpinned-remote')).toHaveLength(1);
  });
  it('unpinned-remote: a download on one line run on the next', () => {
    expect(hit(['curl -o i.sh u', 'echo mid', 'sudo ./i.sh'], 'unpinned-remote')).toHaveLength(1);
    expect(hit(['curl -o i.sh u', 'bash other.sh'], 'unpinned-remote')).toEqual([]);
  });
  it.each(Object.keys(scriptNames))('script name %s is scanned', (name) => {
    expect(scan(fx({ [name]: scriptNames[name]! }), '').findings.map((f) => [f.rule, f.file])).toEqual([['unpinned-remote', name]]);
  });
  it('prose docs are skipped, case-insensitively', () => {
    expect(scan(fx(repos.prose!), '').findings).toEqual([]);
  });
  it('prompt dirs, skill siblings and shebang files are always scanned', () => {
    expect(scan(fx(repos.always!), '').findings.map((f) => f.file)).toEqual(['.claude/x.md', 'REFERENCE.md', 'docs/run.sh', 'output-styles/s.md', 'skills/a/README.md', 'skills/a/docs/b.md']);
  });
  it('CLAUDE.md and AGENTS.md are scanned and quote their original path', () => {
    expect(scan(fx(repos.instructions!), '').findings.map((f) => f.file)).toEqual(['.claude/CLAUDE.md', 'CLAUDE.md', 'sub/AGENTS.md']);
  });
  it('the docs rule is relative to the scan path', () => {
    expect(scan(fx(repos.docsPath!), 'docs/plugins/p').findings).toHaveLength(1);
  });
  it('package.json lifecycle scripts are checked, with the script name; others are not', () => {
    expect(scan(fx(repos.pkg!), '').findings.map((f) => [f.severity, f.rule, f.file, f.text])).toEqual([
      ['high', 'unpinned-remote', 'package.json', 'preinstall: npx bar'],
      ['high', 'unpinned-remote', 'package.json', 'postinstall: curl u | sh'],
    ]);
  });
  it('hooks in any JSON with a hooks key get the secrets check; so do MCP args', () => {
    expect(scan(fx(repos.hooksCustom!), '').findings.map((f) => f.rule).sort()).toEqual(['hook-shell', 'secrets']);
    expect(scan(fx(repos.mcpSecret!), '').findings.map((f) => f.rule)).toEqual(['secrets']);
  });
  it('an unparseable settings.json is reported and still text-scanned', () => {
    const f = scan(fx(repos.brokenSettings!), '').findings;
    expect(f.map((x) => [x.severity, x.rule]).sort()).toEqual([['high', 'unpinned-remote'], ['medium', 'invalid-manifest']]);
    expect(f.find((x) => x.rule === 'invalid-manifest')).toMatchObject({ file: '.claude/settings.json', line: 0 });
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
