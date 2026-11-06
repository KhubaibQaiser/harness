import { esc } from '../core/config.js';
import { appliesTo, findPreset, loadPreset, presetReason, type LoadedPreset } from '../catalog/presets.js';
import type { Facts } from '../install/detect.js';

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
