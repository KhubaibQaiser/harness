import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Layer = { name: 'managed' | 'local' | 'project' | 'user'; json: unknown };

// https://code.claude.com/docs/en/managed-settings (file-based delivery).
export function managedSettingsPath(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

const readJson = (f: string): unknown => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// ponytail: managed-settings.d drop-ins, MDM profiles, the registry and server-managed settings are not read.
/** Claude Code's settings files, highest precedence first. `--settings` sits between managed and local; a hook can't see it. */
export function readSettingsLayers(root: string, home: string, platform: NodeJS.Platform, managed = managedSettingsPath(platform)): Layer[] {
  return [
    { name: 'managed', json: readJson(managed) },
    { name: 'local', json: readJson(join(root, '.claude/settings.local.json')) },
    { name: 'project', json: readJson(join(root, '.claude/settings.json')) },
    { name: 'user', json: readJson(join(home, '.claude/settings.json')) },
  ];
}

/** The value at `path` from the first layer that defines it. */
export function effective(layers: Layer[], path: string[]): unknown {
  for (const l of layers) {
    let v: unknown = l.json;
    for (const k of path) v = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}
