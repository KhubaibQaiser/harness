import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from '../core/config.js';
import { serializeConfig } from '../core/config-io.js';
import type { Change } from './apply.js';
import type { Facts } from './detect.js';
import { mergeAgents, mergeClaudeMd, mergeEslintFlatIgnores, mergeGitignore, mergeIgnoreFile, mergeSettings } from './merge.js';
import { testConfigChange } from './test-config.js';

const ESLINT = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];

/**
 * Every file init (and update) would write, as Change[]: `create` when the file is absent, `update` when its
 * content differs, nothing when it would be unchanged. Reads the repo but never writes. Throws MergeError on a
 * file it cannot merge safely.
 */
export function planChanges(
  root: string,
  config: HarnessConfig,
  facts: Facts,
  ctx: { version: string; distDir: string; templatesDir?: string },
): { changes: Change[]; manual: string[]; notes: string[] } {
  const templatesDir = ctx.templatesDir ?? join(ctx.distDir, '..', 'templates');
  const changes: Change[] = [];
  const manual: string[] = [];
  const notes: string[] = [];
  const read = (rel: string): string | null => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
  const put = (rel: string, after: string, blocks: string[] = [], mode?: number) => {
    const before = read(rel);
    if (before === null) changes.push({ kind: 'create', rel, content: after, ...(mode ? { mode } : {}), ...(blocks.length ? { blocks } : {}) });
    else if (before !== after) changes.push({ kind: 'update', rel, before, after, blocks });
  };

  put('.harness/hooks/dispatch.mjs', readFileSync(join(ctx.distDir, 'hooks', 'dispatch.mjs'), 'utf8'), [], 0o755);
  put('.harness/config.yaml', serializeConfig(config, ctx.version));
  put('.claude/agents/staff-reviewer.md', readFileSync(join(templatesDir, 'agents', 'staff-reviewer.md'), 'utf8'));
  put('.claude/skills/review-rubric/SKILL.md', readFileSync(join(templatesDir, 'skills', 'review-rubric', 'SKILL.md'), 'utf8'));

  const settings = mergeSettings(read('.claude/settings.json'));
  notes.push(...settings.notes);
  if (settings.blocks.length) put('.claude/settings.json', settings.after, settings.blocks);

  const agents = mergeAgents(read('AGENTS.md'));
  put('AGENTS.md', agents.after, agents.blocks);
  const claude = mergeClaudeMd(read('CLAUDE.md'), true); // init always creates or merges AGENTS.md
  if (claude) put('CLAUDE.md', claude.after, claude.blocks);

  const ignore = (rel: string, m: { after: string; blocks: string[] }) => m.blocks.length && put(rel, m.after, m.blocks);
  ignore('.gitignore', mergeGitignore(read('.gitignore')));
  for (const rel of ['.prettierignore', '.eslintignore']) if (existsSync(join(root, rel))) ignore(rel, mergeIgnoreFile(read(rel), '.harness/'));
  const eslint = ESLINT.find((f) => existsSync(join(root, f)));
  if (eslint) {
    const m = mergeEslintFlatIgnores(read(eslint)!);
    if (m === null) manual.push(`${eslint}: add '.harness/' to the ignores array so linting skips the harness files`);
    else ignore(eslint, m);
  }

  if (config.checks.tdd)
    for (const pkg of facts.packages) {
      const r = testConfigChange(pkg, root, config.tdd.results_dir);
      if ('change' in r) changes.push(r.change);
      else if ('manual' in r) manual.push(...r.manual);
    }
  return { changes, manual, notes };
}
