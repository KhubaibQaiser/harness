import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it, test } from 'vitest';
import { BETA_GROUPS, betaSettings } from './helpers.js';
import { MergeError, mergeAgents, mergeAgentsPreset, mergePresetSettings, presetSets, PRESET_END, PRESET_START, mergeClaudeMd, mergeEslintFlatIgnores, mergeGitignore, mergeIgnoreFile, mergeSettings, mergeMcp, pinnedPlugins, removeBlocks, removeFromMcp, removeFromSettings, STRUCTURAL } from '../../src/install/merge.js';
import { TELEMETRY_ENV, type LoadedPreset } from '../../src/catalog/presets.js';
import { guardedView } from '../../src/core/harness-files.js';

const fx = (p: string) => readFileSync(`test/fixtures/install-repo/${p}`, 'utf8');
const ARGS = ['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs'];
const PRE = 'Bash|PowerShell|Monitor|Read|Grep|Edit|Write|MultiEdit|NotebookEdit';
const merge = (before: string | null, recorded?: string[]) => mergeSettings(before, { sandbox: 'unattended', recorded });
const frag = JSON.parse(readFileSync('templates/settings.fragment.json', 'utf8'));
const S = '<!-- harness:start -->';
const E = '<!-- harness:end -->';

describe('mergeSettings', () => {
  it('fixture: other tools hooks kept, dispatcher + deny added, rest kept', () => {
    const before = fx('.claude/settings.json');
    const { after, blocks, notes } = merge(before);
    const s = JSON.parse(after);
    expect(after.endsWith('}\n')).toBe(true);
    expect(notes).toEqual([]);
    expect(s.model).toBe('sonnet');
    expect(s.env).toEqual({ FOO: 'bar' });
    expect(s.permissions.allow).toEqual(['Bash(pnpm test:*)']);
    expect(s.permissions.deny.slice(0, 2)).toEqual(['Read(./secrets/**)', 'Read(./.env)']);
    expect(s.permissions.deny).toContain('Edit(./.claude/settings.json)');
    expect(s.permissions.deny.filter((x: string) => x === 'Read(./.env)')).toHaveLength(1);
    expect(after).toContain('scripts/agent-hooks/guard.mjs');
    expect(s.hooks.PreToolUse.map((g: any) => g.matcher)).toEqual(['Bash', 'Write', PRE, 'AskUserQuestion']);
    expect(s.hooks.PostToolUse).toHaveLength(3);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[1].hooks[0].args).toEqual(ARGS);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    // blocks: 8 hook groups (AskUserQuestion has its own Pre and Post group) + deny rules not already present (29 of 30)
    const parsed = blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.event)).toHaveLength(8);
    expect(parsed.filter((b) => b.deny)).toHaveLength(29);
    expect(parsed.find((b) => b.event === 'Stop').group.hooks[0].args).toEqual(ARGS);
  });

  it('null input creates a settings file', () => {
    const { after } = merge(null);
    expect(JSON.parse(after).hooks.Stop).toHaveLength(1);
    expect(after.endsWith('}\n')).toBe(true);
  });

  it('second run: unchanged, no blocks', () => {
    const first = merge(fx('.claude/settings.json')).after;
    const again = merge(first);
    expect(again.after).toBe(first);
    expect(again.blocks).toEqual([]);
  });

  it('a fresh file gets 8 group blocks and 30 deny blocks, nothing dropped', () => {
    const { after, blocks, dropped } = merge(null);
    const parsed = blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.event)).toHaveLength(8);
    expect(parsed.filter((b) => b.deny)).toHaveLength(30);
    expect(dropped).toEqual([]);
    expect(JSON.parse(after).hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'node', args: ARGS, timeout: 600 });
  });

  it('a foreign node exec hook survives init, update and uninstall', () => {
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['tools/lint-hook.mjs'] }] };
    const { after, blocks } = merge(JSON.stringify({ hooks: { PreToolUse: [foreign] } }));
    const s = JSON.parse(after);
    expect(s.hooks.PreToolUse).toEqual([foreign, ...frag.hooks.PreToolUse]);
    expect(blocks).toContain(JSON.stringify({ event: 'PreToolUse', group: frag.hooks.PreToolUse[0] }));
  });

  it('beta groups are replaced in place', () => {
    const user = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
    const beta = betaSettings({ hooks: { PreToolUse: [user] } });
    const { after, blocks, dropped, notes } = merge(JSON.stringify(beta.s, null, 2) + '\n', beta.blocks);
    const s = JSON.parse(after);
    expect(notes).toEqual([]);
    expect(s.hooks.PreToolUse).toEqual([user, ...frag.hooks.PreToolUse]);
    for (const ev of Object.keys(frag.hooks)) expect(s.hooks[ev].slice(-frag.hooks[ev].length)).toEqual(frag.hooks[ev]);
    for (const ev of ['UserPromptSubmit', 'ConfigChange', 'Stop', 'SessionEnd']) expect(s.hooks[ev]).toHaveLength(1);
    expect(s.hooks.PostToolUse).toHaveLength(2); // the beta group replaced in place, then the new AskUserQuestion group added
    expect(dropped).toEqual(Object.entries(BETA_GROUPS).map(([event, group]) => JSON.stringify({ event, group })));
    const parsed = blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.event).map((b) => b.event)).toEqual(Object.entries<any[]>(frag.hooks).flatMap(([ev, gs]) => gs.map(() => ev)));
    expect(parsed.filter((b) => b.deny)).toHaveLength(22);
    expect(merge(after, [...beta.blocks.filter((b) => !dropped.includes(b)), ...blocks])).toMatchObject({ after, blocks: [], dropped: [] });
  });

  it('an edited harness group is left with a note', () => {
    const beta = betaSettings({});
    beta.s.hooks.Stop[0] = { hooks: [{ ...beta.s.hooks.Stop[0].hooks[0], timeout: 300 }] };
    const { after, blocks, dropped, notes } = merge(JSON.stringify(beta.s), beta.blocks);
    const s = JSON.parse(after);
    expect(s.hooks.Stop).toEqual([beta.s.hooks.Stop[0]]);
    expect(notes).toEqual(['.claude/settings.json: hooks.Stop[0] is a harness hook you edited; left as is. harness doctor checks it.']);
    expect(blocks.map((b) => JSON.parse(b).event)).not.toContain('Stop');
    expect(dropped).toHaveLength(4);
  });

  it('null hook entry noted, not crashed', () => {
    const before = JSON.stringify({ hooks: { Stop: [null, { hooks: [null, { type: 'command', command: 'echo x' }] }, { matcher: 'x', hooks: 'bad' }] } });
    const { after, notes } = merge(before);
    const s = JSON.parse(after);
    expect(notes.length).toBeGreaterThanOrEqual(3);
    expect(notes.join('\n')).toMatch(/Stop/);
    expect(s.hooks.Stop.slice(0, 3)).toEqual(JSON.parse(before).hooks.Stop);
    expect(s.hooks.Stop[3].hooks[0].args).toEqual(ARGS);
  });

  it('CRLF settings stay CRLF', () => {
    const before = '{\r\n  "model": "x"\r\n}\r\n';
    const { after } = merge(before);
    expect(after).toMatch(/\r\n/);
    expect(after.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(after.endsWith('}\r\n')).toBe(true);
  });

  it('tab-indented settings stay tab-indented', () => {
    const { after } = merge('{\n\t"model": "x"\n}\n');
    expect(after).toMatch(/^\t"model": "x",$/m);
    expect(after).not.toMatch(/^ +"/m);
  });

  it('no trailing newline stays none', () => {
    expect(merge('{"model":"x"}').after.endsWith('}')).toBe(true);
  });

  it('non-array hook event: noted, left untouched, others still added', () => {
    const before = '{"hooks":{"Stop":{"a":1}}}';
    const { after, notes } = merge(before);
    const s = JSON.parse(after);
    expect(s.hooks.Stop).toEqual({ a: 1 });
    expect(notes.join('\n')).toMatch(/hooks\.Stop is not an array/);
    expect(s.hooks.PreToolUse).toHaveLength(2);
  });

  it('invalid JSON: MergeError naming the file', () => {
    expect(() => merge('{ nope')).toThrow(MergeError);
    expect(() => merge('{ nope')).toThrow(/settings\.json/);
  });

  test.each([
    ['root array', '[]', /object/],
    ['hooks not object', '{"hooks":[]}', /hooks/],
    ['deny not array', '{"permissions":{"deny":"x"}}', /deny/],
    ['permissions not object', '{"permissions":[]}', /permissions/],
  ])('settings %s: clear MergeError', (_n, json, re) => {
    expect(() => merge(json)).toThrow(MergeError);
    expect(() => merge(json)).toThrow(re);
  });
});

describe('mergeAgents', () => {
  it('text outside markers is byte-identical, block replaced on rerun', () => {
    const orig = fx('AGENTS.md');
    const a = mergeAgents(orig).after;
    expect(a.startsWith(orig + '\n' + S)).toBe(true);
    const stale = a.replace('## Harness workflow', 'STALE') + '\nTail text.\n';
    const b = mergeAgents(stale);
    expect(b.after).toBe(a + '\nTail text.\n');
    expect(b.blocks).toHaveLength(1);
  });

  it('missing: created with just the block', () => {
    const { after, blocks } = mergeAgents(null);
    expect(after.startsWith(S)).toBe(true);
    expect(after.trimEnd().endsWith(E)).toBe(true);
    expect(blocks).toEqual([after]);
  });

  it('CRLF stays CRLF', () => {
    const { after } = mergeAgents('# a\r\n');
    expect(after.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  test.each([
    ['single marker', `x\n${S}\ny\n`],
    ['two full blocks', `${S}\na\n${E}\nmid\n${S}\nb\n${E}\n`],
    ['doubled start', `${S}\nuser text\n${S}\n${E}\n`],
    ['doubled end', `${S}\n${E}\n${E}\n`],
    ['end before start', `${E}\n${S}\n`],
  ])('%s: MergeError naming the file', (_n, text) => {
    expect(() => mergeAgents(text)).toThrow(MergeError);
    expect(() => mergeAgents(text)).toThrow(/AGENTS\.md.*marker/);
  });
});

describe('mergeClaudeMd', () => {
  it('CLAUDE.md gets the import once', () => {
    const created = mergeClaudeMd(null, true)!;
    expect(created.after).toBe('@AGENTS.md\n');
    const added = mergeClaudeMd('# Mine\n', true)!;
    expect(added.after).toBe('# Mine\n\n@AGENTS.md\n');
    expect(added.blocks).toEqual(['\n@AGENTS.md\n']);
    expect(mergeClaudeMd(added.after, true)).toBeNull();
    expect(mergeClaudeMd('see @AGENTS.md here\n', true)).toBeNull();
  });
  it('no AGENTS.md: nothing to import', () => {
    expect(mergeClaudeMd(null, false)).toBeNull();
    expect(mergeClaudeMd('# x\n', false)).toBeNull();
  });
  it('keeps CRLF and a missing final newline', () => {
    expect(mergeClaudeMd('# x\r\n', true)!.after).toBe('# x\r\n\r\n@AGENTS.md\r\n');
    expect(mergeClaudeMd('# x', true)!.after).toBe('# x\n\n@AGENTS.md\n');
  });
});

describe('mergeGitignore / mergeIgnoreFile', () => {
  it('appends the six lines, once', () => {
    const { after, blocks } = mergeGitignore(fx('.gitignore'));
    expect(after).toBe('node_modules/\ndist/\n.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n');
    expect(blocks).toEqual(['.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n']);
    expect(mergeGitignore(after)).toEqual({ after, blocks: [] });
  });
  it('null creates; missing newline and CRLF handled; partial adds only missing', () => {
    expect(mergeGitignore(null).after).toBe('.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n');
    expect(mergeGitignore('a').blocks[0].startsWith('\n')).toBe(true);
    expect(mergeGitignore('a').after).toBe('a\n.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n');
    expect(mergeGitignore('a\r\n').after).toBe('a\r\n.harness/state/\r\n.harness/logs/\r\n.harness/backup/\r\n.harness/results/\r\n.harness/debug/\r\n.harness/reports/\r\n');
    expect(mergeGitignore('.harness/logs/\n').blocks).toEqual(['.harness/state/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n']);
  });
  it('mergeGitignore adds .harness/results/', () => {
    const r = mergeGitignore('.harness/state/\n.harness/logs/\n.harness/backup/\n');
    expect(r.blocks).toEqual(['.harness/results/\n.harness/debug/\n.harness/reports/\n']);
  });
  it('an existing install gets only the reports line on update', () => {
    const old = '.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n';
    expect(mergeGitignore(old)).toEqual({ after: old + '.harness/reports/\n', blocks: ['.harness/reports/\n'] });
  });
  it('ignore file gets .harness/', () => {
    expect(mergeIgnoreFile('dist\n', '.harness/')).toEqual({ after: 'dist\n.harness/\n', blocks: ['.harness/\n'] });
    expect(mergeIgnoreFile('.harness/\n', '.harness/').blocks).toEqual([]);
  });
});

describe('mergeEslintFlatIgnores', () => {
  it('eslint flat ignores edited', () => {
    const src = "export default [\n  { ignores: ['dist/'] },\n  { files: ['**/*.ts'], rules: {} },\n];\n";
    const r = mergeEslintFlatIgnores(src)!;
    expect(r.after).toContain("'dist/', '.harness/'");
    expect(r.after).toContain("files: ['**/*.ts']");
    expect(r.blocks).toEqual([", '.harness/'"]);
    expect(mergeEslintFlatIgnores(r.after)).toEqual({ after: r.after, blocks: [] });
  });
  it('leaves the rest of the file as written', () => {
    const src = "import x from 'y';\n// keep me\nexport default [\n  { ignores: [\"dist/\"] },\n  { rules: { a: 1 } },\n];\n";
    const out = mergeEslintFlatIgnores(src)!.after;
    expect(out).toContain('// keep me');
    expect(out).toContain('{ rules: { a: 1 } }');
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
  });
  it('defineConfig wrapper and identifier export', () => {
    const a = mergeEslintFlatIgnores("export default defineConfig([{ ignores: [] }]);\n")!;
    expect(a.after).toContain('.harness/');
    const b = mergeEslintFlatIgnores("const cfg = [{ ignores: ['x'] }];\nexport default cfg;\n")!;
    expect(b.after).toContain('.harness/');
  });
  it('a per-object ignores is not global: a new global-ignores entry is appended, in the file\'s layout and quotes', () => {
    const src = 'export default [\n  { files: ["**/*.ts"], ignores: ["x/"] },\n];\n';
    const r = mergeEslintFlatIgnores(src)!;
    expect(r.after).toBe('export default [\n  { files: ["**/*.ts"], ignores: ["x/"] },\n  { ignores: [".harness/"] },\n];\n');
    expect(removeBlocks(r.after, r.blocks)).toBe(src);
    expect(mergeEslintFlatIgnores("export default [{ rules: {} }];\n")!.after).toBe("export default [{ rules: {} }, { ignores: ['.harness/'] }];\n");
    expect(mergeEslintFlatIgnores('export default [];\n')!.after).toBe("export default [{ ignores: ['.harness/'] }];\n");
    // with a global-ignores object later in the array, that one is edited
    expect(mergeEslintFlatIgnores("export default [{ files: ['a'], ignores: ['x'] }, { ignores: ['dist/'] }];\n")!.after).toContain("{ ignores: ['dist/', '.harness/'] }");
  });
  it('globalIgnores([...]) counts as the global-ignores entry', () => {
    const src = 'export default defineConfig([globalIgnores(["dist/"]), js.configs.recommended]);\n';
    const r = mergeEslintFlatIgnores(src)!;
    expect(r.after).toBe('export default defineConfig([globalIgnores(["dist/", ".harness/"]), js.configs.recommended]);\n');
    expect(mergeEslintFlatIgnores(r.after)!.blocks).toEqual([]);
  });
  it('computed eslint config returns null', () => {
    expect(mergeEslintFlatIgnores('export default makeConfig();\n')).toBeNull();
    expect(mergeEslintFlatIgnores("export default [{ ignores: IGN }];\n")).toBeNull();
    expect(mergeEslintFlatIgnores('export default [ {{{')).toBeNull();
    expect(mergeEslintFlatIgnores('module.exports = [];\n')).toBeNull();
  });
});

describe('round trip: before -> merge -> removeBlocks gives before back', () => {
  const inputs: [string, string | null][] = [
    ['null', null],
    ['empty', ''],
    ['no trailing newline', '# Mine'],
    ['CRLF', '# Mine\r\nmore\r\n'],
    ['existing content', '# Mine\n\nstuff\n'],
  ];
  const rt = (name: string, f: (b: string | null) => { after: string; blocks: string[] } | null) =>
    test.each(inputs)(`${name}: %s`, (_n, before) => {
      const r = f(before)!;
      expect(r).not.toBeNull();
      expect(removeBlocks(r.after, r.blocks)).toBe(before ?? '');
    });
  rt('mergeAgents', mergeAgents);
  rt('mergeClaudeMd', (b) => mergeClaudeMd(b, true));
  rt('mergeGitignore', mergeGitignore);
  rt('mergeIgnoreFile', (b) => mergeIgnoreFile(b, '.harness/'));

  test.each([
    ['no trailing newline', "export default [{ ignores: ['a'] }];"],
    ['CRLF', "export default [\r\n  { ignores: ['a'] },\r\n];\r\n"],
    ['existing content', "export default [\n  { ignores: ['a', 'b'] },\n  { rules: {} },\n];\n"],
    ['empty ignores', "export default [{ ignores: [] }];\n"],
  ])('mergeEslintFlatIgnores: %s', (_n, before) => {
    const r = mergeEslintFlatIgnores(before)!;
    expect(r.after).not.toBe(before);
    expect(removeBlocks(r.after, r.blocks)).toBe(before);
  });

  it('AGENTS.md marker replace: removal gives back only the text outside the markers', () => {
    const before = `top\n${S}\nmy own text\n${E}\nbottom\n`;
    const r = mergeAgents(before);
    expect(removeBlocks(r.after, r.blocks)).toBe('top\n\nbottom\n');
  });
});

describe('removeBlocks picks the last occurrence', () => {
  test('earlier user text containing the block is left alone', () => {
    const m = mergeIgnoreFile('foo.harness/\nbar\n', '.harness/')!;
    expect(removeBlocks(m.after, m.blocks)).toBe('foo.harness/\nbar\n');
  });
});

test('removeBlocks tolerates a CRLF checkout of an LF block, and the reverse', async () => {
  const { removeBlocks } = await import('../../src/install/merge.js');
  expect(removeBlocks('mine\r\nx\r\ny\r\n', ['x\ny\n'])).toBe('mine\r\n');
  expect(removeBlocks('mine\nx\ny\n', ['x\r\ny\r\n'])).toBe('mine\n');
});

describe('mergeSettings sandbox', () => {
  const SB = { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false };
  const sets = (blocks: string[]) => blocks.filter((b) => b.startsWith('{"set"'));
  const run = (before: string | null, sandbox: 'unattended' | 'always' | 'off', recorded?: string[]) => mergeSettings(before, { sandbox, recorded });

  it('always adds the sandbox block and records each key', () => {
    const r = run('{}\n', 'always');
    expect(JSON.parse(r.after).sandbox).toEqual(SB);
    expect(sets(r.blocks)).toEqual([
      '{"set":["sandbox"],"value":{}}',
      '{"set":["sandbox","enabled"],"value":true}',
      '{"set":["sandbox","allowUnsandboxedCommands"],"value":false}',
      '{"set":["sandbox","autoAllowBashIfSandboxed"],"value":false}',
    ]);
    expect(r.notes).toEqual([]);
  });

  it('always leaves a key the person set, with a note', () => {
    const r = run(JSON.stringify({ sandbox: { autoAllowBashIfSandboxed: true } }), 'always');
    expect(JSON.parse(r.after).sandbox).toEqual({ ...SB, autoAllowBashIfSandboxed: true });
    expect(r.notes).toEqual(['.claude/settings.json: sandbox.autoAllowBashIfSandboxed is already true; left as is (harness would set false).']);
    expect(sets(r.blocks)).toEqual(['{"set":["sandbox","enabled"],"value":true}', '{"set":["sandbox","allowUnsandboxedCommands"],"value":false}']);
  });

  it('a non-object sandbox is an error under always', () => {
    expect(() => run(JSON.stringify({ sandbox: true }), 'always')).toThrow(MergeError);
    expect(() => run(JSON.stringify({ sandbox: true }), 'always')).toThrow('"sandbox" must be an object');
  });

  it('unattended and off add no sandbox key', () => {
    for (const m of ['unattended', 'off'] as const) {
      const r = run('{}\n', m);
      expect(JSON.parse(r.after).sandbox).toBeUndefined();
      expect(sets(r.blocks)).toEqual([]);
    }
  });

  it('failIfUnavailable is never written', () => {
    for (const m of ['unattended', 'always', 'off'] as const) expect(run(null, m).after).not.toContain('failIfUnavailable');
  });

  it('leaving always removes the recorded keys', () => {
    const init = run('{"model":"x"}\n', 'always');
    const rec = sets(init.blocks);
    const r = run(init.after, 'unattended', init.blocks);
    expect(JSON.parse(r.after)).not.toHaveProperty('sandbox');
    expect([...r.dropped].sort()).toEqual([...rec].sort());
    expect(r.notes).toEqual([]);
    const off = run(init.after, 'off', init.blocks);
    expect(off.after).toBe(r.after);
    expect(JSON.parse(off.after)).not.toHaveProperty('sandbox');
    expect([...off.dropped].sort()).toEqual([...rec].sort());
    expect(off.notes).toEqual([]);

    const edited = JSON.parse(init.after);
    edited.sandbox.enabled = false;
    const r2 = run(JSON.stringify(edited, null, 2), 'off', init.blocks);
    expect(JSON.parse(r2.after).sandbox).toEqual({ enabled: false });
    expect(r2.notes).toEqual(['`.claude/settings.json`: `sandbox.enabled` was changed; left as is.']);
    expect([...r2.dropped].sort()).toEqual([...rec].sort());
  });
});

describe('plugins, marketplace and MCP blocks', () => {
  const PW = { name: 'playwright', item: 'mcp-playwright', config: { command: 'npx', args: ['@playwright/mcp@1.0.0'] } };
  const GH = { name: 'alpha', item: 'plugin-alpha', source: { source: 'github', repo: 'o/alpha', sha: 'a'.repeat(40) } } as const;
  const SUB = { name: 'beta', item: 'plugin-beta', source: { source: 'git-subdir', url: 'o/mono', path: 'plugins/beta', sha: 'b'.repeat(40) } } as const;
  const GAMMA = { name: 'gamma', item: 'plugin-gamma', source: { source: 'github', repo: 'o/gamma', sha: 'c'.repeat(40) } } as const;
  const LSP = { name: 'typescript-lsp', item: 'plugin-ts-lsp', source: { source: 'github', repo: 'o/lsp', sha: 'd'.repeat(40) }, lspServers: { typescript: { command: 'tsls', args: ['--stdio'], extensionToLanguage: { '.ts': 'typescript' } } } } as const;
  const plug = (before: string | null, plugins: any[], recorded?: string[]) => mergeSettings(before, { sandbox: 'unattended', recorded, plugins });
  const entryOf = (...ps: any[]) => ({ source: { source: 'settings', name: 'harness-pins', owner: { name: 'harness' }, plugins: ps } });

  it('plugins add enabledPlugins and the harness-pins marketplace', () => {
    const r = plug(null, [GH, SUB]);
    const s = JSON.parse(r.after);
    expect(s.enabledPlugins).toEqual({ 'alpha@harness-pins': true, 'beta@harness-pins': true });
    expect(s.extraKnownMarketplaces).toEqual({
      'harness-pins': entryOf(
        { name: 'alpha', source: { source: 'github', repo: 'o/alpha', sha: 'a'.repeat(40) } },
        { name: 'beta', source: { source: 'git-subdir', url: 'o/mono', path: 'plugins/beta', sha: 'b'.repeat(40) } },
      ),
    });
    expect(s.permissions.deny).toHaveLength(30);
    expect(s.hooks.Stop[0].hooks[0].args).toEqual(ARGS);
    const parsed = r.blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.plugin)).toEqual([{ plugin: 'alpha@harness-pins', item: 'plugin-alpha' }, { plugin: 'beta@harness-pins', item: 'plugin-beta' }]);
    expect(parsed.filter((b) => b.marketplace)).toEqual([{ marketplace: 'harness-pins', entry: s.extraKnownMarketplaces['harness-pins'] }]);
  });

  it('an LSP plugin entry carries lspServers (golden)', () => {
    const e = JSON.parse(plug(null, [LSP]).after).extraKnownMarketplaces['harness-pins'];
    expect(e).toEqual(entryOf({ name: 'typescript-lsp', source: LSP.source, lspServers: LSP.lspServers }));
  });

  it('harness-pins entry has only documented fields', () => {
    const e = JSON.parse(plug(null, [GH, SUB, LSP]).after).extraKnownMarketplaces['harness-pins'];
    expect(Object.keys(e)).toEqual(['source']);
    expect(Object.keys(e.source).sort()).toEqual(['name', 'owner', 'plugins', 'source']);
    for (const p of e.plugins ?? e.source.plugins) expect(Object.keys(p).every((k) => ['name', 'source', ...(p.name === 'typescript-lsp' ? ['lspServers'] : [])].includes(k))).toBe(true);
    expect(e.source.plugins.filter((p: any) => 'lspServers' in p).map((p: any) => p.name)).toEqual(['typescript-lsp']);
  });

  it('re-merge with recorded replaces the marketplace entry and drops removed plugins', () => {
    const first = plug(null, [GH, SUB, GAMMA]);
    const r = plug(first.after, [GH, SUB], first.blocks);
    const s = JSON.parse(r.after);
    expect(Object.keys(s.enabledPlugins)).toEqual(['alpha@harness-pins', 'beta@harness-pins']);
    expect(s.extraKnownMarketplaces['harness-pins'].source.plugins.map((p: any) => p.name)).toEqual(['alpha', 'beta']);
    const oldMarket = first.blocks.find((b) => b.includes('"marketplace"'))!;
    const gammaBlock = first.blocks.find((b) => b.includes('gamma@harness-pins'))!;
    expect([...r.dropped].sort()).toEqual([oldMarket, gammaBlock].sort());
    expect(r.blocks.map((b) => JSON.parse(b)).filter((b) => b.marketplace)).toHaveLength(1);
    expect(r.notes).toEqual([]);
  });

  it('removing the last plugin deletes both keys harness added', () => {
    const first = plug(null, [GH]);
    const r = plug(first.after, [], first.blocks);
    const s = JSON.parse(r.after);
    expect(s).not.toHaveProperty('enabledPlugins');
    expect(s).not.toHaveProperty('extraKnownMarketplaces');
    expect(r.dropped.length).toBeGreaterThan(0);
  });

  it('with no plugins and nothing recorded neither key is added', () => {
    const s = JSON.parse(plug(null, []).after);
    expect(s).not.toHaveProperty('enabledPlugins');
    expect(s).not.toHaveProperty('extraKnownMarketplaces');
  });

  it('a user-edited harness-pins entry is left and reported', () => {
    const first = plug(null, [GH]);
    const edited = JSON.parse(first.after);
    edited.extraKnownMarketplaces['harness-pins'].source.owner.name = 'me';
    const r = plug(JSON.stringify(edited, null, 2), [GH, SUB], first.blocks);
    expect(JSON.parse(r.after).extraKnownMarketplaces['harness-pins'].source.owner.name).toBe('me');
    expect(r.notes).toEqual(['`.claude/settings.json`: the harness-pins marketplace was edited; left as is. harness doctor checks it.']);
  });

  // Folds a merge into the recorded blocks the way update.ts does: drop the dropped, add the new.
  const fold = (rec: string[], r: { blocks: string[]; dropped: string[] }) => [...rec.filter((b) => !r.dropped.includes(b)), ...r.blocks];
  const canon = (o: unknown) => JSON.stringify(o, null, '\t').replace(/\n/g, '\r\n') + '\r\n';
  const FILE = (rel: string, blocks: string[]) => ({ rel, kind: 'update' as const, hash: '', blocks });

  it("the person's own plugins, marketplaces, sandbox and MCP servers survive install, re-merge and uninstall byte-identical", () => {
    const before = canon({ enabledPlugins: { 'foo@other': true }, extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'x/y' } } }, sandbox: { enabled: false } });
    const m1 = mergeSettings(before, { sandbox: 'always', plugins: [GH, GAMMA] });
    const m2 = mergeSettings(m1.after, { sandbox: 'always', plugins: [GH], recorded: m1.blocks });
    const rec = fold(m1.blocks, m2);
    expect(m2.after).toContain('\r\n\t');
    const notes: string[] = [];
    expect(removeFromSettings(m2.after, FILE('.claude/settings.json', rec), before, notes)!.after).toBe(before);
    expect(notes.filter((n) => !/sandbox/.test(n))).toEqual([]);

    const mcpBefore = canon({ mcpServers: { mine: { command: 'x' } } });
    const a = mergeMcp(mcpBefore, [PW]);
    const b = mergeMcp(a.after, [PW], a.blocks);
    expect(removeFromMcp(b.after, FILE('.mcp.json', fold(a.blocks, b)), mcpBefore, [])!.after).toBe(mcpBefore);
  });

  it("the person's own empty enabledPlugins, marketplaces and mcpServers survive a merge with nothing picked", () => {
    const own = '{\n  "enabledPlugins": {},\n  "extraKnownMarketplaces": {}\n}\n';
    const r = plug(own, []);
    expect(JSON.parse(r.after)).toMatchObject({ enabledPlugins: {}, extraKnownMarketplaces: {} });
    expect(mergeMcp('{"mcpServers": {}}\n', []).after).toContain('"mcpServers": {}');
  });

  it('harness-created keys are recorded and deleted once empty', () => {
    const first = plug(null, [GH]);
    expect(first.blocks).toContain('{"created":"enabledPlugins"}');
    expect(first.blocks).toContain('{"created":"extraKnownMarketplaces"}');
    const r = plug(first.after, [], first.blocks);
    expect(r.dropped).toContain('{"created":"enabledPlugins"}');
    expect(JSON.parse(r.after)).not.toHaveProperty('enabledPlugins');
    expect(mergeMcp(null, [PW]).blocks).toContain('{"created":"mcpServers"}');
  });

  it('a recorded plugin the person set to false is left with a note, stays recorded, and uninstall notes it too', () => {
    const first = plug(null, [GH, GAMMA]);
    const edited = JSON.parse(first.after);
    edited.enabledPlugins['gamma@harness-pins'] = false;
    const r = plug(JSON.stringify(edited, null, 2), [GH], first.blocks);
    const gamma = first.blocks.find((b) => b.includes('gamma@harness-pins'))!;
    expect(JSON.parse(r.after).enabledPlugins['gamma@harness-pins']).toBe(false);
    expect(r.notes).toContain('`.claude/settings.json`: `gamma@harness-pins` was changed; left as is.');
    expect(r.dropped).not.toContain(gamma);
    const notes: string[] = [];
    const out = removeFromSettings(r.after, FILE('.claude/settings.json', fold(first.blocks, r)), null, notes)!;
    expect(JSON.parse(out.after).enabledPlugins).toEqual({ 'gamma@harness-pins': false });
    expect(notes).toContain('`.claude/settings.json`: `gamma@harness-pins` was changed; left as is.');
  });

  it('a recorded plugin the person removed is dropped without a note', () => {
    const first = plug(null, [GH, GAMMA]);
    const edited = JSON.parse(first.after);
    delete edited.enabledPlugins['gamma@harness-pins'];
    const r = plug(JSON.stringify(edited), [GH], first.blocks);
    expect(r.dropped).toContain(first.blocks.find((b) => b.includes('gamma@harness-pins')));
    expect(r.notes).toEqual([]);
  });

  it('plugin entries leave the ConfigChange guarded view unchanged', () => {
    const base = merge(null).after;
    expect(guardedView(plug(base, [GH, SUB, LSP]).after, null)).toEqual(guardedView(base, null));
  });

  it('pinnedPlugins reads catalog items', () => {
    const item = (id: string, source: any, extra: any = {}) => ({ id, kind: 'plugin', source, ...extra }) as any;
    expect(pinnedPlugins([
      item('a', { type: 'github', repo: 'o/alpha', plugin: 'alpha', sha: 'a'.repeat(40) }),
      item('b', { type: 'git-subdir', repo: 'o/mono', path: 'p/b', plugin: 'beta', sha: 'b'.repeat(40) }, { lsp_servers: { x: { command: 'y' } } }),
      item('x', { type: 'git-subdir', repo: 'o/mono', path: 'skills/x', plugin: 'xs', sha: 'c'.repeat(40) }, { kind: 'external-skill' }),
      { id: 'm', kind: 'mcp', source: { type: 'npm', package: 'p', version: '1.0.0' } } as any,
    ])).toEqual([
      { name: 'alpha', item: 'a', source: { source: 'github', repo: 'o/alpha', sha: 'a'.repeat(40) } },
      { name: 'beta', item: 'b', source: { source: 'git-subdir', url: 'o/mono', path: 'p/b', sha: 'b'.repeat(40) }, lspServers: { x: { command: 'y' } } },
      { name: 'xs', item: 'x', source: { source: 'git-subdir', url: 'o/mono', path: 'skills/x', sha: 'c'.repeat(40) } },
    ]);
  });
});

describe('mergeMcp', () => {
  const PW = { name: 'playwright', item: 'mcp-playwright', config: { command: 'npx', args: ['@playwright/mcp@1.0.0'] } };

  it('mergeMcp creates .mcp.json, and removal deletes it when harness created it and it ends empty', () => {
    const r = mergeMcp(null, [PW]);
    expect(JSON.parse(r.after)).toEqual({ mcpServers: { playwright: PW.config } });
    expect(r.blocks.map((b) => JSON.parse(b))).toEqual([{ created: 'mcpServers' }, { mcp: 'playwright', item: 'mcp-playwright', server: PW.config }]);
    const out = removeFromMcp(r.after, { rel: '.mcp.json', kind: 'create', hash: '', blocks: r.blocks }, null, []);
    expect(out).toEqual({ after: '{}\n', empty: true });
  });

  it('user mcp server with the same name is kept and reported', () => {
    const before = JSON.stringify({ mcpServers: { playwright: { command: 'mine' } } }, null, 2) + '\n';
    const r = mergeMcp(before, [PW]);
    expect(r.after).toBe(before);
    expect(r.blocks).toEqual([]);
    expect(r.notes).toEqual(['`.mcp.json` already has a server named "playwright"; left as is.']);
  });

  it('keeps CRLF and tab indent, and removal gives the original back', () => {
    const before = '{\r\n\t"mcpServers": {\r\n\t\t"mine": { "command": "x" }\r\n\t}\r\n}\r\n';
    const r = mergeMcp(before, [PW]);
    expect(r.after).toContain('\r\n\t');
    expect(r.after).not.toMatch(/[^\r]\n/);
    const out = removeFromMcp(r.after, { rel: '.mcp.json', kind: 'update', hash: '', blocks: r.blocks }, before, [])!;
    expect(out.after).toBe(JSON.stringify(JSON.parse(before), null, '\t').replace(/\n/g, '\r\n') + '\r\n');
  });

  it('re-merge replaces a changed server and drops removed ones', () => {
    const first = mergeMcp(null, [PW, { name: 'two', item: 'mcp-two', config: { command: 'b' } }]);
    const r = mergeMcp(first.after, [{ ...PW, config: { command: 'npx', args: ['@playwright/mcp@2.0.0'] } }], first.blocks);
    expect(JSON.parse(r.after).mcpServers).toEqual({ playwright: { command: 'npx', args: ['@playwright/mcp@2.0.0'] } });
    expect([...r.dropped].sort()).toEqual(first.blocks.filter((b) => !b.includes('created')).sort());
    expect(r.blocks).toHaveLength(1);
  });

  it('a changed recorded server no longer picked is kept with a note and stays recorded; an edited picked one gets the edited note', () => {
    const first = mergeMcp(null, [PW]);
    const edited = JSON.parse(first.after);
    edited.mcpServers.playwright.command = 'mine';
    const text = JSON.stringify(edited, null, 2);
    const gone = mergeMcp(text, [], first.blocks);
    expect(JSON.parse(gone.after).mcpServers.playwright.command).toBe('mine');
    expect(gone.notes).toEqual(['`.mcp.json`: `playwright` was changed; left as is.']);
    expect(gone.dropped).toEqual([]);
    expect(mergeMcp(text, [PW], first.blocks).notes).toEqual(['`.mcp.json`: server "playwright" was edited; left as is.']);
  });

  it('STRUCTURAL names the two structural files', () => {
    expect([...STRUCTURAL].sort()).toEqual(['.claude/settings.json', '.mcp.json']);
  });
});

describe('uninstall trusts created-key blocks', () => {
  const F = (rel: string, blocks: string[]) => ({ rel, kind: 'update' as const, hash: '', blocks });
  const PL = { name: 'alpha', item: 'a', source: { source: 'github' as const, repo: 'o/alpha', sha: 'a'.repeat(40) } };

  it('no backup: a recorded created block removes the key it emptied', () => {
    const m = mergeSettings(null, { sandbox: 'unattended', plugins: [PL] });
    const out = removeFromSettings(m.after, F('.claude/settings.json', m.blocks), null, [])!;
    expect(JSON.parse(out.after)).not.toHaveProperty('enabledPlugins');
    expect(JSON.parse(out.after)).not.toHaveProperty('extraKnownMarketplaces');
    const k = mergeMcp('{"mine":1}\n', [{ name: 'pw', item: 'm', config: { command: 'x' } }]);
    expect(JSON.parse(removeFromMcp(k.after, F('.mcp.json', k.blocks), null, [])!.after)).toEqual({ mine: 1 });
  });

  it("no backup: the person's own empty key, with no created block, stays", () => {
    const own = '{\n  "enabledPlugins": {\n    "foo@other": true\n  }\n}\n';
    const m = mergeSettings(own, { sandbox: 'unattended', plugins: [PL] });
    const out = removeFromSettings(m.after, F('.claude/settings.json', m.blocks.filter((b) => !b.includes('created":"enabledPlugins'))), null, [])!;
    expect(JSON.parse(out.after).enabledPlugins).toEqual({ 'foo@other': true });
    const ownEmpty = '{"enabledPlugins":{"x@harness-pins":true}}\n';
    const blk = [JSON.stringify({ plugin: 'x@harness-pins', item: 'x' })];
    expect(JSON.parse(removeFromSettings(ownEmpty, F('.claude/settings.json', blk), null, [])!.after)).toEqual({ enabledPlugins: {} });
    const mcp = removeFromMcp('{"mcpServers":{"pw":{"command":"x"}}}\n', F('.mcp.json', [JSON.stringify({ mcp: 'pw', item: 'm', server: { command: 'x' } })]), null, [])!;
    expect(JSON.parse(mcp.after)).toEqual({ mcpServers: {} });
  });
});

describe('preset merge kinds', () => {
  // Invented for these tests only.
  TELEMETRY_ENV.a = { name: 'DO_NOT_TRACK', value: '1' };
  TELEMETRY_ENV.b = { name: 'B_OFF', value: 'x' };
  afterAll(() => { delete TELEMETRY_ENV.a; delete TELEMETRY_ENV.b; });
  const inner = '## Rules\n\n- one\n';
  const core = `${PRESET_START}\n\n## Rules\n\n- one\n\n${PRESET_END}\n`; // what the merge writes
  const lp = { preset: { settings: { attribution: 'off', telemetry_off: ['a', 'b'] } } } as unknown as LoadedPreset;
  const want = presetSets(lp, { selected: ['a', 'b'], env: true });
  const F = (blocks: string[]) => ({ rel: '.claude/settings.json', kind: 'update' as const, hash: '', blocks });
  const envOf = (s: string) => JSON.parse(s)['env'];

  it('agents block: create, append, order, exact removal, replace, errors', () => {
    expect(mergeAgentsPreset(null, inner).after).toBe(core);
    expect(mergeAgentsPreset('# Mine\n', inner).after).toBe('# Mine\n\n' + core);
    expect(() => mergeAgentsPreset('# a\n', core)).toThrow(/must not contain the preset markers/);
    const h = mergeAgents(null);
    expect(mergeAgentsPreset(h.after, inner).after.indexOf(PRESET_START)).toBeGreaterThan(h.after.indexOf(E));
    for (const eol of ['\n', '\r\n']) {
      const orig = `# Mine${eol}`;
      const m = mergeAgentsPreset(orig, inner);
      expect(removeBlocks(m.after, m.blocks)).toBe(orig);
    }
    const a = mergeAgentsPreset('# Mine\n', inner).after;
    expect(mergeAgentsPreset(a, inner.replace('one', 'two')).after).toBe(a.replace('one', 'two'));
    expect(() => mergeAgentsPreset(a + PRESET_START, inner)).toThrow('AGENTS.md has a repeated preset marker; fix it by hand');
    expect(() => mergeAgentsPreset(`${PRESET_END}\n${PRESET_START}`, inner)).toThrow(/missing or misordered preset marker/);
  });

  it('presetSets returns leaf keys only', () => {
    expect(want).toEqual([
      { set: ['attribution'], value: false },
      { set: ['env', 'DO_NOT_TRACK'], value: '1' },
      { set: ['env', 'B_OFF'], value: 'x' },
    ]);
    expect(presetSets(lp, { selected: ['b'], env: true }).map((x) => x.set.at(-1))).toEqual(['attribution', 'B_OFF']);
    expect(presetSets(lp, { selected: ['a', 'b'], env: false })).toEqual([{ set: ['attribution'], value: false }]);
  });

  it('settings: adds into {} and restores', () => {
    const r = mergePresetSettings('{}\n', want, []);
    expect(JSON.parse(r.after)).toEqual({ attribution: false, env: { DO_NOT_TRACK: '1', B_OFF: 'x' } });
    expect(r.blocks).toContain('{"set":["env"],"value":{}}');
    expect(removeFromSettings(r.after, F(r.blocks), '{}\n', [])!.after).toBe('{}\n');
  });

  it('settings: keeps FOO, leaves differing values with a note', () => {
    const b = '{\n  "env": {\n    "FOO": "1"\n  }\n}\n';
    const r = mergePresetSettings(b, want, []);
    expect(r.blocks).not.toContain('{"set":["env"],"value":{}}');
    expect(removeFromSettings(r.after, F(r.blocks), b, [])!.after).toBe(b);
    const n = mergePresetSettings('{"env":{"B_OFF":"other"}}', want, []);
    expect(envOf(n.after)).toEqual({ B_OFF: 'other', DO_NOT_TRACK: '1' });
    expect(n.notes).toEqual(['`.claude/settings.json`: `env.B_OFF` is already "other"; left as is (the preset would set "x").']);
    const at = mergePresetSettings('{"attribution":{"commit":"x"}}', want, []);
    expect(JSON.parse(at.after).attribution).toEqual({ commit: 'x' });
    expect(at.notes[0]).toContain('`attribution` is already {"commit":"x"}');
  });

  it('settings: drops recorded blocks no longer wanted', () => {
    const r = mergePresetSettings('{}\n', want, []);
    const g = mergePresetSettings(r.after, presetSets(lp, { selected: [], env: false }), r.blocks);
    expect(JSON.parse(g.after)).toEqual({ attribution: false });
    expect(g.dropped.length).toBe(3);
  });

  it('mergeSettings off always keeps preset set blocks (review focus 1)', () => {
    const p = mergePresetSettings(null, want, []);
    const h = merge(p.after);
    const m = mergeSettings(p.after, { sandbox: 'unattended', recorded: [...h.blocks, ...p.blocks] });
    expect(JSON.parse(m.after).attribution).toBe(false);
    expect(envOf(m.after)).toEqual({ DO_NOT_TRACK: '1', B_OFF: 'x' });
    expect(m.dropped.filter((b) => b.startsWith('{"set"'))).toEqual([]);
  });

  it('leaving always drops sandbox blocks and keeps preset blocks', () => {
    const p = mergePresetSettings(null, want, []);
    const al = mergeSettings(p.after, { sandbox: 'always' });
    const rec = [...al.blocks, ...p.blocks];
    for (const sandbox of ['unattended', 'off'] as const) {
      const m = mergeSettings(al.after, { sandbox, recorded: rec });
      expect(JSON.parse(m.after)).not.toHaveProperty('sandbox');
      expect(JSON.parse(m.after).attribution).toBe(false);
      expect(envOf(m.after)).toEqual({ DO_NOT_TRACK: '1', B_OFF: 'x' });
      expect(m.dropped.filter((b) => b.startsWith('{"set"')).every((b) => b.includes('"sandbox"'))).toBe(true);
    }
  });
});
