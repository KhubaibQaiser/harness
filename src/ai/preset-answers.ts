import { identityProblemsIn, listPresets, PREFIX_RE, type PresetGit } from '../catalog/presets.js';
import { ID_RE, type Catalog } from '../catalog/schema.js';
import { CONTROL, esc, isObj } from '../core/config.js';

export const STACKS = ['react', 'next', 'react-native'] as const;
/** Spec F1 to F12, in interview order. */
export const TOPICS = ['folders', 'server_data', 'client_state', 'components', 'forms', 'testing', 'ui_states', 'api_layer', 'performance', 'platform', 'style', 'extras'] as const;
type Stack = (typeof STACKS)[number];
type Topic = (typeof TOPICS)[number];

/** What /harness:preset's interview wrote. A skipped topic is absent, never filled in (spec §8). */
export interface PresetAnswers {
  id: string;
  title: string;
  description: string;
  target: 'repo' | 'global';
  rules: string[];
  preselect: string[];
  git: PresetGit;
  stacks: Partial<Record<Stack, Partial<Record<Topic, string>>>>;
}

const MAX_TEXT = 2000; // one answer, quoted verbatim; longer is not an interview answer
// Backs up the skill's no-secrets rule: known key prefixes, PEM headers, and long runs of 32+ letters and digits that hold a digit.
// ponytail: prefix list is the common ones only; widen it if a real key shape slips through.
const KEY_RE = /\b(?:sk-[A-Za-z0-9_-]{16}|ghp_[A-Za-z0-9]{16}|github_pat_[A-Za-z0-9_]{16}|xox[abprs]-[A-Za-z0-9-]{4}|AKIA[A-Z0-9]{16})|-----BEGIN [A-Z ]{0,40}-----/;
const looksLikeKey = (v: string) => KEY_RE.test(v) || (v.match(/[A-Za-z0-9]{32,}/g) ?? []).some((run) => /\d/.test(run));
const q = (s: string) => `"${esc(s.slice(0, 120))}"`;

/** Checks the builder's answers file. The skill drafts the preset from it; `preset check` is the guard on the folder. */
export function validatePresetAnswers(raw: unknown, catalog: Catalog, root: string): { ok: true; answers: PresetAnswers } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['preset-answers: must be a mapping'] };
  const errors: string[] = [];
  const unknown = (at: string, o: Record<string, unknown>, ok: readonly string[], what = 'key') => {
    for (const k of Object.keys(o)) if (!ok.includes(k)) errors.push(`${at}${esc(k)}: unknown ${what}`);
  };
  const text = (at: string, v: unknown) => {
    if (typeof v !== 'string' || !v.trim()) return void errors.push(`${at}: must be a non-empty string`);
    if (v.length > MAX_TEXT) return void errors.push(`${at}: must be at most ${MAX_TEXT} characters`);
    if (CONTROL.test(v)) return void errors.push(`${at}: must not contain control characters`);
    if (looksLikeKey(v)) return void errors.push(`${at}: looks like a key or token; never put secrets in a preset`);
    errors.push(...identityProblemsIn(v, at));
  };
  const list = (at: string, v: unknown): unknown[] => (Array.isArray(v) ? v : (errors.push(`${at}: must be a list`), []));
  const once = (at: string, v: unknown[]) => {
    for (const d of new Set(v.filter((x, i) => typeof x === 'string' && v.indexOf(x) !== i) as string[])) errors.push(`${at}: ${q(d)} is listed more than once`);
  };

  unknown('', raw, ['id', 'title', 'description', 'target', 'rules', 'preselect', 'git', 'stacks']);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) errors.push('id: must be lowercase letters, digits and hyphens');
  else if (listPresets(root).some((p) => p.where === 'shipped' && p.id === raw.id)) errors.push(`id: ${q(raw.id)} is already a shipped preset`);
  text('title', raw.title);
  text('description', raw.description);
  if (raw.target !== 'repo' && raw.target !== 'global') errors.push('target: must be repo or global');
  list('rules', raw.rules).forEach((r, i) => text(`rules[${i}]`, r));
  const pre = list('preselect', raw.preselect);
  once('preselect', pre);
  pre.forEach((id, i) => {
    if (pre.indexOf(id) !== i) return; // a repeat: reported once above
    const item = catalog.items.find((x) => x.id === id);
    if (typeof id !== 'string' || !item) errors.push(`preselect[${i}]: ${typeof id === 'string' ? q(id) : 'value'} is not a catalog id`);
    else if (item.stance === 'discouraged') errors.push(`preselect[${i}]: ${q(id)} is discouraged in the catalog`);
  });

  const g = raw.git;
  if (!isObj(g)) errors.push('git: must be a mapping');
  else {
    unknown('git.', g, ['branch_prefixes', 'no_ai_trailer', 'pr_size_warning']);
    const bp = g.branch_prefixes;
    if (!Array.isArray(bp) || !bp.length) errors.push('git.branch_prefixes: must be a non-empty list');
    else {
      once('git.branch_prefixes', bp);
      bp.forEach((p, i) => { if (bp.indexOf(p) === i && (typeof p !== 'string' || !PREFIX_RE.test(p))) errors.push(`git.branch_prefixes[${i}]: ${typeof p === 'string' ? q(p) : 'value'} must match ^[a-z0-9-]+/$`); });
    }
    for (const k of ['no_ai_trailer', 'pr_size_warning']) if (typeof g[k] !== 'boolean') errors.push(`git.${k}: must be true or false`);
  }

  const s = raw.stacks;
  if (!isObj(s)) errors.push('stacks: must be a mapping');
  else for (const [stack, topics] of Object.entries(s)) {
    if (!(STACKS as readonly string[]).includes(stack)) { errors.push(`stacks.${esc(stack)}: unknown stack (${STACKS.join(', ')})`); continue; }
    if (!isObj(topics)) { errors.push(`stacks.${stack}: must be a mapping`); continue; }
    unknown(`stacks.${stack}.`, topics, TOPICS, 'topic');
    for (const t of TOPICS) if (t in topics) text(`stacks.${stack}.${t}`, topics[t]);
  }
  return errors.length ? { ok: false, errors } : { ok: true, answers: raw as unknown as PresetAnswers };
}
