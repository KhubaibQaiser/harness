import { readFileSync } from 'node:fs';
import { describe, expect, it, test } from 'vitest';
import { MergeError, mergeAgents, mergeClaudeMd, mergeEslintFlatIgnores, mergeGitignore, mergeIgnoreFile, mergeSettings, removeBlocks } from '../../src/install/merge.js';

const fx = (p: string) => readFileSync(`test/fixtures/install-repo/${p}`, 'utf8');
const DISPATCH = 'node "${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"';
const S = '<!-- harness:start -->';
const E = '<!-- harness:end -->';

describe('mergeSettings', () => {
  it('fixture: other tools hooks kept, dispatcher + deny added, rest kept', () => {
    const before = fx('.claude/settings.json');
    const { after, blocks, notes } = mergeSettings(before);
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
    expect(s.hooks.PreToolUse.map((g: any) => g.matcher)).toEqual(['Bash', 'Write', 'Bash|Read|Grep|Edit|Write|MultiEdit|NotebookEdit']);
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[1].hooks[0].command).toBe(DISPATCH);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    // blocks: 5 hook groups + deny rules not already present (7 of 8)
    const parsed = blocks.map((b) => JSON.parse(b));
    expect(parsed.filter((b) => b.event)).toHaveLength(5);
    expect(parsed.filter((b) => b.deny)).toHaveLength(7);
    expect(parsed.find((b) => b.event === 'Stop').group.hooks[0].command).toBe(DISPATCH);
  });

  it('null input creates a settings file', () => {
    const { after } = mergeSettings(null);
    expect(JSON.parse(after).hooks.Stop).toHaveLength(1);
    expect(after.endsWith('}\n')).toBe(true);
  });

  it('second run: unchanged, no blocks', () => {
    const first = mergeSettings(fx('.claude/settings.json')).after;
    const again = mergeSettings(first);
    expect(again.after).toBe(first);
    expect(again.blocks).toEqual([]);
  });

  it('hook command quotes a project dir with spaces', () => {
    const cmd = JSON.parse(mergeSettings(null).after).hooks.Stop[0].hooks[0].command as string;
    expect(cmd).toBe(DISPATCH);
    expect(cmd).toContain('"${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"');
    expect(cmd).not.toContain('\\');
  });

  it('null hook entry noted, not crashed', () => {
    const before = JSON.stringify({ hooks: { Stop: [null, { hooks: [null, { type: 'command', command: 'echo x' }] }, { matcher: 'x', hooks: 'bad' }] } });
    const { after, notes } = mergeSettings(before);
    const s = JSON.parse(after);
    expect(notes.length).toBeGreaterThanOrEqual(3);
    expect(notes.join('\n')).toMatch(/Stop/);
    expect(s.hooks.Stop.slice(0, 3)).toEqual(JSON.parse(before).hooks.Stop);
    expect(s.hooks.Stop[3].hooks[0].command).toBe(DISPATCH);
  });

  it('CRLF settings stay CRLF', () => {
    const before = '{\r\n  "model": "x"\r\n}\r\n';
    const { after } = mergeSettings(before);
    expect(after).toMatch(/\r\n/);
    expect(after.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(after.endsWith('}\r\n')).toBe(true);
  });

  it('tab-indented settings stay tab-indented', () => {
    const { after } = mergeSettings('{\n\t"model": "x"\n}\n');
    expect(after).toMatch(/^\t"model": "x",$/m);
    expect(after).not.toMatch(/^ +"/m);
  });

  it('no trailing newline stays none', () => {
    expect(mergeSettings('{"model":"x"}').after.endsWith('}')).toBe(true);
  });

  it('non-array hook event: noted, left untouched, others still added', () => {
    const before = '{"hooks":{"Stop":{"a":1}}}';
    const { after, notes } = mergeSettings(before);
    const s = JSON.parse(after);
    expect(s.hooks.Stop).toEqual({ a: 1 });
    expect(notes.join('\n')).toMatch(/hooks\.Stop is not an array/);
    expect(s.hooks.PreToolUse).toHaveLength(1);
  });

  it('invalid JSON: MergeError naming the file', () => {
    expect(() => mergeSettings('{ nope')).toThrow(MergeError);
    expect(() => mergeSettings('{ nope')).toThrow(/settings\.json/);
  });

  test.each([
    ['root array', '[]', /object/],
    ['hooks not object', '{"hooks":[]}', /hooks/],
    ['deny not array', '{"permissions":{"deny":"x"}}', /deny/],
    ['permissions not object', '{"permissions":[]}', /permissions/],
  ])('settings %s: clear MergeError', (_n, json, re) => {
    expect(() => mergeSettings(json)).toThrow(MergeError);
    expect(() => mergeSettings(json)).toThrow(re);
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
    expect(after).toBe('node_modules/\ndist/\n.harness/state/\n.harness/logs/\n.harness/backup/\n');
    expect(blocks).toEqual(['.harness/state/\n.harness/logs/\n.harness/backup/\n']);
    expect(mergeGitignore(after)).toEqual({ after, blocks: [] });
  });
  it('null creates; missing newline and CRLF handled; partial adds only missing', () => {
    expect(mergeGitignore(null).after).toBe('.harness/state/\n.harness/logs/\n.harness/backup/\n');
    expect(mergeGitignore('a').blocks[0].startsWith('\n')).toBe(true);
    expect(mergeGitignore('a').after).toBe('a\n.harness/state/\n.harness/logs/\n.harness/backup/\n');
    expect(mergeGitignore('a\r\n').after).toBe('a\r\n.harness/state/\r\n.harness/logs/\r\n.harness/backup/\r\n');
    expect(mergeGitignore('.harness/logs/\n').blocks).toEqual(['.harness/state/\n.harness/backup/\n']);
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
  it('computed eslint config returns null', () => {
    expect(mergeEslintFlatIgnores('export default makeConfig();\n')).toBeNull();
    expect(mergeEslintFlatIgnores("export default [{ ignores: IGN }];\n")).toBeNull();
    expect(mergeEslintFlatIgnores("export default [{ rules: {} }];\n")).toBeNull();
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
