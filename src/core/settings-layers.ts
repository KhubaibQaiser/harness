import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

const dropIns = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort().reverse();
  } catch {
    return [];
  }
};

// ponytail: MDM profiles, the registry and server-managed settings are not read (a documented known limit).
/** The managed settings files, highest precedence first. The agent can't write them, so they are read from disk. */
export function readManagedLayers(managed: string): Layer[] {
  // Drop-ins merge alphabetically after managed-settings.json, so the last one wins: each is a layer, last first.
  const dir = join(dirname(managed), 'managed-settings.d');
  return [...dropIns(dir).map((f): Layer => ({ name: 'managed', json: readJson(join(dir, f)) })), { name: 'managed', json: readJson(managed) }];
}

/** Claude Code's user settings file: `$CLAUDE_CONFIG_DIR/settings.json` when that is set. */
export const userSettingsPath = (home: string, env: NodeJS.ProcessEnv): string => join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');

/** The value at `path` from the first layer that defines it. */
export function effective(layers: Layer[], path: string[]): unknown {
  for (const l of layers) {
    let v: unknown = l.json;
    for (const k of path) v = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}
