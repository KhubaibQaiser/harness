import { readFileSync } from 'node:fs';
import { esc } from '../core/config.js';
import { validateAnswers, type Answers } from '../ai/answers.js';
import { validatePicks, type Picks } from '../ai/picks.js';
import { validateProduct } from '../ai/product.js';
import { validateReport } from '../ai/report.js';
import { CATALOG_BROKEN, loadCatalog } from '../catalog/load.js';
import type { Catalog } from '../catalog/schema.js';
import type { LoadedPreset } from '../catalog/presets.js';
import type { Facts } from '../install/detect.js';
import { resolveChosen } from './preset-inputs.js';

export const EXIT_USAGE = 2; // a bad flag or input file, shared by the init steps

export interface AiArgs { answers?: string; product?: string; picks?: string; report?: string; choose?: string; installPlugins: boolean; overBudget: boolean }
const VALUE_FLAGS = ['answers', 'product', 'picks', 'report', 'choose'] as const;

/** Splits the AI flags off `args`; null when a value flag has no value. */
export function takeAiFlags(args: string[]): { ai: AiArgs; rest: string[] } | null {
  const ai: AiArgs = { installPlugins: false, overBudget: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const k = VALUE_FLAGS.find((f) => args[i] === `--${f}`);
    if (k) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) return null;
      ai[k] = args[++i];
    } else if (args[i] === '--install-plugins') ai.installPlugins = true;
    else if (args[i] === '--over-budget') ai.overBudget = true;
    else rest.push(args[i]);
  }
  return { ai, rest };
}

/** The usage error for the first AI input that is missing (all of them are needed together), or null. */
export const missingAi = (cmd: string, ai: AiArgs): string | null => {
  const f = VALUE_FLAGS.find((k) => ai[k] === undefined && !(cmd === 'update' && k === 'answers')); // update merges a partial answers file
  return f ? `${cmd}: --${f} ${f === 'choose' ? '<id,...>' : '<file>'} is required inside Claude Code` : null;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lays a partial answers file over the existing answers; `project`, `unattended` and `tdd` merge one level deep. */
export function overlayAnswers(base: Record<string, unknown>, part: Record<string, unknown>): Record<string, unknown> {
  const m: Record<string, unknown> = { ...base, ...part };
  for (const k of ['project', 'unattended', 'tdd']) if (isObj(part[k])) m[k] = { ...(isObj(base[k]) ? base[k] : {}), ...part[k] };
  return m;
}

export interface AiInputs { answers: Answers; picks: Picks; ids: string[]; notices: string[]; files: { picks: string; report: string; product: string }; catalog: Catalog; presetItems: string[]; preset?: LoadedPreset; reasons: Record<string, string> }

/** Reads and validates the AI step's files against the facts and the real catalog, then resolves --choose. */
export function loadAiInputs(ai: AiArgs, facts: Facts, claudeVer: string | null, base?: Record<string, unknown>): { ok: true; in: AiInputs } | { ok: false; errors: string[]; code: number } {
  const cat = loadCatalog();
  if (cat.errors.length) return { ok: false, errors: [...cat.errors, CATALOG_BROKEN], code: 1 };
  const text: Record<string, string> = {};
  for (const k of ['answers', 'product', 'picks', 'report'] as const) {
    if (k === 'answers' && base && ai.answers === undefined) { text.answers = '{}'; continue; }
    try {
      text[k] = readFileSync(ai[k]!, 'utf8');
    } catch (e) {
      return { ok: false, errors: [`Could not read --${k} "${esc(ai[k]!)}" (${(e as NodeJS.ErrnoException).code ?? 'unreadable'}).`], code: EXIT_USAGE };
    }
  }
  const parsed = (k: 'answers' | 'picks'): { v: unknown } | { err: string } => {
    try {
      return { v: JSON.parse(text[k]) };
    } catch (e) {
      return { err: `${k}: not valid JSON (${esc((e as Error).message.split('\n')[0])})` };
    }
  };
  const pa = parsed('answers');
  if ('err' in pa) return { ok: false, errors: [pa.err], code: EXIT_USAGE };
  // update: the file holds only the re-asked keys; they go over the existing answers, then the full set is validated.
  const merged = base && isObj(pa.v) ? overlayAnswers(base, pa.v) : pa.v;
  const a = validateAnswers(merged, facts);
  if (!a.ok) return { ok: false, errors: a.errors, code: EXIT_USAGE };
  const pp = parsed('picks');
  if ('err' in pp) return { ok: false, errors: [pp.err], code: EXIT_USAGE };
  const p = validatePicks(pp.v, cat.catalog, a.answers);
  if (!p.ok) return { ok: false, errors: p.errors, code: EXIT_USAGE };
  const errors = [...validateProduct(text.product), ...validateReport(text.report, p.picks)];
  if (errors.length) return { ok: false, errors, code: EXIT_USAGE };
  const c = resolveChosen(a.answers, facts, ai.choose!.split(',').filter(Boolean), p.picks, cat.catalog, claudeVer);
  if (!c.ok) return { ok: false, errors: c.errors, code: EXIT_USAGE };
  // The report is passed as written: planChanges adds the enforcement sentence when it writes .harness/report.md.
  return { ok: true, in: { answers: a.answers, picks: p.picks, ids: c.r.ids, notices: c.r.notices, files: { picks: text.picks, report: text.report, product: text.product }, catalog: cat.catalog, presetItems: c.pc?.items ?? [], preset: c.pc?.loaded, reasons: c.pc?.reasons ?? {} } };
}
