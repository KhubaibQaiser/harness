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
    errors.push(...identityProblemsIn(v, at));
  };
  const list = (at: string, v: unknown): unknown[] => (Array.isArray(v) ? v : (errors.push(`${at}: must be a list`), []));

  unknown('', raw, ['id', 'title', 'description', 'target', 'rules', 'preselect', 'git', 'stacks']);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) errors.push('id: must be lowercase letters, digits and hyphens');
  else if (listPresets(root).some((p) => p.where === 'shipped' && p.id === raw.id)) errors.push(`id: ${q(raw.id)} is already a shipped preset`);
  text('title', raw.title);
  text('description', raw.description);
  if (raw.target !== 'repo' && raw.target !== 'global') errors.push('target: must be repo or global');
  list('rules', raw.rules).forEach((r, i) => text(`rules[${i}]`, r));
  list('preselect', raw.preselect).forEach((id, i) => {
    const item = catalog.items.find((x) => x.id === id);
    if (typeof id !== 'string' || !item) errors.push(`preselect[${i}]: ${typeof id === 'string' ? q(id) : 'value'} is not a catalog id`);
    else if (item.stance === 'discouraged') errors.push(`preselect[${i}]: ${q(id)} is discouraged in the catalog`);
  });

  const g = raw.git;
  if (!isObj(g)) errors.push('git: must be a mapping');
  else {
    unknown('git.', g, ['branch_prefixes', 'no_ai_trailer', 'pr_size_warning']);
    if (!Array.isArray(g.branch_prefixes) || !g.branch_prefixes.length) errors.push('git.branch_prefixes: must be a non-empty list');
    else g.branch_prefixes.forEach((p, i) => { if (typeof p !== 'string' || !PREFIX_RE.test(p)) errors.push(`git.branch_prefixes[${i}]: ${typeof p === 'string' ? q(p) : 'value'} must match ^[a-z0-9-]+/$`); });
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
