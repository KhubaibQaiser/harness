import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { esc } from '../core/config.js';
import { PREFIX_RE } from '../core/branch-prefix.js';
import type { PresetGit } from '../core/branch-prefix.js';
import { packageDir } from '../core/package-dir.js';
import { ID_RE, validateItem } from './schema.js';
import type { AppliesWhen, Catalog, CatalogItem } from './schema.js';
import type { Facts } from '../install/detect.js';
import { checklist, type ChecklistRow } from '../install/select.js';
import { mergeAgentsPreset } from '../install/merge.js';
import { estimateTokens, itemContext, itemContextLine, type ContextEntry } from '../budget/measure.js';

export { PREFIX_RE, slug, suggestBranches } from '../core/branch-prefix.js';
export type { PresetGit } from '../core/branch-prefix.js';

export interface Preset { id: string; title: string; description: string; core: string; preselect: string[]; skills: string[]; settings: { attribution?: 'off'; telemetry_off: string[] }; git: PresetGit }
export interface LoadedPreset { preset: Preset; base: string; yamlPath: string; items: CatalogItem[] }

/** Catalog id -> the environment variable that turns its telemetry off. */
export const TELEMETRY_ENV: Record<string, { name: string; value: string }> = {
  // catalog/items/impeccable.yaml evidence: README Telemetry section, "DO_NOT_TRACK=1".
  impeccable: { name: 'DO_NOT_TRACK', value: '1' },
  // obra/superpowers@2ce8aa15 README.md line 400 says "any true value"; skills/brainstorming/scripts/server.cjs
  // lines 107-112 and 227-232 treat anything but empty, 0, false, no or off as true. 'true' is what its tests use (owner ruling).
  superpowers: { name: 'SUPERPOWERS_DISABLE_TELEMETRY', value: 'true' },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const bools = ['no_ai_trailer', 'pr_size_warning'] as const;
const MAX_BODY = 150;
const MAX_BYTES = 256 * 1024;

/** Preset folders come from cloned repos: read only regular files (no symlinks) of bounded size. */
function readSmall(p: string, label: string, root?: string): { text: string } | { error: string } {
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return { error: `${label}: not a regular file (symlinks are not followed)` };
    if (root !== undefined && !realpathSync(p).startsWith(realpathSync(root) + sep)) return { error: `${label}: outside the presets folder` };
    if (st.size > MAX_BYTES) return { error: `${label}: larger than 256 KB` };
    return { text: readFileSync(p, 'utf8') };
  } catch {
    return { error: `${label}: cannot read` };
  }
}

export const shippedPresetsDir = (): string => join(packageDir('catalog'), 'presets');
export const presetDirs = (root: string): string[] => [shippedPresetsDir(), join(root, '.harness', 'presets')];

export function loadPreset(yamlPath: string): { ok: true; loaded: LoadedPreset } | { ok: false; errors: string[] } {
  const file = yamlPath.split(/[\\/]/).pop()!;
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${file}: ${path ? `${path}: ` : ''}${msg}`);
  const unknown = (o: Record<string, unknown>, known: string[], at: string) => { for (const k of Object.keys(o)) if (!known.includes(k)) err(at, `unknown key "${esc(k)}"`); };
  const src = readSmall(yamlPath, file);
  if ('error' in src) return { ok: false, errors: [src.error] };
  let raw: unknown;
  try { raw = parse(src.text); } catch (e) { return { ok: false, errors: [`${file}: not valid YAML (${esc((e as Error).message.split('\n')[0])})`] }; }
  if (!isObj(raw)) return { ok: false, errors: [`${file}: must be a YAML mapping`] };
  unknown(raw, ['id', 'title', 'description', 'core', 'preselect', 'skills', 'settings', 'git'], '');
  for (const k of ['id', 'title', 'description', 'core']) if (typeof raw[k] !== 'string' || !(raw[k] as string).trim()) err(k, 'must be a non-empty string');
  if (typeof raw.id === 'string' && (!ID_RE.test(raw.id) || file !== `${raw.id}.yaml`)) err('id', `must be lowercase letters, digits and hyphens, and match the file name ${file}`);
  for (const k of ['preselect', 'skills']) if (!strs(raw[k])) err(k, 'must be a list of strings');
  const s = raw.settings;
  if (!isObj(s)) err('settings', 'must be a mapping');
  else {
    unknown(s, ['attribution', 'telemetry_off'], 'settings');
    if (s.attribution !== undefined && s.attribution !== 'off') err('settings.attribution', 'must be off');
    if (s.telemetry_off !== undefined && !strs(s.telemetry_off)) err('settings.telemetry_off', 'must be a list of strings');
  }
  const g = raw.git;
  if (!isObj(g)) err('git', 'must be a mapping');
  else {
    unknown(g, ['branch_prefixes', ...bools], 'git');
    const bp = g.branch_prefixes;
    if (!strs(bp) || bp.length === 0) err('branch_prefixes', 'must be a non-empty list');
    else bp.forEach((p, i) => PREFIX_RE.test(p) || err(`branch_prefixes[${i}]`, "must match ^[a-z0-9-]+/$"));
    for (const k of bools) if (typeof g[k] !== 'boolean') err(`git.${k}`, 'must be true or false');
  }
  if (strs(raw.preselect)) for (const [i, id] of raw.preselect.entries()) if (raw.preselect.indexOf(id) !== i) err('', `preselect "${esc(id)}" is listed twice`);
  if (strs(raw.skills) && typeof raw.core === 'string') for (const [i, id] of [raw.core, ...raw.skills].entries()) if (i > 0 && [raw.core, ...raw.skills].indexOf(id) !== i) err('', `skills "${esc(id)}" is listed twice`);
  if (errors.length) return { ok: false, errors };
  const preset = { ...raw, settings: { telemetry_off: [], ...(s as object) } } as unknown as Preset;
  const base = join(dirname(yamlPath), preset.id);
  const items: CatalogItem[] = [];
  const bad = dirErrors(base, ['', 'items']);
  if (bad.length) return { ok: false, errors: bad.map((e) => `${file}: ${e}`) };
  for (const [what, id] of [['core', preset.core], ...preset.skills.map((x) => ['skills', x])] as [string, string][]) {
    const rel = `${preset.id}/items/${id}.yaml`;
    const p = join(dirname(yamlPath), rel);
    if (!ID_RE.test(id) || !existsSync(p)) { errors.push(`${file}: ${what} "${esc(id)}": no item at ${esc(rel)}`); continue; }
    const t = readSmall(p, rel, dirname(yamlPath));
    if ('error' in t) { errors.push(t.error); continue; }
    let item: unknown;
    try { item = parse(t.text); } catch (e) { errors.push(`${rel}: not valid YAML (${esc((e as Error).message.split('\n')[0])})`); continue; }
    const r = validateItem(item, rel);
    if (!r.ok) errors.push(...r.errors);
    else if (r.item.id !== id) errors.push(`${rel}: id must be ${id}`);
    else if (r.item.kind !== (what === 'core' ? 'rule' : 'own-skill')) errors.push(`${rel}: kind must be ${what === 'core' ? 'rule' : 'own-skill'}`);
    else items.push(r.item);
  }
  return errors.length ? { ok: false, errors } : { ok: true, loaded: { preset, base, yamlPath, items } };
}

/** The preset folder and its items/ and templates/ must be real directories, not links. */
function dirErrors(base: string, subs: string[]): string[] {
  return subs.flatMap((sub) => {
    const p = join(base, sub);
    try { return lstatSync(p).isSymbolicLink() ? [`${esc(sub || base.split(/[\\/]/).pop()!)}: symlink not followed`] : []; } catch { return []; }
  });
}

function skillErrors(rawLabel: string, text: string): string[] {
  const label = esc(rawLabel);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  let fm: unknown;
  try { fm = m ? parse(m[1]) : undefined; } catch { /* reported below */ }
  const out: string[] = [];
  if (!isObj(fm) || typeof fm.name !== 'string' || typeof fm.description !== 'string' || !fm.name.trim() || !fm.description.trim()) out.push(`${label}: frontmatter needs name and description`);
  const lines = text.split('\n');
  const offset = m ? text.slice(0, text.length - m[2].length).split('\n').length - 1 : 0;
  const body = m ? m[2].replace(/\n$/, '').split('\n') : lines;
  if (m && body.length > MAX_BODY) out.push(`${label}: body has ${body.length} lines; the limit is ${MAX_BODY}`);
  body.forEach((l, i) => /\[docs(?!: https:\/\/[^\]\s]+\])/.test(l) && out.push(`${label}:${offset + i + 1}: a docs-labelled line needs a link: [docs: https://…]`));
  return out;
}

export function checkPreset(l: LoadedPreset, catalog: Catalog, opts: { builtOnly?: boolean } = {}): string[] {
  const { preset: p, base } = l;
  const out: string[] = dirErrors(base, ['templates']);
  if (out.length) return out;
  const ids = new Map(catalog.items.map((i) => [i.id, i]));
  for (const id of p.preselect) {
    const it = ids.get(id);
    if (!it) out.push(`preselect "${esc(id)}" is not in the catalog`);
    else if (it.stance === 'discouraged') out.push(`preselect "${esc(id)}" is discouraged in the catalog`);
  }
  for (const id of p.settings.telemetry_off) {
    if (!p.preselect.includes(id)) out.push(`telemetry_off "${esc(id)}" is not in preselect`);
    else if (!Object.hasOwn(TELEMETRY_ENV, id)) out.push(`telemetry_off "${esc(id)}": harness knows no opt-out variable for it`);
  }
  for (const it of l.items) {
    if (ids.has(it.id)) out.push(`item "${esc(it.id)}" clashes with a catalog id`);
    const files = it.id === p.core ? [{ from: 'core.md' }] : it.source.type === 'own' ? (it.source.files ?? []) : [];
    if (it.id !== p.core && files.length === 0) out.push(`${esc(it.id)}: skill needs source.files`);
    for (const f of files) {
      const path = join(base, 'templates', f.from);
      if (!existsSync(path)) { out.push(`${esc(it.id)}: template ${esc(f.from)} not found`); continue; }
      const t = readSmall(path, esc(f.from), dirname(l.yamlPath));
      if ('error' in t) out.push(t.error);
      else if (it.id !== p.core) out.push(...skillErrors(f.from, t.text));
    }
  }
  if (opts.builtOnly) {
    const shipped = join(shippedPresetsDir(), `${p.id}.yaml`);
    if (existsSync(shipped) && resolve(shipped) !== resolve(l.yamlPath)) out.push(`preset id "${esc(p.id)}" is already a shipped preset`);
  }
  return out;
}

// Every quantifier is bounded, so hostile text cannot make the scan quadratic.
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){0,7}\.[A-Za-z]{2,24}\b/;
export function identityProblemsIn(text: string, label: string): string[] {
  const out: string[] = [];
  if (EMAIL.test(text)) out.push(`${label}: contains an email address`);
  if (/\buser\.(name|email)\b/.test(text)) out.push(`${label}: mentions user.name or user.email`);
  return out;
}

type Found = { path: string; skip?: string };
function filesUnder(d: string): Found[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e): Found[] => {
    const p = join(d, e.name);
    if (e.isSymbolicLink()) return [{ path: p, skip: 'symlink not followed' }];
    return e.isDirectory() ? filesUnder(p) : [{ path: p }];
  });
}
export function identityProblems(l: LoadedPreset): string[] {
  const root = dirname(l.yamlPath);
  const bad = dirErrors(l.base, ['']);
  const all: Found[] = [{ path: l.yamlPath }, ...(existsSync(l.base) && !bad.length ? filesUnder(l.base) : [])];
  return [...bad, ...all.flatMap((f) => {
    const label = esc(f.path.slice(root.length + 1));
    if (f.skip) return [`${label}: ${f.skip}`];
    const t = readSmall(f.path, label);
    return 'error' in t ? [t.error] : identityProblemsIn(t.text, label);
  })];
}

const yamlIn = (d: string): string[] => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.yaml')).sort() : []);
export function listPresets(root: string): { id: string; description: string; where: 'shipped' | 'repo' }[] {
  return presetDirs(root).flatMap((d, i) => yamlIn(d).flatMap((f) => {
    try {
      const t = readSmall(join(d, f), f);
      if ('error' in t) return [];
      const y = parse(t.text) as { id?: unknown; description?: unknown };
      return typeof y?.id === 'string' && f === `${y.id}.yaml` ? [{ id: y.id, description: typeof y.description === 'string' ? y.description : '', where: i === 0 ? 'shipped' as const : 'repo' as const }] : [];
    } catch { return []; }
  }));
}
export function findPreset(id: string, root: string): string | null {
  if (!ID_RE.test(id)) return null;
  return presetDirs(root).map((d) => join(d, `${id}.yaml`)).find(existsSync) ?? null;
}

/** `always` is true; otherwise every key present must hold. */
export function appliesTo(aw: AppliesWhen, facts: Pick<Facts, 'deps' | 'frameworks'>, projectType: string): boolean {
  if (aw.always) return true;
  return (!aw.any_dep || aw.any_dep.some((d) => facts.deps.includes(d)))
    && (!aw.frameworks || aw.frameworks.some((f) => facts.frameworks.includes(f)))
    && (!aw.project_types || (aw.project_types as string[]).includes(projectType));
}

/** The core is counted with its markers, as mergeAgentsPreset writes it. Templates come from the preset folder. */
export function presetContext(l: LoadedPreset, ids: string[]): ContextEntry[] {
  const templates = join(l.base, 'templates');
  return ids.map((id) => {
    if (id === l.preset.core) return { id, tokens: estimateTokens(mergeAgentsPreset(null, readFileSync(join(templates, 'core.md'), 'utf8')).after) };
    return itemContext(l.items.find((i) => i.id === id)!, { templates });
  });
}

export const presetReason = (id: string): string => `Preselected by the ${id} preset`;

/** Stack-matched preselects the reviewer did not pick, then the core and the matched skills; all ticked. */
export function presetRows(l: LoadedPreset, c: Catalog, facts: Pick<Facts, 'deps' | 'frameworks'>, projectType: string, picked: string[], dirs: { templates: string }): ChecklistRow[] {
  const reason = presetReason(l.preset.id);
  const byId = new Map(c.items.map((i) => [i.id, i]));
  const pre = l.preset.preselect.filter((id) => !picked.includes(id) && appliesTo(byId.get(id)?.applies_when ?? {}, facts, projectType) && byId.has(id));
  const rows = pre.flatMap((id) => checklist({ catalog_version: 0, findings: [], items: [{ id, include: 'recommended', reason, addresses: [] }] }, c, dirs));
  const own = [l.preset.core, ...l.items.filter((i) => i.id !== l.preset.core && appliesTo(i.applies_when, facts, projectType)).map((i) => i.id)];
  const ctx = presetContext(l, own);
  return [...rows, ...own.map((id, n): ChecklistRow => ({
    id, title: l.items.find((i) => i.id === id)!.title, include: 'recommended', ticked: true, reason, cost: '', context: itemContextLine(ctx[n]),
    side_effects: [], unpinned: '', unpinned_reason: '', local_only: false, stance_reason: '', no_alternative: '',
  }))];
}
