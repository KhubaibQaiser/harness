import { esc } from '../core/config.js';
import { appliesTo, findPreset, loadPreset, presetReason, type LoadedPreset } from '../catalog/presets.js';
import type { Facts } from '../install/detect.js';
import type { Answers } from '../ai/answers.js';
import type { Picks } from '../ai/picks.js';
import type { Catalog } from '../catalog/schema.js';
import type { HarnessConfig } from '../core/config.js';
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
