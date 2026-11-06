import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedPreset } from '../catalog/presets.js';
import { PRESET_START, mergeAgents, mergeAgentsPreset, mergePresetSettings, presetSets, removeBlocks } from './merge.js';

const HARNESS_START = '<!-- harness:start -->';
export const PRESET_ITEM = 'preset:';

/** The preset's text files, read with LF endings so the bytes and the manifest hash match on every OS. */
const text = (l: LoadedPreset, ...p: string[]): string => readFileSync(join(l.base, 'templates', ...p), 'utf8').replace(/\r\n/g, '\n');

/** The skill files of the installed preset items (the core has none; its text is core.md). */
export function presetFiles(l: LoadedPreset, ids: string[]): { to: string; content: string }[] {
  return l.items.filter((i) => ids.includes(i.id)).flatMap((i) => (i.source.type === 'own' ? i.source.files ?? [] : []).map((f) => ({ to: f.to, content: text(l, ...f.from.split('/')) })));
}

/**
 * AGENTS.md built once: the harness block when `harness` is on (else the recorded harness blocks are cut), the preset block
 * when a preset is loaded (else a recorded one is cut, so turning the preset off removes it).
 */
export function mergeAgentsFile(before: string | null, o: { harness: boolean; recorded: string[]; preset?: LoadedPreset; /** config.preset is set but its folder was not loaded: leave a recorded preset block alone. */ keep?: boolean }): { after: string; blocks: string[] } {
  const cut = (cur: string | null, marker: string) => (cur === null ? cur : removeBlocks(cur, o.recorded.filter((b) => b.includes(marker))));
  let cur = o.preset || o.keep ? before : cut(before, PRESET_START);
  const blocks: string[] = [];
  if (o.harness) {
    const h = mergeAgents(cur);
    cur = h.after;
    blocks.push(...h.blocks);
  } else cur = cut(cur, HARNESS_START);
  if (!o.preset) return { after: cur ?? '', blocks };
  const p = mergeAgentsPreset(cur, text(o.preset, 'core.md'));
  return { after: p.after, blocks: [...blocks, ...p.blocks] };
}

const isPresetSet = (b: string): boolean => { try { const s = JSON.parse(b)?.set; return Array.isArray(s) && s[0] !== 'sandbox'; } catch { return false; } };

/** The preset's settings keys chained after `before`; undefined when there is nothing to add or drop. */
export function mergeSettingsPreset(before: string, o: { preset?: LoadedPreset; selected: string[]; recorded: string[]; keep?: boolean }): ReturnType<typeof mergePresetSettings> | undefined {
  if (!o.preset && (o.keep || !o.recorded.some(isPresetSet))) return undefined;
  return mergePresetSettings(before, o.preset ? presetSets(o.preset, { selected: o.selected, env: true }) : [], o.recorded);
}
