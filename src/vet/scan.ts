import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from '../core/config.js';
import type { Fetched } from './fetch.js';

export type Severity = 'high' | 'medium' | 'low';
export type Rule = 'hook-shell' | 'secrets' | 'unpinned-remote' | 'obfuscated' | 'network' | 'mcp-server' | 'permissions' | 'injection-text' | 'unsafe-archive' | 'license' | 'telemetry';
export interface VetFinding { severity: Severity; rule: Rule; file: string; line: number; text: string }
export interface ScanResult { target: string; repo: string; sha: string; path: string; kind: 'plugin' | 'skill' | 'repo'; findings: VetFinding[]; context: { tokens: number; unmeasured: string[] }; files: number; dir?: string }

/** Matched text for output: cut to 120 code points, controls and invisible/bidi characters escaped (esc does both). */
export const show = (s: string): string => esc([...s].slice(0, 120).join(''));

/** Under the sub-path, or a repo-root file a plugin there loads (spec 3, step 4). */
export function inScope(rel: string, path: string): boolean {
  return path === '' || rel.startsWith(`${path}/`) || rel.startsWith('.claude-plugin/') || rel === '.mcp.json';
}

/** Original paths of `files`, `skipped` and `large` that are in scope; later rules read these, so out-of-scope entries never become findings. */
export function scoped(f: Fetched, path: string) {
  return { files: f.files.filter((p) => inScope(p, path)), skipped: f.skipped.filter((s) => inScope(s.path, path)), large: f.large.filter((p) => inScope(p, path)) };
}

const ENV = /(?:^|[\s'"=:(/~])\.env(?:\.[\w-]+)*(?![\w-])/;
const SECRETS = [
  ENV,
  /\.ssh\/|\.aws\/|\.config\/gh\b|\bid_rsa\b|\.netrc\b/,
  /\bsecurity\s+find-(?:generic|internet)-password\b|\bsecret-tool\s+lookup\b|\bgit\s+credential\s+(?:fill|get)\b/,
  /\b(?:printenv|env)\b[^\n|]*\|\s*(?:curl|wget|nc)\b/,
];
const NPX = /\b(npx|bunx|uvx|pipx\s+run)\s+(?:-\S+\s+)*(\S+)/g;
const PIN = { npx: /@\d+\.\d+\.\d+$/, bunx: /@\d+\.\d+\.\d+$/, uvx: /==\d+(\.\d+)*$/, pipx: /==\d+(\.\d+)*$/ } as const;
const PIPE_SH = /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/;
const SUBST = /\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/;
const DL_RUN = /\b(?:curl|wget)\b[^\n]*?(?:\s-[oO]\s*|\s>\s*|--output\s+)(\S+)[^\n]*?(?:&&|;)\s*(?:(?:sudo\s+)?(?:ba|z|da)?sh\s+|\.\/|source\s+)\1(?!\S)/;

function unpinned(line: string): boolean {
  for (const m of line.matchAll(NPX)) {
    const pin = PIN[m[1]!.split(/\s/)[0] as keyof typeof PIN];
    if (!pin.test(m[2]!)) return true;
  }
  return PIPE_SH.test(line) || SUBST.test(line) || DL_RUN.test(line);
}

const lineOf = (text: string, needle: string, from = 0): number => {
  const i = text.indexOf(needle, from);
  return i < 0 ? 0 : text.slice(0, i).split('\n').length;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** hook-shell: every command hook under a top-level `hooks`, one finding per hook with its event. */
function hookShell(file: string, text: string, json: Record<string, unknown>): VetFinding[] {
  if (!isObj(json.hooks)) return [];
  const out: VetFinding[] = [];
  for (const [ev, groups] of Object.entries(json.hooks)) {
    const evAt = Math.max(0, text.indexOf(JSON.stringify(ev)));
    const list = Array.isArray(groups) ? groups : [];
    const hooks = list.flatMap((g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks : [g]));
    for (const h of hooks) {
      if (!isObj(h) || typeof h.command !== 'string' || (h.type !== undefined && h.type !== 'command')) continue;
      out.push({ severity: 'high', rule: 'hook-shell', file, line: lineOf(text, JSON.stringify(h.command), evAt), text: show(`${ev}: ${h.command}`) });
    }
  }
  return out;
}

/** unpinned-remote for MCP servers: `command + args` is what launches. */
function mcpRemote(file: string, text: string, json: Record<string, unknown>): VetFinding[] {
  if (!isObj(json.mcpServers)) return [];
  const out: VetFinding[] = [];
  for (const s of Object.values(json.mcpServers)) {
    if (!isObj(s) || typeof s.command !== 'string') continue;
    const cmd = [s.command, ...(Array.isArray(s.args) ? s.args.map(String) : [])].join(' ');
    if (unpinned(cmd)) out.push({ severity: 'high', rule: 'unpinned-remote', file, line: lineOf(text, JSON.stringify(s.command)), text: show(cmd) });
  }
  return out;
}

const SEV = { high: 0, medium: 1, low: 2 };

export function scan(f: Fetched, path: string): Omit<ScanResult, 'target' | 'repo' | 'sha' | 'path' | 'dir'> {
  const { files } = scoped(f, path);
  const findings: VetFinding[] = [];
  for (const rel of files) {
    let text: string;
    try {
      const buf = readFileSync(join(f.dir, ...(f.map[rel] ?? rel).split('/')));
      if (buf.subarray(0, 8192).includes(0)) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    if (rel.endsWith('.json')) {
      let json: unknown;
      try { json = JSON.parse(text); } catch { /* not JSON: scanned as text below */ }
      if (isObj(json)) findings.push(...hookShell(rel, text, json), ...mcpRemote(rel, text, json));
    }
    text.split(/\r?\n/).forEach((l, i) => {
      if (SECRETS.some((re) => re.test(l))) findings.push({ severity: 'high', rule: 'secrets', file: rel, line: i + 1, text: show(l.trim()) });
      if (unpinned(l)) findings.push({ severity: 'high', rule: 'unpinned-remote', file: rel, line: i + 1, text: show(l.trim()) });
    });
  }
  const seen = new Set<string>();
  const uniq = findings.filter((x) => { const k = `${x.rule}\0${x.file}\0${x.line}`; return !seen.has(k) && !!seen.add(k); });
  uniq.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line);
  const at = path ? `${path}/` : '';
  const kind = f.files.includes(`${at}.claude-plugin/plugin.json`) ? 'plugin' : f.files.includes(`${at}SKILL.md`) ? 'skill' : 'repo';
  return { kind, findings: uniq, context: { tokens: 0, unmeasured: [] }, files: files.length };
}
