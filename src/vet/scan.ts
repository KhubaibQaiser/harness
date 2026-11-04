import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from '../core/config.js';
import type { Fetched } from './fetch.js';

export type Severity = 'high' | 'medium' | 'low';
export type Rule = 'hook-shell' | 'hook-http' | 'secrets' | 'unpinned-remote' | 'obfuscated' | 'network' | 'mcp-server' | 'permissions' | 'injection-text' | 'unsafe-archive' | 'license' | 'telemetry';
export interface VetFinding { severity: Severity; rule: Rule; file: string; line: number; text: string }
export interface ScanResult { target: string; repo: string; sha: string; path: string; kind: 'plugin' | 'skill' | 'repo'; findings: VetFinding[]; context: { tokens: number; unmeasured: string[] }; files: number; dir?: string }

/** Matched text for output: cut to 120 code points, controls and invisible/bidi characters escaped (esc does both). */
export const show = (s: string): string => esc([...s.slice(0, 480)].slice(0, 120).join(''));

/** Under the sub-path, or a repo-root file a plugin there loads (spec 3, step 4). */
export function inScope(rel: string, path: string): boolean {
  return path === '' || rel.startsWith(`${path}/`) || rel.startsWith('.claude-plugin/') || rel === '.mcp.json';
}

/** Original paths of `files`, `skipped` and `large` that are in scope; later rules read these, so out-of-scope entries never become findings. */
export function scoped(f: Fetched, path: string) {
  return { files: f.files.filter((p) => inScope(p, path)), skipped: f.skipped.filter((s) => inScope(s.path, path)), large: f.large.filter((p) => inScope(p, path)) };
}

// Every line test below is linear in the line length: a hostile 1 MB line must not stall vet (perf test).
const P = `(?:^|[\\s'"=:(/~<>])`; // what may precede a path token
const SECRET_RE = [
  new RegExp(`${P}\\.env(?:\\.[\\w-]+)*(?![\\w-])`),
  new RegExp(`${P}\\.(?:ssh|aws|netrc)\\b|${P}\\.config/gh\\b|\\bid_rsa\\b`),
  /\bsecurity\s+find-(?:generic|internet)-password\b|\bsecret-tool\s+lookup\b|\bgit\s+credential\s+(?:fill|get)\b/,
  /(?:^|[\s;&(])(?:printenv|env)\s*>/,
];
const ENV_CMD = /(?:^|[\s;&(])(?:printenv|env)\s*$/;
const NET_START = /^\s*(?:curl|wget|nc)\b/;
const SHELL_START = /^\s*(?:(?:sudo|env|xargs|exec|nohup|command|time)\b(?:\s+-\S+)*\s+)*(?:\S*\/)?(?:(?:ba|z|da|k|c)?sh|python[\d.]*|node|perl|ruby)\b/;
const FETCH = /\b(?:curl|wget)\b/;
const SUBST = /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b|(?:\b(?:ba|z|da|k)?sh\s+-c|\beval|\bsource|(?:^|\s)\.)\s+(?:["']?\$|<)\(\s*(?:curl|wget)\b/;
const LAUNCH = /\b(npx|bunx|uvx|pipx\s+run|npm\s+exec|pnpm\s+dlx|yarn\s+dlx|bun\s+x)\s+([^|;&\n)]*)/g;
const FROM = new Set(['-p', '--package', '--from', '--spec']);
const WITH = new Set(['--with']);
const SKIP = new Set(['--python', '-c', '--call', '--registry', '--cache', '--userconfig', '--node-options']);
const unq = (t: string) => t.replace(/^['"]|['"]$/g, '');
const SEG = /(?<!\|)\|(?!\|)/;

/** True when a launcher (npx, uvx, ...) in `rest` fetches a package that is not pinned to an exact version. */
function launcherUnpinned(l: string, rest: string): boolean {
  const pin = /^(?:uvx|pipx)/.test(l) ? /==\d+(\.\d+)*$/ : /@\d+\.\d+\.\d+$/;
  const tk = rest.slice(0, 2000).split(/\s+/).filter(Boolean);
  const pkgs: string[] = [];
  let from = false, pos = '';
  for (let i = 0; i < tk.length; i++) {
    const t = unq(tk[i]!);
    const eq = /^(--[a-z]+)=(.*)$/.exec(t) ?? (/^-p=(.*)$/.exec(t) && ['', '-p', t.slice(3)]);
    const flag = eq ? eq[1]! : t;
    const val = eq ? unq(eq[2]!) : undefined;
    if (FROM.has(flag) || WITH.has(flag)) {
      if (FROM.has(flag)) from = true;
      const v = val ?? unq(tk[++i] ?? '');
      if (v) pkgs.push(v);
    } else if (SKIP.has(flag)) { if (val === undefined) i++; }
    else if (!t.startsWith('-')) { pos = t; break; }
  }
  if (!from && pos) pkgs.push(pos);
  return pkgs.some((p) => !/^(?:\.|\/|file:)/.test(p) && !pin.test(p));
}

/** Fetch-then-run and pipe-to-shell forms of one line. `carry` is true when the previous line ended in a pipe after curl/wget. */
function piped(line: string, carry: boolean): boolean {
  if (SUBST.test(line)) return true;
  let seen = carry;
  for (const seg of line.split(SEG)) {
    if (seen && SHELL_START.test(seg.slice(0, 512))) return true;
    if (FETCH.test(seg)) seen = true;
  }
  // download then run: curl -o f u && sh f / ./f
  const cmds = line.split(/&&|;|\|\|/);
  for (let i = 0; i < cmds.length; i++) {
    const out = FETCH.test(cmds[i]!) && /(?:\s-[oO]\s*|\s>\s*|--output[ =])(\S+)/.exec(cmds[i]!);
    if (!out) continue;
    const f = unq(out[1]!).replace(/^\.\//, '');
    for (const c of cmds.slice(i + 1)) {
      const t = c.slice(0, 512).trim().split(/\s+/).map((x) => unq(x).replace(/^\.\//, ''));
      while (t[0] === 'sudo') t.shift();
      if (t[0] === f || (/^(?:(?:ba|z|da|k)?sh|source|\.)$/.test(t[0]!) && t.slice(1, 4).includes(f))) return true;
    }
  }
  return false;
}

/** Whole-line unpinned-remote test (not the pipe-continuation, which needs the previous line). */
function unpinned(line: string): boolean {
  for (const m of line.matchAll(LAUNCH)) if (launcherUnpinned(m[1]!, m[2]!)) return true;
  return piped(line, false);
}

/** env dumps sent elsewhere: `printenv | curl ...`. */
function envPiped(line: string): boolean {
  let seen = false;
  for (const seg of line.split(SEG)) {
    if (seen && NET_START.test(seg.slice(0, 64))) return true;
    if (ENV_CMD.test(seg)) seen = true;
  }
  return false;
}

/** Scripts, hooks, MCP configs and prompt files (skills, agents, commands) get the high text rules; docs do not (spec 4). */
const CODE = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|ps1)$/i;
const DIRS = new Set(['hooks', 'scripts', 'bin', 'skills', 'agents', 'commands', '.claude']);
const CONFIG = /(?:^|\/)(?:hooks\.json|plugin\.json|\.mcp\.json|settings(?:\.local)?\.json)$/;
function textRules(rel: string): boolean {
  const segs = rel.split('/'), base = segs[segs.length - 1]!;
  if (/\.json$/i.test(base)) return CONFIG.test(rel);
  if (CODE.test(base) || segs.slice(0, -1).some((s) => DIRS.has(s)) || /^SKILL\.md$/i.test(base)) return true;
  return !base.includes('.') && !/^(?:licen[sc]e|copying|readme|notice|changelog|authors)/i.test(base);
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
    const list = Array.isArray(groups) ? groups : [groups];
    const hooks = list.flatMap((g) => (isObj(g) && g.hooks !== undefined ? (Array.isArray(g.hooks) ? g.hooks : [g.hooks]) : [g]));
    for (const h of hooks) {
      if (!isObj(h)) continue;
      if (h.type === 'http' && typeof h.url === 'string') out.push({ severity: 'high', rule: 'hook-http', file, line: lineOf(text, JSON.stringify(h.url), evAt), text: show(`${ev}: ${h.url}`) });
      if (typeof h.command !== 'string' || (h.type !== undefined && h.type !== 'command')) continue;
      const line = lineOf(text, JSON.stringify(h.command), evAt);
      out.push({ severity: 'high', rule: 'hook-shell', file, line, text: show(`${ev}: ${h.command}`) });
      if (unpinned(h.command)) out.push({ severity: 'high', rule: 'unpinned-remote', file, line, text: show(h.command) });
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

/** Logical lines: a trailing backslash joins the next physical line. Each keeps the number of its first physical line. */
function joinContinuations(text: string): [string, number][] {
  const out: [string, number][] = [];
  let cur: [string, number] | undefined;
  text.split(/\r?\n/).forEach((l, i) => {
    const joined = cur ? cur[0] + l : l;
    cur = [joined, cur ? cur[1] : i + 1];
    if (l.endsWith('\\') && joined.length < 1_000_000) cur[0] = joined.slice(0, -1) + ' ';
    else { out.push(cur); cur = undefined; }
  });
  if (cur) out.push(cur);
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
    const bare = text.replace(/^\ufeff/, '');
    if (rel.endsWith('.json')) {
      let json: unknown;
      try { json = JSON.parse(bare); } catch { /* reported below for manifests */ }
      if (isObj(json)) findings.push(...hookShell(rel, bare, json), ...mcpRemote(rel, bare, json));
      else if (/(?:^|\/)(?:hooks\.json|plugin\.json|\.mcp\.json)$/.test(rel)) findings.push({ severity: 'medium', rule: 'obfuscated', file: rel, line: 0, text: 'manifest is not valid JSON, so its hooks and servers could not be read' });
    }
    if (!textRules(rel)) continue;
    let carry = false;
    const json = rel.endsWith('.json'); // structured rules above already judge hook commands and MCP servers
    joinContinuations(bare).forEach(([l, n]) => {
      if (SECRET_RE.some((re) => re.test(l)) || envPiped(l)) findings.push({ severity: 'high', rule: 'secrets', file: rel, line: n, text: show(l.trim()) });
      if (!json && (unpinned(l) || (carry && piped(l, true)))) findings.push({ severity: 'high', rule: 'unpinned-remote', file: rel, line: n, text: show(l.trim()) });
      carry = /\|\s*$/.test(l) && FETCH.test(l);
    });
  }
  const seen = new Set<string>();
  const uniq = findings.filter((x) => { const k = `${x.rule}\0${x.file}\0${x.line}\0${x.text}`; return !seen.has(k) && !!seen.add(k); });
  const all = uniq.map((x) => ({ ...x, file: esc(x.file) }));
  all.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line);
  const at = path ? `${path}/` : '';
  const kind = f.files.includes(`${at}.claude-plugin/plugin.json`) ? 'plugin' : f.files.includes(`${at}SKILL.md`) ? 'skill' : 'repo';
  return { kind, findings: all, context: { tokens: 0, unmeasured: [] }, files: files.length };
}
