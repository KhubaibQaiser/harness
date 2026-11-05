import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import { packageDir } from '../core/package-dir.js';

export type EvalKind = 'skills' | 'rules' | 'gates';
export interface CaseInfo { name: string; kind: EvalKind; variant?: 'rules' | 'bare'; rule?: string; skill?: string }
export interface EvalOpts { kinds: EvalKind[]; tmp: string; dispatch: string; canary?: string }

const SCHEMA_VERSION = '1.1';
const MARKERS: [string, string][] = [['<!-- harness:start -->', '<!-- harness:end -->'], ['<!-- harness:preset:start -->', '<!-- harness:preset:end -->']];

const dirs = (p: string): string[] => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

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

function writeCase(tmp: string, name: string, from: string, caseYaml: Record<string, unknown>): void {
  const out = join(tmp, 'evals', name);
  cpSync(from, out, { recursive: true });
  writeFileSync(join(out, 'case.yaml'), stringify({ schema_version: SCHEMA_VERSION, name, ...caseYaml }));
}

function buildSkills(root: string, tmp: string, tpl: string, cases: CaseInfo[]): string[] {
  const installed = dirs(join(root, '.claude/skills'));
  const known = new Set(dirs(join(tpl, 'skills')).map((c) => c.replace(/-(pos1|pos2|neg)$/, '')));
  for (const skill of installed.filter((s) => known.has(s))) {
    cpSync(join(root, '.claude/skills', skill), join(tmp, 'skills', skill), { recursive: true });
    for (const v of ['pos1', 'pos2', 'neg']) {
      const name = `${skill}-${v}`;
      writeCase(tmp, name, join(tpl, 'skills', name), {});
      cases.push({ name, kind: 'skills', skill });
    }
  }
  return installed.filter((s) => !known.has(s));
}

function buildRules(root: string, tmp: string, tpl: string, cases: CaseInfo[]): void {
  const text = rulesText(root);
  for (const rule of dirs(join(tpl, 'rules'))) {
    for (const variant of ['rules', 'bare'] as const) {
      const name = `${rule}-${variant}`;
      writeCase(tmp, name, join(tpl, 'rules', rule), variant === 'rules' ? { execution: { append_system_prompt: text } } : {});
      cases.push({ name, kind: 'rules', variant, rule });
    }
  }
}

/** Builds the eval plugin under `opts.tmp` (never under `root`). Only free graders are written. */
export function buildEvalPlugin(root: string, opts: EvalOpts): { dir: string; cases: CaseInfo[]; skippedSkills: string[] } {
  if (opts.kinds.includes('gates')) throw new Error('gate evals wait for the P0 probe (spec 7.6); they are not built yet');
  const tmp = resolve(opts.tmp);
  if (!relative(resolve(root), tmp).startsWith('..')) throw new Error('the eval folder must be outside the repo');
  const tpl = join(packageDir('templates'), 'evals');
  mkdirSync(join(tmp, '.claude-plugin'), { recursive: true });
  writeFileSync(join(tmp, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'harness-eval', version: '0.0.0', description: 'Harness eval cases' }, null, 2));
  const cases: CaseInfo[] = [];
  const skippedSkills = opts.kinds.includes('skills') ? buildSkills(root, tmp, tpl, cases) : [];
  if (opts.kinds.includes('rules')) buildRules(root, tmp, tpl, cases);
  return { dir: tmp, cases, skippedSkills };
}
