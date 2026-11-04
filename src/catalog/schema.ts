import { defaults } from '../core/config.js';
import type { HarnessConfig } from '../core/config.js';

export type ItemKind = 'own-skill' | 'own-agent' | 'own-hook' | 'plugin' | 'mcp' | 'external-skill' | 'rule' | 'ci' | 'settings';
export type Level = 'none' | 'low' | 'medium' | 'high';
export type Stance = 'default' | 'optional' | 'discouraged';
export type ProjectType = 'web' | 'landing' | 'mobile' | 'api' | 'infra' | 'library' | 'other';
export const SIDE_EFFECTS = ['installs-hook', 'downloads-binary', 'telemetry-on-by-default', 'runs-arbitrary-python', 'network-service'] as const;

export type OwnSource = { type: 'own'; files?: { from: string; to: string }[]; checks?: (keyof HarnessConfig['checks'])[]; merge?: 'agents-md'[] };
export type OutsideSource =
  | { type: 'github'; repo: string; plugin: string; sha: string }
  | { type: 'git-subdir'; repo: string; path: string; plugin: string; sha: string }
  | { type: 'npm'; package: string; version: string }
  | { type: 'remote'; url: string; unpinned: string };

// Each key matches a field of Facts (Task 4).
export interface AppliesWhen { any_dep?: string[]; frameworks?: string[]; project_types?: ProjectType[]; always?: true }

export interface CatalogItem {
  id: string;
  kind: ItemKind;
  title: string;
  source: OwnSource | OutsideSource;
  license: string;
  min_claude_code: string;
  applies_when: AppliesWhen;
  conflicts_with: string[];
  requires: string[];
  cost: { context: Level; setup: Level };
  stance: Stance;
  stance_reason: string;
  side_effects: string[];
  why: string;
  evidence: string[];
  plugin_version?: string;
  mcp?: { name: string; config: Record<string, unknown> };
  /** Plugin only: the `lspServers` map of the marketplace entry, copied verbatim for the installer to emit. */
  lsp_servers?: Record<string, unknown>;
}
export interface Catalog { version: number; items: CatalogItem[] }

const KINDS: ItemKind[] = ['own-skill', 'own-agent', 'own-hook', 'plugin', 'mcp', 'external-skill', 'rule', 'ci', 'settings'];
const LEVELS: Level[] = ['none', 'low', 'medium', 'high'];
const STANCES: Stance[] = ['default', 'optional', 'discouraged'];
export const PROJECT_TYPES: ProjectType[] = ['web', 'landing', 'mobile', 'api', 'infra', 'library', 'other'];
const checkNames = () => Object.keys(defaults().checks); // lazy: config.ts imports this module
const SOURCE_TYPES = ['own', 'github', 'git-subdir', 'npm', 'remote'];
const FIT: Record<string, string[]> = { plugin: ['github', 'git-subdir'], 'external-skill': ['github', 'git-subdir'], mcp: ['npm', 'remote'] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const relPath = (p: unknown): boolean => str(p) && !p.includes('\\') && !p.startsWith('/') && !/(^|\/)\.\.(\/|$)/.test(p);
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function validateItem(raw: unknown, file: string): { ok: true; item: CatalogItem } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${file}: ${path ? `${path}: ` : ''}${msg}`);
  const unknownKeys = (o: Record<string, unknown>, known: string[], at: string) => {
    for (const k of Object.keys(o)) if (!known.includes(k)) err(at, `unknown key "${k}"`);
  };
  if (!isObj(raw)) return { ok: false, errors: [`${file}: must be a YAML mapping`] };
  unknownKeys(raw, ['id', 'kind', 'title', 'source', 'license', 'min_claude_code', 'applies_when', 'conflicts_with', 'requires', 'cost', 'stance', 'stance_reason', 'side_effects', 'why', 'evidence', 'plugin_version', 'mcp', 'lsp_servers'], '');
  for (const k of ['id', 'title', 'license', 'why']) if (!str(raw[k])) err(k, 'must be a non-empty string');
  if (str(raw.id) && !ID_RE.test(raw.id)) err('id', 'must be lowercase letters, digits and hyphens');
  if (!KINDS.includes(raw.kind as ItemKind)) err('kind', `must be one of ${KINDS.join(', ')}`);
  if (!str(raw.min_claude_code) || !SEMVER.test(raw.min_claude_code)) err('min_claude_code', 'must be a semver such as 2.1.0');
  if (!STANCES.includes(raw.stance as Stance)) err('stance', `must be one of ${STANCES.join(', ')}`);
  const reason = raw.stance_reason ?? '';
  if (typeof reason !== 'string') err('stance_reason', 'must be a string');
  else if (raw.stance === 'discouraged' && reason.trim() === '') err('stance_reason', 'required when stance is discouraged');
  for (const k of ['conflicts_with', 'requires', 'evidence']) if (raw[k] !== undefined && !strs(raw[k])) err(k, 'must be a list of strings');
  const fx = raw.side_effects ?? [];
  if (!strs(fx)) err('side_effects', 'must be a list of strings');
  else fx.forEach((s, i) => (SIDE_EFFECTS as readonly string[]).includes(s) || err(`side_effects[${i}]`, `must be one of ${SIDE_EFFECTS.join(', ')}`));
  if (raw.plugin_version !== undefined && !str(raw.plugin_version)) err('plugin_version', 'must be a non-empty string');

  const aw = raw.applies_when;
  if (!isObj(aw)) err('applies_when', 'must be a mapping');
  else {
    unknownKeys(aw, ['any_dep', 'frameworks', 'project_types', 'always'], 'applies_when');
    for (const k of ['any_dep', 'frameworks']) if (aw[k] !== undefined && !strs(aw[k])) err(`applies_when.${k}`, 'must be a list of strings');
    if (aw.project_types !== undefined && !(strs(aw.project_types) && aw.project_types.every((p) => PROJECT_TYPES.includes(p as ProjectType)))) err('applies_when.project_types', `must be a list of ${PROJECT_TYPES.join(', ')}`);
    if (aw.always !== undefined && aw.always !== true) err('applies_when.always', 'must be true');
  }
  const cost = raw.cost;
  if (!isObj(cost)) err('cost', 'must be a mapping with context and setup');
  else {
    unknownKeys(cost, ['context', 'setup'], 'cost');
    for (const k of ['context', 'setup']) if (!LEVELS.includes(cost[k] as Level)) err(`cost.${k}`, `must be one of ${LEVELS.join(', ')}`);
  }

  const src = raw.source;
  if (!isObj(src)) err('source', 'must be a mapping');
  else sourceErrors(src, (p, m) => err(`source${p}`, m), (o, known) => unknownKeys(o, known, 'source'));

  const kind = raw.kind as string;
  if (isObj(src) && KINDS.includes(kind as ItemKind) && SOURCE_TYPES.includes(src.type as string)) {
    const ok = FIT[kind] ?? ['own'];
    if (!ok.includes(src.type as string)) err('source.type', `kind ${kind} takes source type ${ok.join(' or ')}`);
  }
  if (raw.lsp_servers !== undefined && kind !== 'plugin') err('lsp_servers', 'only allowed for kind plugin');
  else if (raw.lsp_servers !== undefined && !(isObj(raw.lsp_servers) && Object.keys(raw.lsp_servers).length > 0)) err('lsp_servers', 'must be a non-empty mapping of server name to config');
  if (kind === 'mcp' && raw.mcp === undefined) err('mcp', 'required for kind mcp');
  else if (raw.mcp !== undefined && kind !== 'mcp') err('mcp', 'only allowed for kind mcp');
  else if (raw.mcp !== undefined) {
    const m = raw.mcp;
    if (!isObj(m)) err('mcp', 'must be a mapping with name and config');
    else {
      unknownKeys(m, ['name', 'config'], 'mcp');
      if (!str(m.name)) err('mcp.name', 'must be a non-empty string');
      if (!isObj(m.config)) err('mcp.config', 'must be a mapping');
      else configErrors(m.config, err);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, item: { conflicts_with: [], requires: [], evidence: [], side_effects: [], ...raw, stance_reason: reason } as unknown as CatalogItem };
}

/** A stdio server is { command, args?, env? }; a remote one is { type: http | sse, url, headers? }. */
function configErrors(c: Record<string, unknown>, err: (path: string, msg: string) => void): void {
  const map = (k: string) => c[k] === undefined || (isObj(c[k]) && Object.values(c[k] as object).every((v) => typeof v === 'string')) || err(`mcp.config.${k}`, 'must be a mapping of strings');
  if (c.command !== undefined) {
    for (const k of Object.keys(c)) if (!['command', 'args', 'env'].includes(k)) err('mcp.config', `unknown key "${k}"`);
    if (!str(c.command)) err('mcp.config.command', 'must be a non-empty string');
    if (c.args !== undefined && !strs(c.args)) err('mcp.config.args', 'must be a list of strings');
    map('env');
  } else if (c.url !== undefined || c.type !== undefined) {
    for (const k of Object.keys(c)) if (!['type', 'url', 'headers'].includes(k)) err('mcp.config', `unknown key "${k}"`);
    if (c.type === undefined) err('mcp.config', 'a url server needs type http or sse');
    else if (c.type !== 'http' && c.type !== 'sse') err('mcp.config.type', 'must be http or sse');
    if (!str(c.url) || !/^https:\/\//.test(c.url)) err('mcp.config.url', 'must be an https URL');
    map('headers');
  } else err('mcp.config', 'must have command (stdio) or type and url (remote)');
}

function sourceErrors(s: Record<string, unknown>, err: (path: string, msg: string) => void, unknown: (o: Record<string, unknown>, known: string[]) => void): void {
  const need = (k: string, msg = 'must be a non-empty string') => str(s[k]) || (err(`.${k}`, msg), false);
  const t = s.type;
  if (s.unpinned !== undefined && t !== 'remote') return err('.unpinned', 'only remote MCP sources may be unpinned');
  if (t === 'own') {
    unknown(s, ['type', 'files', 'checks', 'merge']);
    if (s.files !== undefined) {
      if (!Array.isArray(s.files)) err('.files', 'must be a list of { from, to }');
      else s.files.forEach((f, i) => {
        if (!isObj(f) || Object.keys(f).length !== 2) return err(`.files[${i}]`, 'must be { from, to }');
        for (const k of ['from', 'to']) if (!relPath(f[k])) err(`.files[${i}].${k}`, 'must be a relative path with / separators and no ..');
      });
    }
    if (s.checks !== undefined) {
      if (!strs(s.checks)) err('.checks', 'must be a list of check names');
      else s.checks.forEach((c, i) => checkNames().includes(c) || err(`.checks[${i}]`, 'must be a harness check name'));
    }
    if (s.merge !== undefined) {
      if (!Array.isArray(s.merge)) err('.merge', 'must be a list');
      else s.merge.forEach((m, i) => m === 'agents-md' || err(`.merge[${i}]`, 'must be agents-md'));
    }
  } else if (t === 'github' || t === 'git-subdir') {
    unknown(s, t === 'github' ? ['type', 'repo', 'plugin', 'sha'] : ['type', 'repo', 'path', 'plugin', 'sha']);
    if (!str(s.repo) || !/^[\w.-]+\/[\w.-]+$/.test(s.repo)) err('.repo', 'must be owner/name on GitHub');
    if (t === 'git-subdir') need('path');
    need('plugin');
    if (!str(s.sha) || !/^[0-9a-f]{40}$/.test(s.sha)) err('.sha', 'must be a 40-character lowercase hex commit');
  } else if (t === 'npm') {
    unknown(s, ['type', 'package', 'version']);
    need('package');
    if (!str(s.version) || !SEMVER.test(s.version)) err('.version', 'must be an exact semver such as 1.2.3');
  } else if (t === 'remote') {
    unknown(s, ['type', 'url', 'unpinned']);
    if (!str(s.url) || !/^https:\/\//.test(s.url)) err('.url', 'must be an https URL');
    need('unpinned', 'required: why this remote server cannot be pinned');
  } else err('.type', 'must be one of own, github, git-subdir, npm, remote');
}
