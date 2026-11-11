import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DECISIONS_REASON, decisionsDeny } from '../../src/checks/decisions-protect.js';
import { protect } from '../../src/checks/protect.js';
import { loadConfig } from '../../src/core/config.js';
import { serializeDecision } from '../../src/core/decision-file.js';
import type { Ctx } from '../../src/hooks/dispatch.js';
import { settingsFragment } from '../../src/install/merge.js';

const REASON = 'Team decisions change only through harness remember, which asks the person first. Edit a decision by hand yourself, then run harness remember sync.';
const ID = '2026-11-03-use-zod';
const DEC = `docs/decisions/${ID}.md`;
const RULE = `.claude/rules/harness-decision-${ID}.md`;

const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'h-dp-')));
  mkdirSync(join(root, 'docs/decisions'), { recursive: true });
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  mkdirSync(join(root, '.claude/rules'), { recursive: true });
  writeFileSync(join(root, DEC), serializeDecision({ id: ID, title: 'Use zod', status: 'active', paths: ['src/**'], verified_at: 'a'.repeat(40), verified_on: '2026-11-03', body: '**Rule:** Do it.\n' }));
  writeFileSync(join(root, 'docs/decisions/README.md'), '# ADRs\n');
  writeFileSync(join(root, RULE), '# Team decision: Use zod\n');
  writeFileSync(join(root, 'docs/plans/x.md'), '# plan\n');
  return root;
};
const ROOT = repo();
const cfg = (on = true) => {
  const config = loadConfig('/nonexistent-harness-root').config;
  config.checks.decisions = on;
  return config;
};
const run = (tool_name: string, tool_input: Record<string, unknown>, on = true) =>
  protect.run({ input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: ROOT, tool_name, tool_input }, root: ROOT, config: cfg(on), env: {}, unattended: false } as unknown as Ctx) as { kind: string; reason?: string; check?: string };
const edit = (p: string, tool = 'Edit', on = true) => run(tool, { file_path: p }, on);
const bash = (command: string, on = true) => run('Bash', { command }, on);

const DENIED_TOOL: [string, string][] = [['Edit', RULE], ['Write', RULE], ['Edit', DEC], ['Write', join(ROOT, DEC)], ['Write', 'docs/decisions/new.md'], ['MultiEdit', DEC]];
const DENIED_SHELL = [
  `echo hi | tee ${RULE}`, `echo hi > ${RULE}`, `echo hi >> ${DEC}`, 'echo hi > docs/decisions/new.md',
  `git checkout -- ${DEC}`, `git restore ${DEC}`, `rm ${DEC}`, `mv ${DEC} /tmp/x.md`, `cp /tmp/x.md ${RULE}`,
  `node -e "require('fs').writeFileSync('${RULE}', '')"`, `python3 -c "open('${DEC}', 'w')"`,
  'rm -rf docs', 'rm -rf docs/decisions', 'rm -rf .claude/rules', 'rm -rf docs/decisions/', 'rm -rf ./docs', `bash -c "echo hi > ${DEC}"`,
];

test('the reason is §6.2 verbatim', () => expect(DECISIONS_REASON).toBe(REASON));

test.each(DENIED_TOOL)('%s %s is denied with the decisions reason', (tool, p) => {
  expect(edit(p, tool)).toEqual({ kind: 'deny', reason: REASON, check: 'protect' });
});

test.each(DENIED_SHELL)('shell %s is denied', (c) => {
  expect(bash(c)).toMatchObject({ kind: 'deny', check: 'protect' });
});

test('allowed: a non-decision file in docs/decisions, other docs work, reads (Review focus 2)', () => {
  expect(edit('docs/decisions/README.md').kind).toBe('allow');
  expect(edit('docs/plans/x.md').kind).toBe('allow');
  expect(edit('docs/new.md', 'Write').kind).toBe('allow');
  for (const c of ['rm -rf docs/plans', 'mv docs/a.md docs/b.md', `cat ${DEC}`, `cat ${RULE}`, 'echo hi >> docs/decisions/README.md', 'ls docs/decisions', `grep -r zod docs/decisions`])
    expect(bash(c).kind, c).toBe('allow');
  expect(run('Read', { file_path: DEC }).kind).toBe('allow');
  expect(run('Grep', { pattern: 'zod', path: 'docs/decisions' }).kind).toBe('allow');
});

test('with checks.decisions false every case is allowed', () => {
  for (const [tool, p] of DENIED_TOOL) expect(edit(p, tool, false).kind, `${tool} ${p}`).toBe('allow');
  for (const c of DENIED_SHELL) expect(bash(c, false).kind, c).toBe('allow');
});

test('decisionsDeny: null when off or nothing matches; a removal outside the concrete paths is allowed', () => {
  expect(decisionsDeny(ROOT, cfg(false), [RULE], ['docs'])).toBeNull();
  expect(decisionsDeny(ROOT, cfg(), ['src/a.ts', 'docs/decisions/README.md'], ['docs/plans'])).toBeNull();
  expect(decisionsDeny(ROOT, cfg(), [], ['.'])).toBeNull(); // the root is the guard's: rm -rf . is denied there
  expect(bash("cat > src/x.ts <<'EOF'\n// rm -rf /\nEOF").kind).toBe('allow');
  expect(decisionsDeny(ROOT, cfg(), ['/elsewhere/docs/decisions/x.md'], [])).toBeNull();
});

test('a broken decision (frontmatter mentions schema) is protected; a plain ADR is not', () => {
  writeFileSync(join(ROOT, 'docs/decisions/broken.md'), '---\nschema: [\n---\nx\n');
  writeFileSync(join(ROOT, 'docs/decisions/0001-adr.md'), '---\ntitle: ADR\n---\nx\n');
  expect(edit('docs/decisions/broken.md').kind).toBe('deny');
  expect(edit('docs/decisions/0001-adr.md').kind).toBe('allow');
});

test.each(['rm -rf docs/*', 'rm docs/decisions/*.md', 'rm -rf .claude/rules/*', 'rm -f docs/decisions/2026-*', 'rm -rf .claude/rules/harness-decision-?*'])('glob removal %s is denied', (c) => {
  expect(bash(c)).toEqual({ kind: 'deny', reason: REASON, check: 'protect' });
  expect(bash(c, false).kind).toBe('allow');
});

test('rm -rf .claude/* stays denied, on or off: it also matches the settings files', () => {
  expect(bash('rm -rf .claude/*').kind).toBe('deny');
  expect(bash('rm -rf .claude/*', false).kind).toBe('deny');
  expect(decisionsDeny(ROOT, cfg(), [], ['.claude/*'])).toMatchObject({ kind: 'deny', reason: REASON });
});

test('plain globs elsewhere stay allowed', () => {
  for (const c of ['rm -rf dist/*', 'rm docs/plans/*.md', 'rm -rf docs/plans/*', 'rm docs/decisions/READ*', 'rm -rf .claude/rules/mine-*'])
    expect(bash(c).kind, c).toBe('allow');
});

test('the settings fragment gains no deny rule for decisions (C9)', () => {
  const deny: string[] = settingsFragment().permissions.deny;
  expect(deny.filter((d) => /decision|rules/.test(d))).toEqual([]);
});
