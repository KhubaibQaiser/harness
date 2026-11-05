import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { buildEvalPlugin } from '../../src/eval/build.js';
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
const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : [join(d, e.name)]));
const opts = (t: string, kinds: ('skills' | 'rules' | 'gates')[]) => ({ kinds, tmp: t, dispatch: '/x/dispatch.mjs' });
const fm = (p: string) => parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(p, 'utf8'))![1]!) as Record<string, unknown>;

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
      expect(text).not.toContain('harness:');
    } else expect(text).toBeUndefined();
  }
});

test('no-ai-trailer grader, free graders only, pinned model', () => {
  const r = buildEvalPlugin(repo([]), opts(tmp(), ['skills', 'rules']));
  const g = fm(join(r.dir, 'evals/no-ai-trailer-rules/graders/no-trailer.md'));
  expect(g).toMatchObject({ tool: 'Bash', input_match: 'Co-Authored-By|Generated with Claude', max: 0 });
  const files = all(join(r.dir, 'evals'));
  for (const f of files.filter((x) => x.includes('/graders/'))) expect(['tool_used', 'regex', 'tool_order', 'file_exists']).toContain(fm(f).type);
  for (const f of files.filter((x) => x.endsWith('prompt.md'))) expect(fm(f)).toMatchObject({ model: 'claude-haiku-4-5', allowed_tools: expect.any(Array) });
});

test('gates wait for the P0 probe', () => {
  expect(() => buildEvalPlugin(repo([]), opts(tmp(), ['gates']))).toThrow(/P0 probe/);
});

test('refuses a tmp folder inside root', () => {
  const root = repo([]);
  expect(() => buildEvalPlugin(root, opts(join(root, 'out'), ['skills']))).toThrow(/outside/);
});
