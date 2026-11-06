import { esc } from '../core/config.js';
import { appliesTo, findPreset, loadPreset, presetReason, type LoadedPreset } from '../catalog/presets.js';
import type { Facts } from '../install/detect.js';
import type { Answers } from '../ai/answers.js';
import type { Picks } from '../ai/picks.js';
import type { Catalog } from '../catalog/schema.js';
import type { HarnessConfig } from '../core/config.js';
import { detect } from '../install/detect.js';
import { notPicked, resolveSelection } from '../install/select.js';

export interface PresetChoice { loaded: LoadedPreset; items: string[]; rest: string[]; reasons: Record<string, string> }

/**
 * Splits `chosen` into the preset's own items and the catalog ids. Own items must apply to the repo's stack;
 * the preset's catalog preselects count as picked, with the preset as their reason.
 */
export function splitPreset(id: string, facts: Facts, projectType: string, chosen: string[]): { ok: true; choice: PresetChoice } | { ok: false; errors: string[] } {
  const file = findPreset(id, facts.root);
  const lp = file ? loadPreset(file) : null;
  if (!lp) return { ok: false, errors: [`preset: "${esc(id)}" is not a shipped or repo preset (harness preset list shows them)`] };
  if (!lp.ok) return { ok: false, errors: lp.errors.map((e) => `preset: ${e}`) };
  const l = lp.loaded;
  const own = new Map(l.items.map((i) => [i.id, i]));
  const items = chosen.filter((c) => own.has(c));
  const errors = items.filter((c) => c !== l.preset.core && !appliesTo(own.get(c)!.applies_when, facts, projectType)).map((c) => `"${esc(c)}" does not apply to this repo's stack.`);
  if (errors.length) return { ok: false, errors };
  const reasons = Object.fromEntries(l.preset.preselect.map((p) => [p, presetReason(l.preset.id)]));
  return { ok: true, choice: { loaded: l, items, rest: chosen.filter((c) => !own.has(c)), reasons } };
}

/** Applies the preset (if the answers name one) to the `--choose` ids, then resolves the catalog ones. */
export function resolveChosen(a: Answers, facts: Facts, chosen: string[], picks: Picks, cat: Catalog, claudeVer: string | null): { ok: true; r: ReturnType<typeof resolveSelection>; pc?: PresetChoice } | { ok: false; errors: string[] } {
  let pc: PresetChoice | undefined;
  if (a.preset) {
    const s = splitPreset(a.preset, facts, a.project.type, chosen);
    if (!s.ok) return s;
    pc = s.choice;
  }
  const rest = pc ? pc.rest : chosen;
  const np = notPicked(rest, picks, cat, Object.keys(pc?.reasons ?? {}));
  if (np.length) return { ok: false, errors: np };
  const r = resolveSelection(rest, cat, claudeVer);
  return r.errors.length ? { ok: false, errors: r.errors } : { ok: true, r, pc };
}

/** `config.preset` for the chosen preset. */
export const presetConfig = (l: LoadedPreset, version: string, items: string[]): NonNullable<HarnessConfig['preset']> => ({ id: l.preset.id, version, items, git: l.preset.git });

/** The id of an own item that applies to the repo's stack (the core always does). */
const applies = (l: LoadedPreset, id: string, facts: Facts, projectType: string): boolean => id === l.preset.core || appliesTo(l.items.find((i) => i.id === id)!.applies_when, facts, projectType);

/**
 * What `update` plans the preset from. With AI answers the chosen preset (or none: turning it off drops `config.preset`) wins.
 * Without them the recorded preset is reloaded from its folder: items whose stack is gone are dropped, newly matching skills
 * are only noted. A folder that is gone or invalid leaves the preset's files as they are.
 */
export function updatePreset(config: HarnessConfig, sel: { preset?: LoadedPreset; presetItems: string[] } | null, root: string, version: string): { config: HarnessConfig; preset?: LoadedPreset; notices: string[]; changed: boolean } {
  if (sel) {
    const next = { ...config };
    delete next.preset;
    if (sel.preset) next.preset = presetConfig(sel.preset, version, sel.presetItems);
    return { config: next, preset: sel.preset, notices: [], changed: true };
  }
  const rec = config.preset;
  if (!rec) return { config, notices: [], changed: false };
  const file = findPreset(rec.id, root);
  const lp = file ? loadPreset(file) : null;
  if (!lp?.ok) return { config, notices: [lp ? `Preset "${esc(rec.id)}" is invalid (${lp.errors.join('; ')}); its files are kept as they are.` : `Preset "${esc(rec.id)}" was not found; its files are kept as they are.`], changed: false };
  const l = lp.loaded;
  const facts = detect(root);
  const items = rec.items.filter((id) => l.items.some((i) => i.id === id) && applies(l, id, facts, config.project.type));
  const fresh = l.preset.skills.filter((id) => !rec.items.includes(id) && applies(l, id, facts, config.project.type));
  return { config: { ...config, preset: { ...rec, items } }, preset: l, notices: fresh.map((id) => `Note: ${esc(id)} now applies here; run /harness:update and tick it to add it.`), changed: items.length !== rec.items.length };
}
