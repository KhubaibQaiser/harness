import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from '../core/config.js';
import { serializeConfig } from '../core/config-io.js';
import type { Change } from './apply.js';
import { lineHunks, revertHunks } from './diff.js';
import { prettierFormat, repoPrettier } from './format.js';
import type { Facts } from './detect.js';
import { mergeAgents, mergeClaudeMd, mergeEslintFlatIgnores, mergeGitignore, mergeIgnoreFile, mergeSettings } from './merge.js';
import { JEST_REPORTER, resultsRename, testConfigChange } from './test-config.js';

export const ESLINT = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];

/**
 * Every file init (and update) would write, as Change[]: `create` when the file is absent, `update` when its
 * content differs, nothing when it would be unchanged. Reads the repo but never writes. Throws MergeError on a
 * file it cannot merge safely.
 */
export function planChanges(
  root: string,
  config: HarnessConfig,
  facts: Facts,
  /** `legacyDir`: update's old results folder; a package whose results file still names it is migrated, TDD on or off.
   * `recorded`: the settings blocks the manifest holds, so update replaces harness's own old hook groups in place. */
  ctx: { version: string; distDir: string; templatesDir?: string; legacyDir?: string; recorded?: string[] },
): { changes: Change[]; manual: string[]; notes: string[] } {
  const templatesDir = ctx.templatesDir ?? join(ctx.distDir, '..', 'templates');
  const changes: Change[] = [];
  const manual: string[] = [];
  const notes: string[] = [];
  const read = (rel: string): string | null => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
  const put = (rel: string, after: string, blocks: string[] = [], mode?: number) => {
    const before = read(rel);
    if (before === null) changes.push({ kind: 'create', rel, content: after, ...(mode ? { mode } : {}), ...(blocks.length ? { blocks } : {}) });
    // A CRLF checkout of an LF file (core.autocrlf) is unchanged; merged files already keep the file's own EOL.
    else if (before.replace(/\r\n/g, '\n') !== after.replace(/\r\n/g, '\n')) changes.push({ kind: 'update', rel, before, after, blocks });
  };

  put('.harness/hooks/dispatch.mjs', readFileSync(join(ctx.distDir, 'hooks', 'dispatch.mjs'), 'utf8'), [], 0o755);
  put('.harness/config.yaml', serializeConfig(config, ctx.version));
  // LF whatever the package checkout uses (a Windows clone may have CRLF), so the bytes and the manifest hash are the same everywhere.
  const tpl = (...p: string[]) => readFileSync(join(templatesDir, ...p), 'utf8').replace(/\r\n/g, '\n');
  put('.claude/agents/staff-reviewer.md', tpl('agents', 'staff-reviewer.md'));
  put('.claude/skills/review-rubric/SKILL.md', tpl('skills', 'review-rubric', 'SKILL.md'));

  const settings = mergeSettings(read('.claude/settings.json'), { sandbox: 'unattended', recorded: ctx.recorded });
  notes.push(...settings.notes);
  if (settings.blocks.length) { // every dropped group also adds its replacement's block
    put('.claude/settings.json', settings.after, settings.blocks);
    const c = changes.at(-1);
    if (c?.kind === 'update' && c.rel === '.claude/settings.json' && settings.dropped.length) c.dropped = settings.dropped;
  }

  const agents = mergeAgents(read('AGENTS.md'));
  put('AGENTS.md', agents.after, agents.blocks);
  const claude = mergeClaudeMd(read('CLAUDE.md'), true); // init always creates or merges AGENTS.md
  if (claude) put('CLAUDE.md', claude.after, claude.blocks);

  const ignore = (rel: string, m: { after: string; blocks: string[] }) => m.blocks.length && put(rel, m.after, m.blocks);
  ignore('.gitignore', mergeGitignore(read('.gitignore')));
  // Prettier 3 reads .gitignore, but the committed .harness/ files are not in it, so they need .prettierignore.
  for (const rel of ['.prettierignore', '.eslintignore']) if (existsSync(join(root, rel)) || (rel === '.prettierignore' && facts.prettier)) ignore(rel, mergeIgnoreFile(read(rel), '.harness/'));
  const eslint = ESLINT.find((f) => existsSync(join(root, f)));
  if (eslint) {
    const m = mergeEslintFlatIgnores(read(eslint)!);
    if (m === null) manual.push(`${eslint}: add '.harness/' to the ignores array so linting skips the harness files`);
    else ignore(eslint, m);
  }

  // Also when TDD is off: a left-out Jest package's manual lines point at the reporter.
  if (facts.packages.some((p) => p.test === 'jest')) put(JEST_REPORTER, tpl('hooks', 'jest-results.cjs'));
  for (const pkg of facts.packages) {
    const rename = ctx.legacyDir === undefined ? null : resultsRename(pkg, root, config.tdd.results_dir, ctx.legacyDir);
    if (rename) changes.push(rename); // ponytail: one change per package; a rename and another config edit take two update runs
    else if (config.checks.tdd) {
      const r = testConfigChange(pkg, root, config.tdd.results_dir);
      if ('change' in r) changes.push(r.change);
      else if ('manual' in r) manual.push(...r.manual);
    }
  }
  formatEdits(root, changes, notes);
  return { changes, manual, notes };
}

const JS = /\.[cm]?[jt]s$/;
/**
 * Runs the repo's own Prettier on the JS/TS configs harness edits, so `prettier --check` stays clean. Only a file that
 * was Prettier-clean before is formatted (anything else would reformat the user's code), and only when the formatted
 * edit undoes cleanly. A failure leaves the edit unformatted, with a note.
 */
function formatEdits(root: string, changes: Change[], notes: string[]): void {
  for (const c of changes) {
    if (c.kind !== 'update' || c.rename || !JS.test(c.rel)) continue; // a rename is a plain substitution (ruling 6)
    const bin = repoPrettier(root, c.rel);
    if (!bin) continue;
    try {
      if (prettierFormat(bin, root, c.rel, c.before) !== c.before) continue;
      const after = prettierFormat(bin, root, c.rel, c.after);
      if (after === c.after) continue;
      const replace = lineHunks(c.before, after);
      if (revertHunks(after, replace) !== c.before) throw new Error('the formatted edit does not undo cleanly');
      Object.assign(c, { after, blocks: [], replace, formatted: true });
    } catch (e) {
      c.unformatted = true;
      notes.push(`Prettier could not format \`${c.rel}\` (${String((e as Error).message).split('\n')[0]}); the edit is left unformatted, so a format check may flag it.`);
    }
  }
}
