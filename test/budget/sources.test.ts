import { mkdirSync, symlinkSync } from 'node:fs';
import { join, relative, win32 } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { insideWith, realIO, type RepoIO } from '../../src/budget/imports.js';
import { ownersFrom, type Owner } from '../../src/budget/owners.js';
import { absIn, measureRepo, type RepoMeasure } from '../../src/budget/sources.js';
import { CUT_CHARS, MAX_FILE_BYTES, stripComments } from '../../src/budget/text.js';
import type { Catalog } from '../../src/catalog/schema.js';
import type { Manifest } from '../../src/install/manifest.js';
import { makeRepo } from '../install/helpers.js';

type Opts = { owners?: Map<string, Owner>; preset?: string | null };
const measure = (files: Record<string, string>, o: Opts = {}, io?: RepoIO): RepoMeasure & { root: string } => {
  const root = makeRepo(files, { git: false });
  return { root, ...measureRepo(root, { owners: o.owners ?? new Map(), preset: o.preset ?? null }, io) };
};
const row = (r: RepoMeasure, label: string) => r.always.find((e) => e.label === label);
const labels = (r: RepoMeasure) => r.always.map((e) => e.label);
const SKILL = '---\nname: review-rubric\ndescription: Grades a diff against the rubric.\n---\nBODY\n';

test('CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md are each counted whole', () => {
  const r = measure({ 'CLAUDE.md': 'a'.repeat(40), '.claude/CLAUDE.md': 'b'.repeat(8), 'CLAUDE.local.md': 'c'.repeat(4) });
  expect(r.always.map((e) => [e.label, e.tokens, e.owner, e.load])).toEqual([
    ['CLAUDE.md', 10, 'repo', 'always'], ['.claude/CLAUDE.md', 2, 'repo', 'always'], ['CLAUDE.local.md', 1, 'repo', 'always'],
  ]);
});

test('a memory file over 4 MiB is sized, not read, and counts 0 with the note', () => {
  const read: string[] = [];
  const io: RepoIO = { ...realIO, read: (p) => { read.push(p); return realIO.read(p); }, size: (p) => (p.endsWith('CLAUDE.md') ? MAX_FILE_BYTES + 1 : realIO.size(p)) };
  const r = measure({ 'CLAUDE.md': 'x' }, {}, io);
  expect(row(r, 'CLAUDE.md')).toMatchObject({ tokens: 0, note: 'over 4 MiB: Claude Code skips it' });
  expect(read.filter((p) => p.endsWith('CLAUDE.md'))).toEqual([]);
});

test('a file over 40,000 characters gets the cut note and is counted whole', () => {
  const r = measure({ 'CLAUDE.md': 'a'.repeat(CUT_CHARS + 4) });
  expect(row(r, 'CLAUDE.md')).toMatchObject({ chars: CUT_CHARS + 4, note: 'over 40,000 characters: Claude Code cuts it there' });
});

test('AGENTS.md is counted directly when no root memory file exists', () => {
  const r = measure({ 'AGENTS.md': 'x'.repeat(8), '.claude/AGENTS.md': 'y'.repeat(4) });
  expect(r.always.map((e) => [e.label, e.tokens])).toEqual([['AGENTS.md', 2], ['.claude/AGENTS.md', 1]]);
});

test('AGENTS.md is counted through @AGENTS.md when CLAUDE.md exists', () => {
  const r = measure({ 'CLAUDE.md': 'see @AGENTS.md\n', 'AGENTS.md': 'x'.repeat(8) });
  expect(labels(r)).toEqual(['CLAUDE.md', 'AGENTS.md (imported by CLAUDE.md)']);
  expect(row(r, 'AGENTS.md (imported by CLAUDE.md)')).toMatchObject({ path: 'AGENTS.md', tokens: 2, owner: 'repo' });
});

test('AGENTS.md imported from two root files is counted once', () => {
  const r = measure({ 'CLAUDE.md': '@AGENTS.md\n', '.claude/CLAUDE.md': '@../AGENTS.md\n', 'CLAUDE.local.md': '@AGENTS.md', 'AGENTS.md': 'x'.repeat(8) });
  expect(r.always.filter((e) => e.path === 'AGENTS.md')).toHaveLength(1);
});

test('CLAUDE.local.md alone stops the direct AGENTS.md read', () => {
  const r = measure({ 'CLAUDE.local.md': 'mine', 'AGENTS.md': 'x'.repeat(8) });
  expect(labels(r)).toEqual(['CLAUDE.local.md']);
});

test('a directory named CLAUDE.md does not stop the direct AGENTS.md read', () => {
  const root = makeRepo({ 'AGENTS.md': 'x'.repeat(8) }, { git: false });
  mkdirSync(join(root, 'CLAUDE.md'));
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(r.always.map((e) => e.label)).toEqual(['AGENTS.md']);
});

const AGENTS = 'repo text\n\n<!-- harness:start -->\n\nBLOCK\n\n<!-- harness:end -->\n';
const PRESET = '<!-- harness:preset:start -->\n\nPRE\n\n<!-- harness:preset:end -->\n';

test('the harness block is its own harness entry, its markers count 0, and it is not in the repo row', () => {
  const r = measure({ 'AGENTS.md': AGENTS });
  expect(row(r, 'AGENTS.md harness block')).toMatchObject({ owner: 'harness', path: 'AGENTS.md', chars: '\nBLOCK\n'.length });
  expect(row(r, 'AGENTS.md')).toMatchObject({ owner: 'repo', chars: 'repo text\n\n\n'.length });
});

test('the harness block of an imported AGENTS.md is split out too', () => {
  const r = measure({ 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': AGENTS });
  expect(row(r, 'AGENTS.md harness block')).toMatchObject({ owner: 'harness', chars: '\nBLOCK\n'.length });
  expect(row(r, 'AGENTS.md (imported by CLAUDE.md)')).toMatchObject({ chars: 'repo text\n\n\n'.length });
});

const MANIFEST: Manifest = { version: '1', createdAt: '', files: [
  { rel: 'CLAUDE.md', kind: 'update', hash: 'h', blocks: ['\n@AGENTS.md\n'] },
  { rel: 'AGENTS.md', kind: 'create', hash: 'h', blocks: [AGENTS] },
  { rel: '.claude/skills/review-rubric/SKILL.md', kind: 'create', hash: 'h', item: 'review-rubric' },
  { rel: '.claude/skills/shadcn/SKILL.md', kind: 'create', hash: 'h', item: 'shadcn' },
  { rel: '.claude/skills/fe-style/SKILL.md', kind: 'create', hash: 'h', item: 'preset:khubaib-frontend' },
] };
const CATALOG = { version: 1, items: [{ id: 'review-rubric', source: { type: 'own' } }, { id: 'shadcn', source: { type: 'github' } }] } as unknown as Catalog;
const OWNERS = ownersFrom(MANIFEST, CATALOG);

test('the preset block is a preset:<id> entry', () => {
  const r = measure({ 'AGENTS.md': AGENTS + '\n' + PRESET, '.claude/skills/fe-style/SKILL.md': SKILL }, { owners: OWNERS, preset: 'khubaib-frontend' });
  expect(row(r, 'AGENTS.md preset block')).toMatchObject({ owner: 'preset:khubaib-frontend', chars: '\nPRE\n'.length });
  expect(row(r, 'AGENTS.md')?.chars).toBe('repo text\n\n\n\n\n'.length);
});

test('with no preset id, a recorded AGENTS.md preset block is harness\'s, with a note', () => {
  const r = measure({ 'AGENTS.md': PRESET, '.claude/skills/fe-style/SKILL.md': SKILL }, { owners: OWNERS });
  expect(row(r, 'AGENTS.md preset block')).toMatchObject({ owner: 'harness', note: 'preset id not recorded', chars: '\nPRE\n'.length });
  expect(JSON.stringify(r)).not.toContain('preset:unknown');
});

test('with no AGENTS.md in the manifest, the preset block stays in the repo row', () => {
  const r = measure({ 'AGENTS.md': PRESET }, { preset: 'khubaib-frontend' });
  expect(labels(r)).toEqual(['AGENTS.md']);
  expect(row(r, 'AGENTS.md')).toMatchObject({ owner: 'repo', chars: stripComments(PRESET).length });
});

test('a CLAUDE.md that links to AGENTS.md still has its harness block split out', () => {
  const root = makeRepo({ 'AGENTS.md': AGENTS }, { git: false });
  symlinkSync(join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'));
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(row(r, 'CLAUDE.md harness block')).toMatchObject({ owner: 'harness', chars: '\nBLOCK\n'.length });
  expect(row(r, 'CLAUDE.md')).toMatchObject({ owner: 'repo', chars: 'repo text\n\n\n'.length });
});

test('a harness block in an imported file that is not AGENTS.md is split out too', () => {
  const r = measure({ 'CLAUDE.md': '@docs/agents.md', 'docs/agents.md': AGENTS });
  expect(row(r, 'docs/agents.md harness block')).toMatchObject({ owner: 'harness', chars: '\nBLOCK\n'.length });
});

test('the recorded @AGENTS.md line in CLAUDE.md is its own harness entry', () => {
  const r = measure({ 'CLAUDE.md': 'rules\n\n@AGENTS.md\n', 'AGENTS.md': 'x' }, { owners: OWNERS });
  expect(row(r, 'CLAUDE.md line @AGENTS.md')).toMatchObject({ owner: 'harness', path: 'CLAUDE.md', tokens: 3 });
  expect(row(r, 'CLAUDE.md')).toMatchObject({ owner: 'repo', chars: 'rules\n\n'.length });
  const plain = measure({ 'CLAUDE.md': 'rules\n\n@AGENTS.md\n', 'AGENTS.md': 'x' });
  expect(row(plain, 'CLAUDE.md line @AGENTS.md')).toBeUndefined();
  expect(row(plain, 'CLAUDE.md')?.chars).toBe('rules\n\n@AGENTS.md\n'.length);
});

test('rules: no paths (also in a subfolder) are always loaded without frontmatter; paths lists and comma strings are not', () => {
  const r = measure({
    '.claude/rules/style.md': '---\ndescription: d\n---\nBODY',
    '.claude/rules/sub/deep.md': 'DEEP',
    '.claude/rules/api.md': '---\npaths:\n  - src/api/**\n---\nAPI',
    '.claude/rules/web.md': '---\npaths: "src/a/**, src/b/**"\n---\nWEB',
    '.claude/rules/notes.txt': 'not a rule',
  });
  expect(labels(r).sort()).toEqual(['.claude/rules/style.md', '.claude/rules/sub/deep.md']);
  expect(row(r, '.claude/rules/style.md')).toMatchObject({ chars: 4, owner: 'repo' });
});

test('a rule with bad frontmatter is counted whole, with the note', () => {
  const text = '---\npaths: [unclosed\n---\nBODY';
  const r = measure({ '.claude/rules/bad.md': text });
  expect(row(r, '.claude/rules/bad.md')).toMatchObject({ chars: text.length, note: 'frontmatter does not parse; counted whole' });
});

const VALUES: [string, string | null][] = [['on', null], ['name-only', 'name: review-rubric'], ['off', 'dropped'], ['user-invocable-only', 'dropped']];
for (const where of ['.claude/settings.json', '.claude/settings.local.json']) {
  for (const [value, want] of VALUES) {
    test(`skillOverrides ${value} in ${where}`, () => {
      const r = measure({ '.claude/skills/review-rubric/SKILL.md': SKILL, [where]: JSON.stringify({ skillOverrides: { 'review-rubric': value } }) });
      const e = row(r, 'skill review-rubric');
      if (want === 'dropped') expect(e).toBeUndefined();
      else if (want) expect(e).toMatchObject({ chars: want.length });
      else expect(e?.chars).toBe('name: review-rubric\ndescription: Grades a diff against the rubric.'.length);
    });
  }
}

test('local skillOverrides win over project ones', () => {
  const r = measure({
    '.claude/skills/review-rubric/SKILL.md': SKILL,
    '.claude/settings.json': JSON.stringify({ skillOverrides: { 'review-rubric': 'off' } }),
    '.claude/settings.local.json': JSON.stringify({ skillOverrides: { 'review-rubric': 'name-only' } }),
  });
  expect(row(r, 'skill review-rubric')?.chars).toBe('name: review-rubric'.length);
});

test('settings that do not parse leave skills counted, with a note', () => {
  const r = measure({ '.claude/skills/review-rubric/SKILL.md': SKILL, '.claude/settings.json': '{ nope' });
  expect(row(r, 'skill review-rubric')?.tokens).toBeGreaterThan(0);
  expect(r.notes).toContain('.claude/settings.json: not valid JSON, not read');
});

test('a skill with disable-model-invocation counts 0', () => {
  const r = measure({ '.claude/skills/a/SKILL.md': '---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\n' });
  expect(row(r, 'skill a')?.tokens).toBe(0);
});

test('skillOverrides does not touch commands (unverified for them, so they stay counted)', () => {
  const r = measure({ '.claude/commands/ship.md': '---\ndescription: Ship it.\n---\n', '.claude/settings.json': JSON.stringify({ skillOverrides: { ship: 'off' } }) });
  expect(row(r, 'command ship')?.chars).toBe('description: Ship it.'.length);
});

test('a file imported twice through a symlink is counted once, and its imports once', () => {
  const root = makeRepo({ 'CLAUDE.md': '@docs/a.md @docs/b.md', 'docs/a.md': 'AAAA @c.md', 'docs/c.md': 'CCCC' }, { git: false });
  symlinkSync(join(root, 'docs', 'a.md'), join(root, 'docs', 'b.md'));
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(labels(r)).toEqual(['CLAUDE.md', 'docs/a.md (imported by CLAUDE.md)', 'docs/c.md (imported by docs/a.md)']);
});

test('a skill that CLAUDE.md imports keeps its listing row', () => {
  const r = measure({ 'CLAUDE.md': '@.claude/skills/s/SKILL.md', '.claude/skills/s/SKILL.md': '---\nname: s\ndescription: d\n---\nbody' });
  expect(labels(r)).toEqual(['CLAUDE.md', '.claude/skills/s/SKILL.md (imported by CLAUDE.md)', 'skill s']);
});

test('an oversized rule, skill, command or agent is not measured, not counted 0', () => {
  const big = new Set(['.claude/rules/r.md', '.claude/skills/s/SKILL.md', '.claude/commands/c.md', '.claude/agents/a.md', 'AGENTS.md']);
  const files = Object.fromEntries([...big].map((k) => [k, 'x']));
  const root = makeRepo(files, { git: false });
  const io: RepoIO = { ...realIO, size: (p) => ([...big].some((b) => p.endsWith(join(...b.split('/')))) ? MAX_FILE_BYTES + 1 : realIO.size(p)) };
  const r = measureRepo(root, { owners: new Map(), preset: null }, io);
  expect(r.always).toEqual([]);
  expect(r.unmeasured.sort()).toEqual([...big].map((b) => `${b}: oversize`).sort());
});

test('a command file and an agent are counted by their name and description', () => {
  const r = measure({
    '.claude/commands/ship.md': '---\ndescription: Ship it.\n---\nlong body',
    '.claude/agents/staff-reviewer.md': '---\nname: staff-reviewer\ndescription: Reviews.\ntools: Read\n---\nbody',
  });
  expect(row(r, 'command ship')).toMatchObject({ chars: 'description: Ship it.'.length, path: '.claude/commands/ship.md' });
  expect(row(r, 'agent staff-reviewer')).toMatchObject({ chars: 'name: staff-reviewer\ndescription: Reviews.'.length });
});

test('a skill whose frontmatter does not parse is not measured', () => {
  const r = measure({ '.claude/skills/x/SKILL.md': '---\nname: [x\n---\n' });
  expect(row(r, 'skill x')).toBeUndefined();
  expect(r.unmeasured).toEqual(['.claude/skills/x/SKILL.md: frontmatter does not parse']);
});

test('owners come from the manifest: own item harness, catalog item, preset item', () => {
  const r = measure({
    '.claude/skills/review-rubric/SKILL.md': SKILL, '.claude/skills/shadcn/SKILL.md': SKILL, '.claude/skills/fe-style/SKILL.md': SKILL, '.claude/skills/mine/SKILL.md': SKILL,
  }, { owners: OWNERS });
  expect(Object.fromEntries(r.always.map((e) => [e.label, e.owner]))).toEqual({
    'skill fe-style': 'preset:khubaib-frontend', 'skill mine': 'repo', 'skill review-rubric': 'harness', 'skill shadcn': 'catalog:shadcn',
  });
});

test('skipped and external imports are listed as not measured, never counted', () => {
  const r = measure({ 'CLAUDE.md': '@bin.md @secret.md @../out.md', 'bin.md': 'a\0b', 'secret.md': 's', '.harnessignore': 'secret.md\n' });
  expect(labels(r)).toEqual(['CLAUDE.md']);
  expect(r.unmeasured.sort()).toEqual(['external import: ../out.md', 'import bin.md (in CLAUDE.md): binary', 'import secret.md (in CLAUDE.md): ignored']);
});

test('an ignored or binary root file is not measured', () => {
  const r = measure({ 'CLAUDE.md': 'x\0', '.claude/rules/r.md': 'R', '.harnessignore': '.claude/rules/\n' });
  expect(r.always).toEqual([]);
  expect(r.unmeasured.sort()).toEqual(['.claude/rules: ignored', 'CLAUDE.md: binary']);
});

const HOME = process.env.HOME;
afterEach(() => { process.env.HOME = HOME; });

test('Review focus 1: nothing outside the root is touched, and HOME changes nothing', () => {
  const outside = makeRepo({ 'secret.md': 'S', 'CLAUDE.md': 'home memory', '.claude/CLAUDE.md': 'home', 'r/x.md': 'X' }, { git: false });
  const files = { 'CLAUDE.md': '@../../etc/passwd @~/.claude/CLAUDE.md @AGENTS.md', 'AGENTS.md': 'A', '.claude/rules/in.md': 'IN' };
  const seen: string[] = [];
  const rec = (f: (p: string) => unknown) => (p: string) => { seen.push(p); return f(p); };
  const sized: string[] = [];
  const io: RepoIO = { read: rec(realIO.read) as RepoIO['read'], size: rec((p) => { sized.push(p); return realIO.size(p); }) as RepoIO['size'], real: rec(realIO.real) as RepoIO['real'], list: rec(realIO.list) as RepoIO['list'], lsFiles: rec(realIO.lsFiles) as RepoIO['lsFiles'] };
  const root = makeRepo(files, { git: false });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  symlinkSync(join(outside, 'r'), join(root, '.claude', 'rules', 'ext'), 'dir');
  symlinkSync(join(outside, 'secret.md'), join(root, '.claude', 'rules', 'leak.md'));
  const before = measureRepo(root, { owners: new Map(), preset: null }, io);
  expect(before.always.map((e) => e.label)).toEqual(['CLAUDE.md', 'AGENTS.md (imported by CLAUDE.md)', '.claude/rules/in.md']);
  expect(before.unmeasured).toContain('.claude/rules/leak.md: outside the repo');
  process.env.HOME = outside;
  expect(measureRepo(root, { owners: new Map(), preset: null }, io)).toEqual(before);
  expect(seen.filter((p) => relative(root, p).startsWith('..'))).toEqual([]); // both runs, the second with HOME at the fixture
  expect(sized.filter((p) => p.endsWith('leak.md'))).toEqual([]); // a link out of the repo is not even stat'ed
});

test('Windows: repo-relative paths join under a win32 root and stay inside it', () => {
  const abs = absIn(win32, 'C:\\repo', '.claude/rules/sub/a.md');
  expect(abs).toBe('C:\\repo\\.claude\\rules\\sub\\a.md');
  expect(insideWith(win32, 'C:\\repo', abs)).toBe(true);
});

test('a rule that CLAUDE.md also imports is counted once', () => {
  const r = measure({ 'CLAUDE.md': '@.claude/rules/r.md', '.claude/rules/r.md': 'RULE' });
  expect(r.always.filter((e) => e.path === '.claude/rules/r.md')).toHaveLength(1);
});

// I3: a link back to a folder already searched is skipped with a note, so a loop can't fan out.
test.skipIf(process.platform === 'win32')('symlink loops under .claude/rules finish fast with a note', () => {
  const root = makeRepo({ '.claude/rules/a.md': 'A', '.claude/rules/sub/b.md': 'B' }, { git: false });
  for (const l of ['l1', 'l2', 'l3', 'l4']) symlinkSync('.', join(root, '.claude/rules', l), 'dir');
  symlinkSync('..', join(root, '.claude/rules/sub/up'), 'dir'); // a loop through a parent
  const t = performance.now();
  const r = measureRepo(root, { owners: new Map(), preset: null });
  expect(performance.now() - t).toBeLessThan(2000);
  expect(labels(r)).toEqual(['.claude/rules/a.md', '.claude/rules/sub/b.md']);
  expect(r.unmeasured).toEqual(expect.arrayContaining(['.claude/rules/l1: already searched (symlink)', '.claude/rules/sub/up: already searched (symlink)']));
});

// I4: the production skip, not an injected one. The name is built at runtime so no literal dotenv path is in the source.
test('a dotenv file is never read: not by import, as a rule, or as a variant', () => {
  const env = '.' + 'env';
  const FAKE = 'API_TOKEN=fake-value-not-a-secret';
  const io: RepoIO = { ...realIO, read: (p) => { if (p.includes(env)) throw new Error(`read ${p}`); return realIO.read(p); } };
  const r = measure({ 'CLAUDE.md': `@${env}\n@${env}.local\n@docs/${env}\n`, [env]: FAKE, [`${env}.local`]: FAKE, [`docs/${env}`]: FAKE, [`.claude/rules/${env}.md`]: FAKE, '.claude/rules/ok.md': 'OK' }, {}, io);
  expect(labels(r)).toEqual(['CLAUDE.md', '.claude/rules/ok.md']);
  expect(JSON.stringify(r)).not.toContain(FAKE);
});

test('a .mcp.json that parses but is not an object says so', () => {
  const r = measure({ '.mcp.json': '[]', '.claude/settings.json': '"x"' });
  expect(r.notes).toEqual(expect.arrayContaining(['.mcp.json: not a JSON object, not read', '.claude/settings.json: not a JSON object, not read']));
});
