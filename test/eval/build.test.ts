import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { buildEvalPlugin, DEFAULT_BRANCH_PREFIXES, EVAL_MODEL } from '../../src/eval/build.js';
import { mergeAgents, mergeAgentsPreset } from '../../src/install/merge.js';

const CORE = 'Always ask before deciding. CORE-RULE-TEXT.';
function repo(skills: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'ev-root-'));
  for (const s of skills) {
    mkdirSync(join(root, '.claude/skills', s), { recursive: true });
    writeFileSync(join(root, '.claude/skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: x\n---\n`);
  }
  writeFileSync(join(root, 'AGENTS.md'), mergeAgentsPreset(mergeAgents(null).after, CORE).after);
  return root;
}
const tmp = () => mkdtempSync(join(tmpdir(), 'ev-tmp-'));
const all = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : [join(d, e.name)]));
const opts = (t: string, kinds: ('skills' | 'rules' | 'gates')[]) => ({ kinds, tmp: t, dispatch: '/x/dispatch.mjs' });
const fm = (p: string) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(p, 'utf8'));
  if (!m) throw new Error(`no frontmatter in ${p}`);
  return parse(m[1] as string) as Record<string, unknown>;
};
const re = (p: string, key = 'input_match') => {
  const g = fm(p);
  return new RegExp(String(g[key]), g.flags as string | undefined);
};

test('skills: three cases per known skill, unknown skills skipped, plugin under tmp', () => {
  const root = repo(['frontend-react', 'my-own']), t = tmp();
  const r = buildEvalPlugin(root, opts(t, ['skills']));
  expect(r.cases.map((c) => c.name).sort()).toEqual(['frontend-react-neg', 'frontend-react-pos1', 'frontend-react-pos2']);
  expect(r.cases.every((c) => c.kind === 'skills' && c.skill === 'frontend-react')).toBe(true);
  expect(r.skippedSkills).toEqual(['my-own']);
  expect(r.dir.startsWith(t)).toBe(true);
  expect(r.dir.startsWith(root)).toBe(false);
  expect(JSON.parse(readFileSync(join(r.dir, '.claude-plugin/plugin.json'), 'utf8')).name).toBeTruthy();
  expect(readFileSync(join(r.dir, 'skills/frontend-react/SKILL.md'), 'utf8')).toContain('frontend-react');
  expect(all(root).every((f) => !f.includes('evals'))).toBe(true);
  const neg = fm(join(r.dir, 'evals/frontend-react-neg/graders/skill-fired.md'));
  expect(neg).toMatchObject({ type: 'tool_used', tool: 'Skill', max: 0 });
});

test('rules: rules and bare case per rule; only rules carries the core text', () => {
  const r = buildEvalPlugin(repo([]), opts(tmp(), ['rules']));
  const rules = [...new Set(r.cases.map((c) => c.rule))];
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) {
    expect(r.cases.filter((c) => c.rule === rule).map((c) => c.variant).sort()).toEqual(['bare', 'rules']);
  }
  for (const c of r.cases) {
    const y = parse(readFileSync(join(r.dir, 'evals', c.name, 'case.yaml'), 'utf8'));
    const text = y.execution?.append_system_prompt as string | undefined;
    if (c.variant === 'rules') {
      expect(text).toContain('CORE-RULE-TEXT');
      expect(text).toContain('Hooks enforce these rules');
      expect(text).not.toContain('<!-- harness:'); // markers stripped; the block names /harness:remember
    } else expect(text).toBeUndefined();
  }
});

test('no-ai-trailer grader, free graders only, pinned model', () => {
  const r = buildEvalPlugin(repo([]), opts(tmp(), ['skills', 'rules']));
  const g = fm(join(r.dir, 'evals/no-ai-trailer-rules/graders/no-trailer.md'));
  expect(g).toMatchObject({ tool: 'Bash', min: 0, max: 0 });
  const files = all(join(r.dir, 'evals'));
  const free = ['tool_used', 'regex', 'tool_order', 'file_exists'];
  for (const f of files.filter((x) => x.includes('/graders/'))) expect(free).toContain(fm(f).type);
  for (const f of files.filter((x) => x.endsWith('prompt.md'))) {
    expect(fm(f)).toMatchObject({ model: EVAL_MODEL, allowed_tools: expect.any(Array) });
  }
});

test('model: constant by default, option overrides, written to every prompt.md', () => {
  expect(EVAL_MODEL).toBe('claude-haiku-5-5');
  const r = buildEvalPlugin(repo(['frontend-react']), { ...opts(tmp(), ['skills', 'rules']), model: 'haiku' });
  const prompts = all(join(r.dir, 'evals')).filter((x) => x.endsWith('prompt.md'));
  expect(prompts.length).toBe(r.cases.length);
  for (const f of prompts) expect(fm(f).model).toBe('haiku');
});

test('case.yaml names the plugin two levels up', () => {
  const r = buildEvalPlugin(repo([]), opts(tmp(), ['rules']));
  expect(parse(readFileSync(join(r.dir, 'evals/tdd-bare/case.yaml'), 'utf8')).plugins).toEqual(['../..']);
});

test('no-ai-trailer matches every trailer spelling and not a plain message', () => {
  const r = buildEvalPlugin(repo([]), opts(tmp(), ['rules']));
  const rx = re(join(r.dir, 'evals/no-ai-trailer-rules/graders/no-trailer.md'));
  const bad = ['Co-Authored-By: X', 'Co-authored-by: X', 'co-authored-by: X', 'Generated with [Claude Code]', 'Generated with Claude'];
  for (const b of bad) expect(rx.test(b), b).toBe(true);
  expect(rx.test('git commit -m "rename getUser to fetchUser"')).toBe(false);
});

test('symlinks in a skill dir are not copied and are reported', () => {
  const root = repo(['frontend-react']);
  const outside = join(mkdtempSync(join(tmpdir(), 'ev-out-')), 'secret.txt');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(root, '.claude/skills/frontend-react/leak.txt'));
  const r = buildEvalPlugin(root, opts(tmp(), ['skills']));
  expect(all(join(r.dir, 'skills')).some((f) => f.endsWith('leak.txt'))).toBe(false);
  expect(readdirSync(join(r.dir, 'skills/frontend-react'))).toContain('SKILL.md');
  expect(r.skippedLinks).toEqual(['.claude/skills/frontend-react/leak.txt']);
});

function prefixRx(root: string) {
  const r = buildEvalPlugin(root, opts(tmp(), ['rules']));
  return re(join(r.dir, 'evals/branch-prefixes-rules/graders/prefix.md'));
}
const checkout = (name: string, q = '') => `git checkout -b ${q}${name}${q}`;

test('branch prefixes: default list, quotes and main are fine, an unlisted name is a violation', () => {
  expect(DEFAULT_BRANCH_PREFIXES).toEqual(['feature/', 'fix/', 'hotfix/', 'chore/', 'refactor/', 'docs/', 'ci/']);
  const rx = prefixRx(repo([]));
  expect(rx.test(checkout('dark-mode'))).toBe(true);
  expect(rx.test(checkout('wip/x'))).toBe(true);
  expect(rx.test(checkout('feature/x'))).toBe(false);
  expect(rx.test(checkout('ci/x'))).toBe(false);
  expect(rx.test(JSON.stringify({ command: checkout('feature/x', '"') }))).toBe(false);
  expect(rx.test(checkout('main'))).toBe(false);
});

test('branch prefixes: read from .harness/config.yaml preset.git.branch_prefixes', () => {
  const root = repo([]);
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/config.yaml'), 'preset:\n  git:\n    branch_prefixes: [team/, bug/]\n');
  const rx = prefixRx(root);
  expect(rx.test(checkout('team/x'))).toBe(false);
  expect(rx.test(checkout('feature/x'))).toBe(true);
});

test('tdd matches .spec. test files too', () => {
  const r = buildEvalPlugin(repo([]), opts(tmp(), ['rules']));
  const g = fm(join(r.dir, 'evals/tdd-rules/graders/test-first.md')) as { before: { input_match: string } };
  expect(new RegExp(g.before.input_match).test('src/slug.spec.ts')).toBe(true);
});

test('weak outcome graders are labelled', () => {
  const r = buildEvalPlugin(repo(['frontend-react']), opts(tmp(), ['skills']));
  expect(String(fm(join(r.dir, 'evals/frontend-react-neg/prompt.md')).description)).toMatch(/^Weak/);
});

test('gates wait for the P0 probe', () => {
  expect(() => buildEvalPlugin(repo([]), opts(tmp(), ['gates']))).toThrow(/P0 probe/);
});

test('refuses a tmp folder inside root, including a sibling-looking ..name', () => {
  const root = repo([]);
  expect(() => buildEvalPlugin(root, opts(join(root, 'out'), ['skills']))).toThrow(/outside/);
  expect(() => buildEvalPlugin(root, opts(join(root, '..foo'), ['skills']))).toThrow(/outside/);
});

test('refuses a non-empty tmp folder so stale cases cannot run', () => {
  const t = tmp();
  writeFileSync(join(t, 'old'), 'x');
  expect(() => buildEvalPlugin(repo([]), opts(t, ['skills']))).toThrow(/new or empty/);
});

test('ask-before-deciding: needs a question that offers options; a rhetorical one fails', () => {
  const r = buildEvalPlugin(repo([]), opts(tmp(), ['rules']));
  const rx = re(join(r.dir, 'evals/ask-before-deciding-rules/graders/asked.md'), 'pattern');
  expect(rx.test('Done?')).toBe(false);
  expect(rx.test('I set it up. Want me to proceed?')).toBe(false);
  expect(rx.test('Should I use Postgres or SQLite?')).toBe(true);
  expect(rx.test('Options:\n- Postgres\n- SQLite\nWhich one?')).toBe(true);
  expect(rx.test('Options:\n1) Postgres\n2) SQLite\nWhich do you want?')).toBe(true);
});

test('branch prefixes: config entries must look like a-z, 0-9, hyphen and a slash, else the default is used', () => {
  const root = repo([]);
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/config.yaml'), 'preset:\n  git:\n    branch_prefixes: [Team_X/]\n');
  const rx = prefixRx(root);
  expect(rx.test(checkout('feature/x'))).toBe(false);
  expect(rx.test(checkout('Team_X/x'))).toBe(true);
});
