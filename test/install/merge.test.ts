import { readFileSync } from 'node:fs';
import { describe, expect, it, test } from 'vitest';
import { BETA_GROUPS, betaSettings } from './helpers.js';
import { MergeError, mergeAgents, mergeClaudeMd, mergeEslintFlatIgnores, mergeGitignore, mergeIgnoreFile, mergeSettings, removeBlocks } from '../../src/install/merge.js';

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
    expect(s.hooks.PreToolUse.map((g: any) => g.matcher)).toEqual(['Bash', 'Write', PRE]);
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[1].hooks[0].args).toEqual(ARGS);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    // blocks: 6 hook groups + deny rules not already present (29 of 30)
    const parsed = blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.event)).toHaveLength(6);
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

  it('a fresh file gets 6 group blocks and 30 deny blocks, nothing dropped', () => {
    const { after, blocks, dropped } = merge(null);
    const parsed = blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.event)).toHaveLength(6);
    expect(parsed.filter((b) => b.deny)).toHaveLength(30);
    expect(dropped).toEqual([]);
    expect(JSON.parse(after).hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'node', args: ARGS, timeout: 600 });
  });

  it('a foreign node exec hook survives init, update and uninstall', () => {
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['tools/lint-hook.mjs'] }] };
    const { after, blocks } = merge(JSON.stringify({ hooks: { PreToolUse: [foreign] } }));
    const s = JSON.parse(after);
    expect(s.hooks.PreToolUse).toEqual([foreign, frag.hooks.PreToolUse[0]]);
    expect(blocks).toContain(JSON.stringify({ event: 'PreToolUse', group: frag.hooks.PreToolUse[0] }));
  });

  it('beta groups are replaced in place', () => {
    const user = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
    const beta = betaSettings({ hooks: { PreToolUse: [user] } });
    const { after, blocks, dropped, notes } = merge(JSON.stringify(beta.s, null, 2) + '\n', beta.blocks);
    const s = JSON.parse(after);
    expect(notes).toEqual([]);
    expect(s.hooks.PreToolUse).toEqual([user, frag.hooks.PreToolUse[0]]);
    for (const ev of Object.keys(frag.hooks)) expect(s.hooks[ev].at(-1)).toEqual(frag.hooks[ev][0]);
    for (const ev of ['PostToolUse', 'UserPromptSubmit', 'ConfigChange', 'Stop', 'SessionEnd']) expect(s.hooks[ev]).toHaveLength(1);
    expect(dropped).toEqual(Object.entries(BETA_GROUPS).map(([event, group]) => JSON.stringify({ event, group })));
    const parsed = blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.event).map((b) => b.event)).toEqual(Object.keys(frag.hooks));
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
    expect(s.hooks.PreToolUse).toHaveLength(1);
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
  it('appends the three lines, once', () => {
    const { after, blocks } = mergeGitignore(fx('.gitignore'));
    expect(after).toBe('node_modules/\ndist/\n.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n');
    expect(blocks).toEqual(['.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n']);
    expect(mergeGitignore(after)).toEqual({ after, blocks: [] });
  });
  it('null creates; missing newline and CRLF handled; partial adds only missing', () => {
    expect(mergeGitignore(null).after).toBe('.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n');
    expect(mergeGitignore('a').blocks[0].startsWith('\n')).toBe(true);
    expect(mergeGitignore('a').after).toBe('a\n.harness/state/\n.harness/logs/\n.harness/backup/\n.harness/results/\n');
    expect(mergeGitignore('a\r\n').after).toBe('a\r\n.harness/state/\r\n.harness/logs/\r\n.harness/backup/\r\n.harness/results/\r\n');
    expect(mergeGitignore('.harness/logs/\n').blocks).toEqual(['.harness/state/\n.harness/backup/\n.harness/results/\n']);
  });
  it('mergeGitignore adds .harness/results/', () => {
    const r = mergeGitignore('.harness/state/\n.harness/logs/\n.harness/backup/\n');
    expect(r.blocks).toEqual(['.harness/results/\n']);
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
