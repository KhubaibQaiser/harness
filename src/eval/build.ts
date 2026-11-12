import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { packageDir } from '../core/package-dir.js';

export type EvalKind = 'skills' | 'rules' | 'gates';
export interface CaseInfo { name: string; kind: EvalKind; variant?: 'rules' | 'bare'; rule?: string; skill?: string }
export interface EvalOpts { kinds: EvalKind[]; tmp: string; dispatch: string; canary?: string; model?: string }
export interface EvalBuild { dir: string; cases: CaseInfo[]; skippedSkills: string[]; skippedLinks: string[] }

/** The pinned agent model for eval cases (owner ruling O7); `opts.model` overrides it. */
export const EVAL_MODEL = 'claude-haiku-5-5';
/** The shipped preset's git.branch_prefixes, used when the repo's config has none. */
export const DEFAULT_BRANCH_PREFIXES = ['feature/', 'fix/', 'hotfix/', 'chore/', 'refactor/', 'docs/', 'ci/'];

const SCHEMA_VERSION = '1.1';
const MARKERS: [string, string][] = [
  ['<!-- harness:start -->', '<!-- harness:end -->'],
  ['<!-- harness:preset:start -->', '<!-- harness:preset:end -->'],
];

const dirs = (p: string): string[] => {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
};

/** Inner text of the harness block and the preset block of AGENTS.md. */
function rulesText(root: string): string {
  const file = join(root, 'AGENTS.md');
  if (!existsSync(file)) throw new Error('AGENTS.md not found; the rules evals need the installed rules text');
  const md = readFileSync(file, 'utf8');
  const parts = MARKERS.flatMap(([s, e]) => {
    const a = md.indexOf(s), b = md.indexOf(e);
    return a === -1 || b < a ? [] : [md.slice(a + s.length, b).trim()];
  });
  if (!parts.length) throw new Error('AGENTS.md has no harness markers; the rules evals need the installed rules text');
  return parts.join('\n\n');
}

/** Prefixes from `.harness/config.yaml` preset.git.branch_prefixes, else the default. */
function branchPrefixes(root: string): string[] {
  let list: unknown;
  try {
    list = parse(readFileSync(join(root, '.harness/config.yaml'), 'utf8'))?.preset?.git?.branch_prefixes;
  } catch {
    list = undefined;
  }
  // Same shape as the config's own rule (src/core/config.ts): lowercase letters, digits and hyphens, then a slash.
  const ok = Array.isArray(list) && list.length > 0 && list.every((p) => typeof p === 'string' && /^[a-z0-9-]+\/$/.test(p));
  return ok ? (list as string[]) : DEFAULT_BRANCH_PREFIXES;
}

interface Ctx {
  root: string;
  tmp: string;
  tpl: string;
  model: string;
  /** Regex alternation of the allowed branch prefixes, read once per build. */
  prefixes: string;
  /** Made-up value the gates scaffold writes into the secrets file; graders check it never shows. */
  canary: string;
  cases: CaseInfo[];
  links: string[];
}

/** Copies a template case; the model is written into prompt.md from one place, prefixes and the canary into the graders. */
function writeCase(c: Ctx, name: string, from: string, caseYaml: Record<string, unknown>): void {
  const out = join(c.tmp, 'evals', name);
  cpSync(from, out, { recursive: true });
  const prompt = join(out, 'prompt.md');
  writeFileSync(prompt, readFileSync(prompt, 'utf8').replace(/^---\n/, `---\nmodel: ${c.model}\n`));
  for (const g of readdirSync(join(out, 'graders'))) {
    const f = join(out, 'graders', g);
    writeFileSync(f, readFileSync(f, 'utf8').replace('{{prefixes}}', c.prefixes).replaceAll('{{canary}}', c.canary));
  }
  const body = { schema_version: SCHEMA_VERSION, name, plugins: ['../..'], ...caseYaml };
  writeFileSync(join(out, 'case.yaml'), stringify(body));
}

/** Copies a skill directory without following or copying symlinks; skipped links are reported. */
function copySkill(c: Ctx, skill: string): void {
  const from = join(c.root, '.claude/skills', skill);
  const filter = (src: string): boolean => {
    if (!lstatSync(src).isSymbolicLink()) return true;
    c.links.push(relative(c.root, src).split(sep).join('/')); // forward slashes on every OS
    return false;
  };
  cpSync(from, join(c.tmp, 'skills', skill), { recursive: true, filter });
}

function buildSkills(c: Ctx): string[] {
  const installed = dirs(join(c.root, '.claude/skills'));
  const known = new Set(dirs(join(c.tpl, 'skills')).map((d) => d.replace(/-(pos1|pos2|neg)$/, '')));
  for (const skill of installed.filter((s) => known.has(s))) {
    copySkill(c, skill);
    for (const v of ['pos1', 'pos2', 'neg']) {
      const name = `${skill}-${v}`;
      writeCase(c, name, join(c.tpl, 'skills', name), {});
      c.cases.push({ name, kind: 'skills', skill });
    }
  }
  return installed.filter((s) => !known.has(s));
}

function buildRules(c: Ctx): void {
  const text = rulesText(c.root);
  for (const rule of dirs(join(c.tpl, 'rules'))) {
    for (const variant of ['rules', 'bare'] as const) {
      const name = `${rule}-${variant}`;
      writeCase(c, name, join(c.tpl, 'rules', rule), variant === 'rules' ? { execution: { append_system_prompt: text } } : {});
      c.cases.push({ name, kind: 'rules', variant, rule });
    }
  }
}

// The tools harness's own PreToolUse hook covers (templates/settings.fragment.json), minus PowerShell and Monitor.
const HOOK_TOOLS = 'Bash|Read|Grep|Edit|Write|MultiEdit|NotebookEdit';

/** Bundles the dispatcher as the plugin's PreToolUse hook (the form P0 proved runs in eval sessions) and writes the gate cases. */
function buildGates(c: Ctx, dispatch: string): void {
  if (!existsSync(dispatch)) throw new Error(`${dispatch} not found; gate evals bundle the built hook dispatcher`);
  mkdirSync(join(c.tmp, 'hooks'));
  cpSync(dispatch, join(c.tmp, 'hooks/dispatch.mjs'));
  const hook = { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/dispatch.mjs"', timeout: 10 };
  writeFileSync(join(c.tmp, 'hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: HOOK_TOOLS, hooks: [hook] }] } }, null, 2));
  const scaffold = readFileSync(join(c.tpl, 'gates/scaffold.sh'), 'utf8').replaceAll('{{canary}}', c.canary);
  for (const name of dirs(join(c.tpl, 'gates'))) {
    writeCase(c, name, join(c.tpl, 'gates', name), { context: { scaffold_script: 'scaffold.sh' } });
    writeFileSync(join(c.tmp, 'evals', name, 'scaffold.sh'), scaffold, { mode: 0o755 });
    c.cases.push({ name, kind: 'gates' });
  }
}

function checkTmp(root: string, tmp: string): void {
  const rel = relative(resolve(root), tmp);
  const outside = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
  if (!outside) throw new Error('the eval folder must be outside the repo');
  if (existsSync(tmp) && readdirSync(tmp).length) throw new Error('the eval folder must be new or empty, or stale cases would run');
}

/** Builds the eval plugin under `opts.tmp` (never under `root`). Only free graders are written. */
export function buildEvalPlugin(root: string, opts: EvalOpts): EvalBuild {
  const canary = opts.canary ?? `HARNESS_CANARY_${randomBytes(8).toString('hex')}`;
  // Written into a shell script and a regex, so only word characters.
  if (!/^\w+$/.test(canary)) throw new Error('the canary must be letters, digits and underscores');
  const tmp = resolve(opts.tmp);
  checkTmp(root, tmp);
  mkdirSync(join(tmp, '.claude-plugin'), { recursive: true });
  const manifest = { name: 'harness-eval', version: '0.0.0', description: 'Harness eval cases' };
  writeFileSync(join(tmp, '.claude-plugin/plugin.json'), JSON.stringify(manifest, null, 2));
  const c: Ctx = {
    root,
    tmp,
    tpl: join(packageDir('templates'), 'evals'),
    model: opts.model ?? EVAL_MODEL,
    prefixes: branchPrefixes(root).join('|'),
    canary,
    cases: [],
    links: [],
  };
  const skippedSkills = opts.kinds.includes('skills') ? buildSkills(c) : [];
  if (opts.kinds.includes('rules')) buildRules(c);
  if (opts.kinds.includes('gates')) buildGates(c, opts.dispatch);
  return { dir: tmp, cases: c.cases, skippedSkills, skippedLinks: c.links };
}
