import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, test } from 'vitest';
import { BETA_GROUPS, betaSettings } from './helpers.js';
import { MergeError, mergeAgents, mergeAgentsPreset, mergePresetSettings, presetSets, PRESET_END, PRESET_START, mergeClaudeMd, mergeEslintFlatIgnores, mergeEslintHarnessRules, mergeGitignore, mergeIgnoreFile, mergeSettings, mergeMcp, pinnedPlugins, pinsAt, pinsMismatch, pinsName, settingsPins, removeBlocks, removeFromMcp, removeFromSettings, removeFromTsconfig, mergeTsconfigOptions, STRUCTURAL } from '../../src/install/merge.js';
import { TELEMETRY_ENV, type LoadedPreset } from '../../src/catalog/presets.js';
import { denyWritePaths } from '../../src/checks/protect.js';
import { guardedView } from '../../src/core/harness-files.js';

const fx = (p: string) => readFileSync(`test/fixtures/install-repo/${p}`, 'utf8');
const ARGS = ['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs'];
const PRE = 'Bash|PowerShell|Monitor|Read|Grep|Edit|Write|MultiEdit|NotebookEdit|mcp__.*';
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
    // blocks: 9 hook groups (AskUserQuestion has its own Pre and Post group) + deny rules not already present (35 of 36)
    const parsed = blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.event)).toHaveLength(9);
    expect(parsed.filter((b) => b.deny)).toHaveLength(35);
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

  it('a fresh file gets 9 group blocks and 36 deny blocks, nothing dropped', () => {
    const { after, blocks, dropped } = merge(null);
    const parsed = blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.event)).toHaveLength(9);
    expect(parsed.filter((b) => b.deny)).toHaveLength(36);
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
    expect(parsed.filter((b) => b.deny)).toHaveLength(28);
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
    expect(after).toBe('node_modules/\ndist/\n.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n.harness/reviews/\n');
    expect(blocks).toEqual(['.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n.harness/reviews/\n']);
    expect(mergeGitignore(after)).toEqual({ after, blocks: [] });
  });
  it('null creates; missing newline and CRLF handled; partial adds only missing', () => {
    expect(mergeGitignore(null).after).toBe('.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n.harness/reviews/\n');
    expect(mergeGitignore('a').blocks[0].startsWith('\n')).toBe(true);
    expect(mergeGitignore('a').after).toBe('a\n.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n.harness/reviews/\n');
    expect(mergeGitignore('a\r\n').after).toBe('a\r\n.harness/state/\r\n.harness/logs/\r\n.harness/backup/\r\n.harness/results/\r\n.harness/debug/\r\n.harness/reports/\r\n.harness/reviews/\r\n');
    expect(mergeGitignore('.harness/logs/\n').blocks).toEqual(['.harness/state/\n.harness/backup/\n.harness/results/\n.harness/debug/\n.harness/reports/\n.harness/reviews/\n']);
  });
  it('mergeGitignore adds .harness/results/', () => {
    const r = mergeGitignore('.harness/state/\n.harness/logs/\n.harness/backup/\n');
    expect(r.blocks).toEqual(['.harness/results/\n.harness/debug/\n.harness/reports/\n.harness/reviews/\n']);
  });
  it('an existing install gets only the missing lines on update (reports, reviews)', () => {
    const old = '.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n.harness/debug/\n';
    expect(mergeGitignore(old)).toEqual({ after: old + '.harness/reports/\n.harness/reviews/\n', blocks: ['.harness/reports/\n.harness/reviews/\n'] });
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
  // `always` keys (owner ruling 2026-11-13: failIfUnavailable too), plus the denyWrite paths every mode writes.
  const SB = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false };
  const FS = { filesystem: { denyWrite: denyWritePaths() } };
  const sets = (blocks: string[]) => blocks.filter((b) => b.startsWith('{"set"'));
  const run = (before: string | null, sandbox: 'unattended' | 'always' | 'off', recorded?: string[]) => mergeSettings(before, { sandbox, recorded });

  it('always adds the sandbox block and records each key', () => {
    const r = run('{}\n', 'always');
    expect(JSON.parse(r.after).sandbox).toEqual({ ...SB, ...FS });
    expect(sets(r.blocks)).toEqual([
      '{"set":["sandbox"],"value":{}}',
      '{"set":["sandbox","enabled"],"value":true}',
      '{"set":["sandbox","failIfUnavailable"],"value":true}',
      '{"set":["sandbox","allowUnsandboxedCommands"],"value":false}',
      '{"set":["sandbox","autoAllowBashIfSandboxed"],"value":false}',
    ]);
    expect(r.notes).toEqual([expect.stringMatching(/sandbox\.network\.allowedDomains/)]);
  });

  it('always leaves a key the person set, with a note', () => {
    const r = run(JSON.stringify({ sandbox: { autoAllowBashIfSandboxed: true } }), 'always');
    expect(JSON.parse(r.after).sandbox).toEqual({ ...SB, autoAllowBashIfSandboxed: true, ...FS });
    expect(r.notes).toEqual([expect.stringMatching(/allowedDomains/), '.claude/settings.json: sandbox.autoAllowBashIfSandboxed is already true; left as is (harness would set false).']);
    expect(sets(r.blocks)).toEqual(['{"set":["sandbox","enabled"],"value":true}', '{"set":["sandbox","failIfUnavailable"],"value":true}', '{"set":["sandbox","allowUnsandboxedCommands"],"value":false}']);
  });

  it('a non-object sandbox is an error under always', () => {
    expect(() => run(JSON.stringify({ sandbox: true }), 'always')).toThrow(MergeError);
    expect(() => run(JSON.stringify({ sandbox: true }), 'always')).toThrow('"sandbox" must be an object');
  });

  it('unattended and off add no sandbox key but the denyWrite paths', () => {
    for (const m of ['unattended', 'off'] as const) {
      const r = run('{}\n', m);
      expect(JSON.parse(r.after).sandbox).toEqual(FS);
      expect(sets(r.blocks)).toEqual([]);
    }
  });

  it('failIfUnavailable is written only under always', () => {
    expect(run(null, 'always').after).toContain('"failIfUnavailable": true');
    for (const m of ['unattended', 'off'] as const) expect(run(null, m).after).not.toContain('failIfUnavailable');
  });

  it('leaving always removes the recorded keys', () => {
    const init = run('{"model":"x"}\n', 'always');
    const rec = sets(init.blocks);
    const r = run(init.after, 'unattended', init.blocks);
    expect(JSON.parse(r.after).sandbox).toEqual(FS); // the always keys go; the denyWrite paths stay in every mode
    expect([...r.dropped].sort()).toEqual([...rec].sort());
    expect(r.notes).toEqual([]);
    const off = run(init.after, 'off', init.blocks);
    expect(off.after).toBe(r.after);
    expect(JSON.parse(off.after).sandbox).toEqual(FS);
    expect([...off.dropped].sort()).toEqual([...rec].sort());
    expect(off.notes).toEqual([]);

    const edited = JSON.parse(init.after);
    edited.sandbox.enabled = false;
    const r2 = run(JSON.stringify(edited, null, 2), 'off', init.blocks);
    expect(JSON.parse(r2.after).sandbox).toEqual({ enabled: false, ...FS });
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
  const N = (...ps: any[]) => pinsName(ps);
  const entryOf = (name: string, ...ps: any[]) => ({ source: { source: 'settings', name, owner: { name: 'harness' }, plugins: ps } });
  // A merge as the shared-name versions wrote it: the same content under `harness-pins`.
  const legacy = (r: { after: string; blocks: string[]; market: string }) => ({ after: r.after.replaceAll(r.market, 'harness-pins'), blocks: r.blocks.map((b) => b.replaceAll(r.market, 'harness-pins')) });

  it('plugins add enabledPlugins and the content-named pins marketplace', () => {
    const r = plug(null, [GH, SUB]);
    const M = N(GH, SUB);
    expect(r.market).toBe(M);
    const s = JSON.parse(r.after);
    expect(s.enabledPlugins).toEqual({ [`alpha@${M}`]: true, [`beta@${M}`]: true });
    expect(s.extraKnownMarketplaces).toEqual({
      [M]: entryOf(M,
        { name: 'alpha', source: { source: 'github', repo: 'o/alpha', sha: 'a'.repeat(40) } },
        { name: 'beta', source: { source: 'git-subdir', url: 'o/mono', path: 'plugins/beta', sha: 'b'.repeat(40) } },
      ),
    });
    expect(s.permissions.deny).toHaveLength(36);
    expect(s.hooks.Stop[0].hooks[0].args).toEqual(ARGS);
    const parsed = r.blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.plugin)).toEqual([{ plugin: `alpha@${M}`, item: 'plugin-alpha' }, { plugin: `beta@${M}`, item: 'plugin-beta' }]);
    expect(parsed.filter((b) => b.marketplace)).toEqual([{ marketplace: M, entry: s.extraKnownMarketplaces[M] }]);
  });

  it('an LSP plugin entry carries lspServers (golden)', () => {
    const e = JSON.parse(plug(null, [LSP]).after).extraKnownMarketplaces[N(LSP)];
    expect(e).toEqual(entryOf(N(LSP), { name: 'typescript-lsp', source: LSP.source, lspServers: LSP.lspServers }));
  });

  it('the pins entry has only documented fields', () => {
    const e = JSON.parse(plug(null, [GH, SUB, LSP]).after).extraKnownMarketplaces[N(GH, SUB, LSP)];
    expect(Object.keys(e)).toEqual(['source']);
    expect(Object.keys(e.source).sort()).toEqual(['name', 'owner', 'plugins', 'source']);
    for (const p of e.plugins ?? e.source.plugins) expect(Object.keys(p).every((k) => ['name', 'source', ...(p.name === 'typescript-lsp' ? ['lspServers'] : [])].includes(k))).toBe(true);
    expect(e.source.plugins.filter((p: any) => 'lspServers' in p).map((p: any) => p.name)).toEqual(['typescript-lsp']);
  });

  it('re-merge with recorded replaces the marketplace entry and drops removed plugins', () => {
    const first = plug(null, [GH, SUB, GAMMA]);
    const r = plug(first.after, [GH, SUB], first.blocks);
    const s = JSON.parse(r.after);
    const M = N(GH, SUB);
    expect(Object.keys(s.enabledPlugins)).toEqual([`alpha@${M}`, `beta@${M}`]);
    expect(Object.keys(s.extraKnownMarketplaces)).toEqual([M]);
    expect(s.extraKnownMarketplaces[M].source.plugins.map((p: any) => p.name)).toEqual(['alpha', 'beta']);
    const oldMarket = first.blocks.find((b) => b.includes('"marketplace"'))!;
    const gammaBlock = first.blocks.find((b) => b.includes('gamma@'))!;
    // the name follows the pins, so every plugin key is re-recorded under it
    expect([...r.dropped].sort()).toEqual(first.blocks.filter((b) => b.includes('"marketplace"') || b.includes('"plugin"')).sort());
    expect(r.dropped).toEqual(expect.arrayContaining([oldMarket, gammaBlock]));
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

  it('a pin change over a user-edited pins entry refuses, naming it and the fix', () => {
    const first = plug(null, [GH]);
    const edited = JSON.parse(first.after);
    edited.extraKnownMarketplaces[N(GH)].source.owner.name = 'me';
    expect(() => plug(JSON.stringify(edited, null, 2), [GH, SUB], first.blocks)).toThrow(new MergeError(`\`.claude/settings.json\`: the ${N(GH)} marketplace was edited, so harness can't change the plugin pins. Undo the edit, or delete that entry, then run /harness:sync.`));
    // with the same pins nothing changes, so the edit is only noted
    expect(plug(JSON.stringify(edited, null, 2), [GH], first.blocks).notes).toEqual([`\`.claude/settings.json\`: the ${N(GH)} marketplace was edited; left as is. harness doctor checks it.`]);
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
    const G = `gamma@${N(GH, GAMMA)}`;
    edited.enabledPlugins[G] = false;
    const r = plug(JSON.stringify(edited, null, 2), [GH], first.blocks);
    const gamma = first.blocks.find((b) => b.includes(G))!;
    expect(JSON.parse(r.after).enabledPlugins[G]).toBe(false);
    expect(r.notes).toContain(`\`.claude/settings.json\`: \`${G}\` was changed; left as is.`);
    expect(r.dropped).not.toContain(gamma);
    const notes: string[] = [];
    const out = removeFromSettings(r.after, FILE('.claude/settings.json', fold(first.blocks, r)), null, notes)!;
    expect(JSON.parse(out.after).enabledPlugins).toEqual({ [G]: false });
    expect(notes).toContain(`\`.claude/settings.json\`: \`${G}\` was changed; left as is.`);
  });

  it('a recorded plugin the person removed is dropped without a note', () => {
    const first = plug(null, [GH, GAMMA]);
    const edited = JSON.parse(first.after);
    delete edited.enabledPlugins[`gamma@${N(GH, GAMMA)}`];
    const r = plug(JSON.stringify(edited), [GH], first.blocks);
    expect(r.dropped).toContain(first.blocks.find((b) => b.includes('gamma@')));
    expect(r.notes).toEqual([]);
  });

  it('plugin entries leave the ConfigChange guarded view unchanged', () => {
    const base = merge(null).after;
    expect(guardedView(plug(base, [GH, SUB, LSP]).after, null)).toEqual(guardedView(base, null));
  });

  it('the name is a hash of the pins: same pins, same name in any order; different pins, different names', () => {
    expect(N(GH, SUB)).toMatch(/^harness-pins-[0-9a-f]{12}$/);
    expect(N(SUB, GH)).toBe(N(GH, SUB));
    expect(N(GH)).not.toBe(N(GH, SUB));
    expect(N({ ...GH, source: { ...GH.source, sha: 'e'.repeat(40) } })).not.toBe(N(GH));
    expect(N({ ...LSP, item: 'other-id' })).toBe(N(LSP)); // the catalog id is not part of the pins
    const flipped = { ...LSP, lspServers: { typescript: { extensionToLanguage: { '.ts': 'typescript' }, args: ['--stdio'], command: 'tsls' } } };
    expect(N(flipped)).toBe(N(LSP)); // key order does not change the name
  });

  it('a re-merge with the same pins changes nothing', () => {
    const a = plug(null, [GH, SUB]);
    const again = plug(a.after, [GH, SUB], a.blocks);
    expect(again.market).toBe(a.market);
    expect(again.after).toBe(a.after);
    expect(again.blocks).toEqual([]);
    expect(again.dropped).toEqual([]);
  });

  it('a pin change renames the entry and every key in place, with nothing left of the old name', () => {
    const before = canon({ enabledPlugins: { 'foo@other': true } });
    const first = plug(before, [GH, SUB]);
    const s0 = JSON.parse(first.after);
    s0.enabledPlugins = { [`alpha@${first.market}`]: true, 'foo@other': true, [`beta@${first.market}`]: true };
    const GH2 = { ...GH, source: { ...GH.source, sha: 'e'.repeat(40) } };
    const r = plug(canon(s0), [GH2, SUB], first.blocks);
    const M = N(GH2, SUB);
    const s = JSON.parse(r.after);
    expect(Object.keys(s.enabledPlugins)).toEqual([`alpha@${M}`, 'foo@other', `beta@${M}`]);
    expect(Object.keys(s.extraKnownMarketplaces)).toEqual([M]);
    expect(r.after).not.toContain(first.market);
    const rec = fold(first.blocks, r);
    expect(rec.join()).not.toContain(first.market);
    expect(r.notes).toEqual([]);
  });

  it('an install on the shared harness-pins name moves to the content name in place; uninstall removes the new names', () => {
    const before = canon({ enabledPlugins: { 'foo@other': true }, extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'x/y' } } } });
    const old = legacy(plug(before, [GH, SUB]));
    const s0 = JSON.parse(old.after);
    s0.enabledPlugins = { 'alpha@harness-pins': true, 'foo@other': true, 'beta@harness-pins': true }; // harness's keys around the person's
    const r = plug(canon(s0), [GH, SUB], old.blocks);
    const M = N(GH, SUB);
    const s = JSON.parse(r.after);
    expect(Object.keys(s.enabledPlugins)).toEqual([`alpha@${M}`, 'foo@other', `beta@${M}`]);
    expect(Object.keys(s.extraKnownMarketplaces)).toEqual(['other', M]);
    expect(s.extraKnownMarketplaces[M].source.name).toBe(M);
    expect(r.notes).toEqual([]);
    expect([...r.dropped].sort()).toEqual(old.blocks.filter((b) => b.includes('"harness-pins"') || b.includes('@harness-pins"')).sort());
    expect(r.after).not.toMatch(/"harness-pins"|@harness-pins"/);
    const notes: string[] = [];
    const out = removeFromSettings(r.after, FILE('.claude/settings.json', fold(old.blocks, r)), null, notes)!;
    expect(JSON.parse(out.after).enabledPlugins).toEqual({ 'foo@other': true });
    expect(Object.keys(JSON.parse(out.after).extraKnownMarketplaces)).toEqual(['other']);
    expect(notes).toEqual([]);
  });

  it('migration run twice changes nothing the second time', () => {
    const old = legacy(plug(null, [GH, GAMMA]));
    const once = plug(old.after, [GH, GAMMA], old.blocks);
    const twice = plug(once.after, [GH, GAMMA], fold(old.blocks, once));
    expect(twice.after).toBe(once.after);
    expect(twice.blocks).toEqual([]);
    expect(twice.dropped).toEqual([]);
    expect(twice.notes).toEqual([]);
  });

  it('an edited shared harness-pins entry refuses the move; nothing is changed', () => {
    const old = legacy(plug(null, [GH, GAMMA]));
    const s0 = JSON.parse(old.after);
    s0.extraKnownMarketplaces['harness-pins'].source.owner.name = 'me';
    expect(() => plug(JSON.stringify(s0, null, 2), [GH, GAMMA], old.blocks)).toThrow(/the harness-pins marketplace was edited, so harness can't change the plugin pins/);
  });

  it('settingsPins names the one content-named entry; two of them, or an unreadable settings file, refuse', () => {
    const one = JSON.parse(plug(null, [GH]).after);
    expect(settingsPins(one)).toBe(N(GH));
    expect(settingsPins({})).toBe('harness-pins');
    const two = { extraKnownMarketplaces: { [N(GH)]: {}, [N(SUB)]: {} } };
    expect(() => settingsPins(two)).toThrow(new MergeError(`\`.claude/settings.json\` has two harness pins marketplaces, ${N(GH)} and ${N(SUB)}; keep the one your plugin keys use and delete the other, then run /harness:sync.`));
    const root = mkdtempSync(join(tmpdir(), 'pins-'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), '{ nope');
    expect(() => pinsAt(root)).toThrow(/`.claude\/settings.json` could not be read/);
  });

  it('the name hashes every field of each entry but the item id; harness-rendered names are unchanged (golden)', () => {
    expect(N(GH, LSP)).toBe('harness-pins-1b5a2fd46603'); // the round-2 formula's name: existing installs keep theirs
    expect(N({ ...GH, strict: false })).not.toBe(N(GH));
    expect(N({ ...GH, hooks: { Stop: [] } })).not.toBe(N(GH));
    const e = JSON.parse(plug(null, [GH, LSP]).after).extraKnownMarketplaces[N(GH, LSP)];
    expect(N(...e.source.plugins)).toBe(N(GH, LSP)); // the rendered entry hashes back to its name
  });

  it('pinsMismatch flags a hand-added field in a plugin entry', () => {
    const s = JSON.parse(plug(null, [GH]).after);
    s.extraKnownMarketplaces[N(GH)].source.plugins[0].commands = ['./evil'];
    expect(pinsMismatch(s)).toEqual([N(GH)]);
  });

  it('pinsMismatch lists content-named entries whose name no longer matches their pins', () => {
    const s = JSON.parse(plug(null, [GH]).after);
    expect(pinsMismatch(s)).toEqual([]);
    s.extraKnownMarketplaces[N(GH)].source.plugins[0].source.sha = 'f'.repeat(40);
    expect(pinsMismatch(s)).toEqual([N(GH)]);
  });

  it('a changed old key of a still-picked plugin moves to the new name with its value', () => {
    const old = legacy(plug(null, [GH, GAMMA]));
    const s0 = JSON.parse(old.after);
    s0.enabledPlugins['gamma@harness-pins'] = false;
    const r = plug(JSON.stringify(s0, null, 2), [GH, GAMMA], old.blocks);
    const M = N(GH, GAMMA);
    expect(JSON.parse(r.after).enabledPlugins).toEqual({ [`alpha@${M}`]: true, [`gamma@${M}`]: false });
    expect(r.notes).toEqual([]);
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
      { name: 'beta', item: 'b', source: { source: 'git-subdir', url: 'https://github.com/o/mono.git', path: 'p/b', sha: 'b'.repeat(40) }, lspServers: { x: { command: 'y' } } },
      { name: 'xs', item: 'x', source: { source: 'git-subdir', url: 'https://github.com/o/mono.git', path: 'skills/x', sha: 'c'.repeat(40) } },
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

  it('STRUCTURAL names the three structural files', () => {
    expect([...STRUCTURAL].sort()).toEqual(['.claude/settings.json', '.mcp.json', 'tsconfig.json']);
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
      expect(JSON.parse(m.after).sandbox).toEqual({ filesystem: { denyWrite: denyWritePaths() } }); // only the denyWrite paths every mode writes
      expect(JSON.parse(m.after).attribution).toBe(false);
      expect(envOf(m.after)).toEqual({ DO_NOT_TRACK: '1', B_OFF: 'x' });
      expect(m.dropped.filter((b) => b.startsWith('{"set"')).every((b) => b.includes('"sandbox"'))).toBe(true);
    }
  });
});

describe('mergeEslintHarnessRules', () => {
  const IMPORT = "// harness:rules\nimport harnessRules from './.harness/eslint/harness.config.mjs';\n// harness:rules\n";
  it('adds the import after the last import and the spread at the end of the array, both marked', () => {
    const src = "import js from '@eslint/js';\n\nexport default [\n  js.configs.recommended,\n  { ignores: ['.harness/'] },\n];\n";
    const r = mergeEslintHarnessRules(src)!;
    expect(r.after).toBe(
      "import js from '@eslint/js';\n" + IMPORT + "\nexport default [\n  js.configs.recommended,\n  { ignores: ['.harness/'] },\n  // harness:rules\n  ...harnessRules,\n  // harness:rules\n];\n",
    );
    expect(r.blocks).toHaveLength(2);
    expect(removeBlocks(r.after, r.blocks)).toBe(src);
    expect(mergeEslintHarnessRules(r.after)).toEqual({ after: r.after, blocks: [] });
  });
  it('no trailing comma, one-line and empty arrays, defineConfig and identifier exports, CRLF', () => {
    for (const src of [
      'export default [\n  { rules: {} }\n];\n',
      'export default [{ rules: {} }];\n',
      'export default [];\n',
      "import { defineConfig } from 'eslint/config';\nexport default defineConfig([{ rules: {} }]);\n",
      'const cfg = [{ rules: {} }];\nexport default cfg;\n',
      "import a from 'a';\r\nexport default [\r\n  a,\r\n];\r\n",
    ]) {
      const r = mergeEslintHarnessRules(src)!;
      expect(r, src).not.toBeNull();
      expect(r.after).toContain('...harnessRules');
      expect(removeBlocks(r.after, r.blocks)).toBe(src);
    }
    expect(mergeEslintHarnessRules('export default [\n  { rules: {} }\n];\n')!.after).toBe(`${IMPORT}export default [\n  { rules: {} },\n  // harness:rules\n  ...harnessRules,\n  // harness:rules\n];\n`);
    expect(mergeEslintHarnessRules('export default [{ rules: {} }];\n')!.after).toBe(`${IMPORT}export default [{ rules: {} },\n// harness:rules\n...harnessRules,\n// harness:rules\n];\n`);
  });
  it('uses the file\'s quotes', () => {
    expect(mergeEslintHarnessRules('import a from "a";\nexport default [a];\n')!.after).toContain('import harnessRules from "./.harness/eslint/harness.config.mjs";');
  });
  it('a trailing comment stays on the last element\'s line', () => {
    const src = 'export default [\n  a, // last\n];\n';
    const r = mergeEslintHarnessRules(src)!;
    expect(r.after).toBe(`${IMPORT}export default [\n  a, // last\n  // harness:rules\n  ...harnessRules,\n  // harness:rules\n];\n`);
    expect(removeBlocks(r.after, r.blocks)).toBe(src);
    // ponytail shape: no comma before the comment would need a second insert, so it is a manual step
    expect(mergeEslintHarnessRules('export default [\n  a // last\n];\n')).toBeNull();
  });
  it('appending after the closing marker, or a trailing-comma-all reformat, leaves both blocks intact', () => {
    for (const src of ['export default [\n  a\n];\n', 'export default [\n  a,\n];\n', 'export default [a];\n']) {
      const r = mergeEslintHarnessRules(src)!;
      // what a person (or Prettier's trailingComma: all) does: every element line ends in a comma, and more go after the marker
      expect(r.after, src).toMatch(/\.\.\.harnessRules,\n/);
      expect(r.after, src).toMatch(/\ba,/);
      const appended = r.after.replace(/(\/\/ harness:rules\n)(\s*\];)/, '$1  b,\n$2');
      expect(appended).not.toBe(r.after);
      expect(r.blocks.every((b) => appended.includes(b)), src).toBe(true);
    }
  });
  it('a stray or half-removed marker is null, never a no-op', () => {
    expect(mergeEslintHarnessRules("export default [{ ignores: ['// harness:rules'] }];\n")).toBeNull();
    const done = mergeEslintHarnessRules('export default [\n  a,\n];\n')!.after;
    expect(mergeEslintHarnessRules(done.replace("import harnessRules from './.harness/eslint/harness.config.mjs';\n", ''))).toBeNull();
    expect(mergeEslintHarnessRules(done.replace('  ...harnessRules,\n', ''))).toBeNull();
  });
  it('accepts only defineConfig(...) and *.config(...) wrappers', () => {
    expect(mergeEslintHarnessRules('export default tseslint.config([a]);\n')).not.toBeNull();
    expect(mergeEslintHarnessRules('export default whatever([a]);\n')).toBeNull();
    expect(mergeEslintFlatIgnores('export default whatever([a]);\n')).toBeNull();
  });
  it('null when the shape is not a flat-config array', () => {
    expect(mergeEslintHarnessRules('export default makeConfig();\n')).toBeNull();
    expect(mergeEslintHarnessRules('module.exports = [];\n')).toBeNull();
    expect(mergeEslintHarnessRules('export default [ {{{')).toBeNull();
  });
});

describe('mergeTsconfigOptions / removeFromTsconfig', () => {
  const OPTS = { strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true, noFallthroughCasesInSwitch: true, noImplicitReturns: true } as const;
  const set = (k: string) => JSON.stringify({ set: ['compilerOptions', k], value: true });
  const F = (blocks: string[]) => ({ rel: 'tsconfig.json', kind: 'update' as const, hash: '', blocks });
  const PLAIN = '{\n  "compilerOptions": {\n    "target": "es2022"\n  },\n  "include": ["src"]\n}\n';

  it('sets each option with one set block, and removal gives back the same JSON', () => {
    const r = mergeTsconfigOptions(PLAIN, OPTS)!;
    expect(JSON.parse(r.after).compilerOptions).toEqual({ target: 'es2022', ...OPTS });
    expect(r.blocks).toEqual(Object.keys(OPTS).map(set));
    const notes: string[] = [];
    const out = removeFromTsconfig(r.after, F(r.blocks), PLAIN, notes)!;
    expect(JSON.parse(out.after)).toEqual(JSON.parse(PLAIN));
    expect(notes).toEqual([]);
  });

  it('leaves a key already set to any value alone', () => {
    const before = JSON.stringify({ compilerOptions: { strict: false, noImplicitReturns: true } }, null, 2) + '\n';
    const r = mergeTsconfigOptions(before, OPTS)!;
    expect(JSON.parse(r.after).compilerOptions.strict).toBe(false);
    expect(r.blocks).toEqual(['noUncheckedIndexedAccess', 'noImplicitOverride', 'noFallthroughCasesInSwitch'].map(set));
  });

  it('creates a missing compilerOptions, recorded, and removal drops it again', () => {
    const before = '{ "include": ["src"] }';
    const r = mergeTsconfigOptions(before, { strict: true })!;
    expect(r.blocks).toEqual([JSON.stringify({ set: ['compilerOptions'], value: {} }), set('strict')]);
    expect(JSON.parse(removeFromTsconfig(r.after, F(r.blocks), before, [])!.after)).toEqual({ include: ['src'] });
  });

  it('nothing to set gives back the bytes', () => {
    const before = '{"compilerOptions":{"strict":true}}';
    expect(mergeTsconfigOptions(before, { strict: true })).toEqual({ after: before, blocks: [] });
  });

  it.each([
    ['a comment', '{\n  // mine\n  "compilerOptions": {}\n}\n'],
    ['a trailing comma', '{ "compilerOptions": { "target": "es2022", } }'],
    ['not an object', '[]'],
    ['a non-object compilerOptions', '{ "compilerOptions": 1 }'],
  ])('%s gives null', (_n, before) => {
    expect(mergeTsconfigOptions(before, OPTS)).toBeNull();
  });

  it('removal keeps an option the person changed, with a note, and the person\'s new keys', () => {
    const r = mergeTsconfigOptions(PLAIN, OPTS)!;
    const edited = JSON.parse(r.after);
    edited.compilerOptions.noImplicitReturns = false;
    edited.compilerOptions.mine = 1;
    const notes: string[] = [];
    const out = removeFromTsconfig(JSON.stringify(edited, null, 2) + '\n', F(r.blocks), PLAIN, notes)!;
    expect(JSON.parse(out.after).compilerOptions).toEqual({ target: 'es2022', noImplicitReturns: false, mine: 1 });
    expect(notes).toEqual(['`tsconfig.json`: `compilerOptions.noImplicitReturns` was changed; left as is.']);
    expect(removeFromTsconfig('{ // x\n}', F(r.blocks), PLAIN, [])).toBeNull();
  });
});
