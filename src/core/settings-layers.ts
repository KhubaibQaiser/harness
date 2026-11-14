import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Layer = { name: 'managed' | 'local' | 'project' | 'user'; json: unknown; unreadable?: string }; // unreadable: the path of a file that exists but can't be read or parsed (json stays null)

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

const managedLayer = (f: string): Layer => {
  try {
    const json: unknown = JSON.parse(readFileSync(f, 'utf8'));
    return { name: 'managed', json, ...(typeof json === 'object' && json !== null && !Array.isArray(json) ? {} : { unreadable: f }) };
  } catch (e) {
    return { name: 'managed', json: null, ...(['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '') ? {} : { unreadable: f }) };
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
  return [...dropIns(dir).map((f) => managedLayer(join(dir, f))), managedLayer(managed)];
}

/**
 * Claude Code's config dir: `CLAUDE_CONFIG_DIR`, else `HARNESS_CLAUDE_CONFIG_DIR` (the launcher's mirror: the subprocess
 * env scrub strips `CLAUDE_CONFIG_DIR` from hooks), else `~/.claude`.
 */
export const claudeConfigDir = (home: string, env: NodeJS.ProcessEnv): string =>
  env.CLAUDE_CONFIG_DIR || env.HARNESS_CLAUDE_CONFIG_DIR || join(home, '.claude');

/** Claude Code's user settings file in `claudeConfigDir`. */
export const userSettingsPath = (home: string, env: NodeJS.ProcessEnv): string => join(claudeConfigDir(home, env), 'settings.json');

/**
 * `env` without a `HARNESS_CLAUDE_CONFIG_DIR` that the repo's project or local settings set in their `env`: Claude Code
 * ignores `CLAUDE_CONFIG_DIR` there, so the repo can't name the mirror either. Files are read only when it is set.
 */
export function withoutRepoMirror(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.HARNESS_CLAUDE_CONFIG_DIR) return env;
  const set = ['settings.json', 'settings.local.json'].some((f) => {
    const e = (readJson(join(root, '.claude', f)) as { env?: unknown } | null)?.env;
    return typeof e === 'object' && e !== null && 'HARNESS_CLAUDE_CONFIG_DIR' in e;
  });
  return set ? { ...env, HARNESS_CLAUDE_CONFIG_DIR: undefined } : env;
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
