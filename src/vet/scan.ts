import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from '../core/config.js';
import { alwaysLoadedText, estimateTokens } from '../budget/measure.js';
import type { Fetched } from './fetch.js';

export type Severity = 'high' | 'medium' | 'low';
export type Rule = 'hook-shell' | 'hook-http' | 'secrets' | 'unpinned-remote' | 'invalid-manifest' | 'obfuscated' | 'network' | 'mcp-server' | 'permissions' | 'injection-text' | 'unsafe-archive' | 'license' | 'telemetry';
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

// Everything below is linear in the size of the file: a hostile 1 MB file must not stall vet (test/perf/vet-scan.test.ts).
const P = `(?:^|[\\s'"\`=:(/~<>,*{\\[])`; // what may precede a path token
const SECRET_RE = [
  new RegExp(`${P}\\.env(?:\\.[\\w-]+)*(?![\\w-])`),
  new RegExp(`${P}\\.(?:ssh|aws|netrc)\\b|${P}\\.config/gh\\b|\\bid_rsa\\b`),
  /\bsecurity\s+find-(?:generic|internet)-password\b|\bsecret-tool\s+lookup\b|\bgit\s+credential\s+(?:fill|get)\b/,
  /(?:^|[\s;&(`])(?:printenv|env)\s*>/,
];
const ENV_CMD = /(?:^|[\s;&(`])(?:printenv|env)(?=\s|$)/;
const NET_START = /^\s*(?:curl|wget|nc)\b/;
const SHELL_START = /^\s*&?\s*[("'`{]*\s*(?:(?:sudo|env|xargs|exec|nohup|command|time)\b(?:\s+-\S+)*\s+)*(?:\S*\/)?(?:(?:ba|z|da|k|c)?sh|python[\d.]*|node|perl|ruby)\b/;
const FETCH = /\b(?:curl|wget)\b/;
const SUBST = /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b|(?:\b(?:ba|z|da|k)?sh\s+-c|\beval|\bsource|(?:^|\s)\.)\s+(?:["']?\$\(|<\(|["']?`)\s*(?:curl|wget)\b/;
const OUT = /(?:\s-[a-zA-Z]*[oO]\s*|\s>\s*|--output[ =])(\S+)/;
const RUNNER = /^(?:(?:ba|z|da|k)?sh|source|\.)$/;
const LAUNCH = /\b(npx|bunx|uvx|pipx\s+run|npm\s+exec|pnpm\s+dlx|yarn\s+dlx|bun\s+x)\s+([^|;&\n)]*)/g;
const FROM = new Set(['-p', '--package', '--from', '--spec']);
const WITH = new Set(['--with']);
const SKIP = new Set(['--python', '-c', '--call', '--registry', '--cache', '--userconfig', '--node-options']);
const unq = (t: string) => t.replace(/^['"]|['"]$/g, '');
const norm = (t: string) => unq(t).replace(/^\.\//, '');
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

/**
 * unpinned-remote test for logical lines, fed in file order. It keeps two bits of state across lines: a pipe left open after
 * curl/wget (`carry`), and the file names downloads were written to (`outs`), so "download here, run later" is found in one pass.
 */
function lineChecker(): (line: string) => boolean {
  const outs = new Set<string>();
  let carry = false;
  return (line) => {
    if (!line.trim()) { carry = false; return false; } // blank: nothing to match, and it ends a continued pipe
    if (line.length < 5 && !carry && !outs.size) return false; // nothing in 4 characters can fetch, launch or run a download
    let hit = SUBST.test(line);
    let seen = carry;
    for (const seg of line.split(SEG)) {
      if (seen && SHELL_START.test(seg.slice(0, 256))) hit = true;
      if (FETCH.test(seg)) seen = true;
    }
    carry = line.trimEnd().endsWith('|') && (carry || FETCH.test(line));
    for (const c of line.split(/&&|;|\|\|/)) {
      if (outs.size) {
        const t = c.slice(0, 512).trim().split(/\s+/).map(norm);
        while (t[0] === 'sudo') t.shift();
        if (outs.has(t[0]!) || (RUNNER.test(t[0]!) && t.slice(1, 4).some((x) => outs.has(x)))) hit = true;
      }
      if (FETCH.test(c)) {
        const m = OUT.exec(c);
        const f = m ? norm(m[1]!) : '';
        if (f && f !== '-') outs.add(f);
      }
    }
    for (const m of line.matchAll(LAUNCH)) if (launcherUnpinned(m[1]!, m[2]!)) hit = true;
    return hit;
  };
}
const unpinned = (cmd: string): boolean => lineChecker()(cmd);

/** env dumps sent elsewhere: `printenv X | curl ...`, `env -0 | curl ...`. */
function envPiped(line: string): boolean {
  let seen = false;
  for (const seg of line.split(SEG)) {
    if (seen && NET_START.test(seg.slice(0, 64))) return true;
    if (ENV_CMD.test(seg)) seen = true;
  }
  return false;
}
const secretHit = (l: string): boolean => SECRET_RE.some((re) => re.test(l)) || envPiped(l);

/**
 * What the text rules read. Fails closed: every in-scope text file except prose docs. `rel` is relative to the scanned path,
 * so an item that itself lives under docs/ is still scanned.
 */
const PROSE = /^(?:readme|license|licence|changelog|contributing|code_of_conduct|security)/i;
const ALWAYS = /^(?:skills|agents|commands|output-styles|\.claude[^/]*)$/i;
function textRules(rel: string, text: string): boolean {
  const segs = rel.split('/'), dirs = segs.slice(0, -1);
  if (dirs.some((s) => ALWAYS.test(s)) || text.startsWith('#!')) return true;
  return !PROSE.test(segs[segs.length - 1]!) && !dirs.some((s) => s.toLowerCase() === 'docs');
}

/** Line numbers for offsets, found by looking forward from the last hit; gives up after one miss (escaped text) and uses the last hit's line. */
function lineIndex(text: string): (off: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}
function finder(text: string): (needle: string) => number {
  const lineAt = lineIndex(text);
  let cursor = 0, dead = false;
  return (needle) => {
    if (!dead) {
      const i = text.indexOf(needle, cursor);
      if (i >= 0) { cursor = i + 1; return lineAt(i); }
      dead = true;
    }
    return lineAt(cursor);
  };
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text rules for one command string from a JSON config. `tag` prefixes the shown text (a package.json script name). */
function cmdFindings(file: string, line: number, cmd: string, tag = ''): VetFinding[] {
  const out: VetFinding[] = [];
  const text = show(tag ? `${tag}: ${cmd}` : cmd);
  if (secretHit(cmd)) out.push({ severity: 'high', rule: 'secrets', file, line, text });
  if (unpinned(cmd)) out.push({ severity: 'high', rule: 'unpinned-remote', file, line, text });
  if (PERMS.test(cmd)) out.push({ severity: 'medium', rule: 'permissions', file, line, text });
  return out;
}

/** hook-shell, hook-http: every hook under a top-level `hooks`, one finding per hook with its event. */
function hookShell(file: string, text: string, json: Record<string, unknown>): VetFinding[] {
  if (!isObj(json.hooks)) return [];
  const out: VetFinding[] = [];
  const at = finder(text);
  for (const [ev, groups] of Object.entries(json.hooks)) {
    at(JSON.stringify(ev));
    const list = Array.isArray(groups) ? groups : [groups];
    const hooks = list.flatMap((g) => (isObj(g) && g.hooks !== undefined ? (Array.isArray(g.hooks) ? g.hooks : [g.hooks]) : [g]));
    for (const h of hooks) {
      if (!isObj(h)) continue;
      if (h.type === 'http' && typeof h.url === 'string') out.push({ severity: 'high', rule: 'hook-http', file, line: at(JSON.stringify(h.url)), text: show(`${ev}: ${h.url}`) });
      if (typeof h.command !== 'string' || (h.type !== undefined && h.type !== 'command')) continue;
      const line = at(JSON.stringify(h.command));
      out.push({ severity: 'high', rule: 'hook-shell', file, line, text: show(`${ev}: ${h.command}`) }, ...cmdFindings(file, line, h.command));
    }
  }
  return out;
}

/** A plugin .mcp.json may list its servers at the top level, with no mcpServers wrapper. */
const directMcp = (file: string, json: Record<string, unknown>) => /(?:^|\/)\.mcp\.json$/.test(file) && !('mcpServers' in json);

/** MCP servers: one medium finding each, and `command + args` is what launches (checked for secrets and unpinned fetches). */
function mcpRemote(file: string, text: string, json: Record<string, unknown>): VetFinding[] {
  const servers = isObj(json.mcpServers) ? json.mcpServers : directMcp(file, json) ? json : undefined;
  if (!servers) return [];
  const out: VetFinding[] = [];
  const at = finder(text);
  for (const [name, s] of Object.entries(servers)) {
    if (!isObj(s)) continue;
    const line = at(JSON.stringify(name));
    const cmd = typeof s.command === 'string' ? [s.command, ...(Array.isArray(s.args) ? s.args.map(String) : [])].join(' ') : typeof s.url === 'string' ? s.url : '';
    if (cmd) out.push({ severity: 'medium', rule: 'mcp-server', file, line, text: show(`${name}: ${cmd}`) });
    if (typeof s.command === 'string') out.push(...cmdFindings(file, at(JSON.stringify(s.command)), cmd));
  }
  return out;
}

/** permissions.allow: one medium finding per rule. */
function allowRules(file: string, text: string, json: Record<string, unknown>): VetFinding[] {
  const allow = isObj(json.permissions) ? json.permissions.allow : undefined;
  if (!Array.isArray(allow)) return [];
  const at = finder(text);
  return allow.filter((r): r is string => typeof r === 'string').map((r) => ({ severity: 'medium', rule: 'permissions', file, line: at(JSON.stringify(r)), text: show(`allow: ${r}`) }));
}

/** package.json lifecycle scripts run on `npm install`; the other scripts only run when asked. */
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack'];
function pkgScripts(file: string, text: string, json: Record<string, unknown>): VetFinding[] {
  if (!isObj(json.scripts) || !/(?:^|\/)package\.json$/.test(file)) return [];
  const at = finder(text);
  return LIFECYCLE.flatMap((k) => (typeof (json.scripts as Record<string, unknown>)[k] === 'string' ? cmdFindings(file, at(JSON.stringify(k)), (json.scripts as Record<string, string>)[k]!, k) : []));
}

/** Logical lines: a trailing backslash joins the next physical line. Each keeps the number of its first physical line. */
function joinContinuations(text: string): [string, number][] {
  const out: [string, number][] = [];
  let parts: string[] = [], start = 0;
  text.split(/\r?\n/).forEach((l, i) => {
    if (!parts.length) start = i + 1;
    if (l.endsWith('\\')) { parts.push(l.slice(0, -1), ' '); return; }
    if (!parts.length) { out.push([l, start]); return; }
    parts.push(l);
    out.push([parts.join(''), start]);
    parts = [];
  });
  if (parts.length) out.push([parts.join(''), start]);
  return out;
}

/** Index of the first run of `re`-class characters at least `n` long (or of a hex-only word that long), else -1. Token scan, so it stays linear. */
function longRun(l: string, re: RegExp, n: number, hexOnly = false): number {
  // One repeated character (a `////` banner) is not an encoded payload.
  for (const m of l.matchAll(re)) if (m[0].length >= n && (!hexOnly || /^[0-9a-fA-F]+$/.test(m[0])) && !/^(.)\1*$/s.test(m[0])) return m.index;
  return -1;
}
const idx = (re: RegExp) => (l: string) => l.search(re);
const NETWORK = /\bhttps?:\/\/\S|\bfetch\s*\(|\baxios\.|\bhttps?\.request\s*\(|\brequests\.(?:get|post|put|patch|delete|head)\s*\(|\bnew\s+WebSocket\s*\(|(?:^|[;&|(`])\s*nc\s+\S+\s+\d/;
const PERMS = /permissionDecision["']?\s*[:=]\s*["']?allow|--dangerously-skip-permissions/;
// Run once over the whole file, so a phrase split over lines is still found. \s+ is linear (no nested quantifiers).
const INJECT = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]|<!--|ignore\s+previous\s+instructions|do\s+not\s+tell\s+the\s+user|system\s+prompt/giu;
const OBFUSCATED = [(l: string) => longRun(l, /[A-Za-z0-9+/]+/g, 200), (l: string) => longRun(l, /\w+/g, 200, true), idx(/\beval\s*\(|\bnew\s+Function\s*\(/)];
const obfuscated = (l: string): number => { for (const f of OBFUSCATED) { const i = f(l); if (i >= 0) return i; } return -1; };
const TELEMETRY = /POSTHOG|TELEMETRY|@segment\/|mixpanel|@sentry\/|opentelemetry/i;
const OPT_OUT = /DO_NOT_TRACK|TELEMETRY_DISABLED|OPT_?OUT|--no-telemetry/i;
// [rule, first hit index, key for the cap, text prefix]
type LineRule = [VetFinding['rule'], (l: string) => number, string?, string?];
const PROMPT_DIR = /^(?:skills|agents|commands|output-styles)$/i;
const MIN_DIR = /^(?:skills|agents|commands|hooks|scripts)$/i;

/** Lockfiles are data, but only a file whose content says it is one: a script named yarn.lock is still scanned. */
const LOCK_NAME = /(?:^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/;
function isLock(rel: string, text: string, obj: Record<string, unknown> | undefined): boolean {
  const name = LOCK_NAME.exec(rel)?.[1];
  if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') return !!obj && 'lockfileVersion' in obj;
  if (name === 'bun.lock') return /^\s*\{\s*"lockfileVersion"\s*:/.test(text);
  if (name === 'pnpm-lock.yaml') return /^\s*lockfileVersion:/.test(text);
  return name === 'yarn.lock' && /^# yarn lockfile|^__metadata:/m.test(text);
}
/**
 * In a lockfile, only lockfile data is exempt from network: a trimmed line whose whole value is a resolved/resolution/tarball/integrity
 * entry (`"resolved": "..."`, yarn `resolved "..."`, pnpm `resolution: {tarball: ...}`, `tarball: ...`). Values cannot hold ( ) ; ' or `,
 * so a call never passes as data. Each part is delimited by a different character, so the match stays linear.
 */
const LOCK_KEYS = new Set(['resolved', 'resolution', 'tarball', 'integrity']);
const LOCK_LINE = /^(?:"(?:resolved|resolution|tarball|integrity)"\s*:|(?:resolved|resolution|tarball|integrity)\b:?)\s*(?:"[^"`\\();'$]*"|\{[\w :,./@+=#%~-]*\}|[\w:./@+=#%~?&-]+),?$/;
const lockNet = (l: string): number => (LOCK_LINE.test(l.trim()) ? -1 : l.search(NETWORK));
// Top-level metadata keys of a manifest hold the author's own links; mcpServers is already reported as mcp-server.
const META_FILE = /(?:^|\/)(?:package\.json|\.claude-plugin\/plugin\.json|marketplace\.json)$/;
const META = new Set(['homepage', 'repository', 'bugs', 'author', 'contributors', 'funding', 'license']);
/** `key` tells the cap which kind of hit this is: injection comments, hidden characters and phrases are counted apart. */
type Add = (rule: string, mk: () => VetFinding, key?: string) => void;
const KIND: Record<string, string> = { hidden: 'hidden characters', comment: 'comments' };
const kindName = (k: string): string => (k.startsWith('phrase:') ? `phrase "${esc(k.slice(7))}"` : KIND[k] ?? k);
const NET_CAP = 20; // per rule per file, so a hostile file cannot flood the report

/** network for a parsed JSON file: string values only (iterative, so deep nesting cannot overflow), manifest metadata skipped. */
function netJson(file: string, text: string, json: Record<string, unknown>, add: Add, lock: boolean): void {
  const at = finder(text);
  const direct = directMcp(file, json), meta = META_FILE.test(file);
  // [value, inside the top-level hooks]; a hook-http url is reported as hook-http, not again here
  const stack: [unknown, boolean][] = Object.entries(json)
    .filter(([k, v]) => k !== 'mcpServers' && !(meta && META.has(k)) && !(direct && isObj(v) && (typeof v.command === 'string' || typeof v.url === 'string')))
    .map(([k, v]): [unknown, boolean] => [v, k === 'hooks']).reverse();
  while (stack.length) {
    const [v, hk] = stack.pop()!;
    if (typeof v === 'string') { if (NETWORK.test(v)) add('network', () => ({ severity: 'medium', rule: 'network', file, line: at(JSON.stringify(v)), text: show(v) })); }
    else if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], hk]);
    else if (isObj(v)) { const es = Object.entries(v).filter(([k, x]) => !(hk && k === 'url' && v.type === 'http') && !(lock && typeof x === 'string' && LOCK_KEYS.has(k))); for (let i = es.length - 1; i >= 0; i--) stack.push([es[i]![1], hk]); }
  }
}

/** injection-text over the whole file: one finding per line per kind of hit. After the cap a hit costs one indexOf, not a line lookup. */
function injection(file: string, text: string, add: Add): void {
  const lineAt = lineIndex(text);
  const ends: Record<string, number> = {};
  for (const m of text.matchAll(INJECT)) {
    // each phrase has its own cap, so benign "system prompt" lines cannot bury "ignore previous instructions"
    const kind = m[0].length === 1 || m[0].length === 2 ? 'hidden' : m[0] === '<!--' ? 'comment' : `phrase:${m[0].toLowerCase().replace(/\s+/g, ' ')}`;
    if (m.index < (ends[kind] ?? -1)) continue;
    const nl = text.indexOf('\n', m.index);
    ends[kind] = nl < 0 ? Infinity : nl;
    add('injection-text', () => ({ severity: 'medium', rule: 'injection-text', file, line: lineAt(m.index), text: show(text.slice(Math.max(0, m.index - 30), m.index + 150).trim()) }), `injection-text/${kind}`);
  }
}

/** Prompt files: anything under skills/, agents/ or commands/, or under a scan root that is one (or a skill folder). */
const isPrompt = (inner: string, rootPrompt: boolean) => rootPrompt || inner.split('/').slice(0, -1).some((d) => PROMPT_DIR.test(d));

/** Medium rules that read one logical line: at most one finding per rule per line, the text starts a little before the hit. */
function lineRules(inner: string, json: boolean, rootPrompt: boolean, lock: boolean): LineRule[] {
  const r: LineRule[] = [['obfuscated', obfuscated], ['telemetry', idx(TELEMETRY)], ['telemetry', idx(OPT_OUT), 'telemetry/opt-out', 'opt-out: ']];
  if (!json) r.push(['permissions', idx(PERMS)]); // parsed JSON: judged on the unescaped command strings (cmdFindings)
  if (!json && (!/\.md$/i.test(inner) || isPrompt(inner, rootPrompt))) r.push(['network', lock ? lockNet : idx(NETWORK)]);
  return r;
}

const SEV = { high: 0, medium: 1, low: 2 };
const LOW_RULES = new Set(['license', 'telemetry']);

/** Hash of recognised OSI licence texts, matched on the first 4 KB only (linear: plain alternations). */
const LICENCES = [
  /Permission is hereby granted, free of charge/i, /Apache License[\s\S]*Version 2\.0/i, /Redistribution and use in source and binary forms/i,
  /GNU (?:LESSER |AFFERO )?GENERAL PUBLIC LICENSE/i, /Mozilla Public License/i, /Permission to use, copy, modify, and\/or distribute/i, /This is free and unencumbered software/i,
];
const LICENCE_NAME = /^(?:licen[cs]e(?:\..*)?|copying)$/i;
/** Looked for at the target path and at the repo root; either one recognised means no finding. */
function licence(f: Fetched, path: string): VetFinding[] {
  const found = [...new Set([path, ''])].flatMap((d) => f.files.filter((p) => (d ? p.startsWith(`${d}/`) : true) && !p.slice(d ? d.length + 1 : 0).includes('/') && LICENCE_NAME.test(p.slice(d ? d.length + 1 : 0))));
  for (const p of found) {
    try {
      const head = readFileSync(join(f.dir, ...(f.map[p] ?? p).split('/'))).subarray(0, 4096).toString('utf8');
      if (LICENCES.some((re) => re.test(head))) return [];
    } catch { /* unreadable: counts as unrecognised */ }
  }
  return [found.length ? { severity: 'low', rule: 'license', file: found[0]!, line: 0, text: 'not an OSI licence (unrecognised text)' } : { severity: 'low', rule: 'license', file: '', line: 0, text: 'no licence file' }];
}

const CTX_HOOKS = new Set(['SessionStart', 'UserPromptSubmit']);
const ctxKind = (inner: string): 'skill' | 'agent' | undefined => {
  const segs = inner.split('/');
  if (!/\.md$/i.test(inner)) return undefined;
  if (segs[segs.length - 1] === 'SKILL.md') return 'skill';
  const dirs = segs.slice(0, -1).map((d) => d.toLowerCase());
  return dirs.includes('agents') ? 'agent' : dirs.includes('commands') ? 'skill' : undefined;
};
const MANIFEST = /(?:^|\/)(?:hooks\.json|plugin\.json|\.mcp\.json|settings(?:\.local)?\.json)$/;

export function scan(f: Fetched, path: string): Omit<ScanResult, 'target' | 'repo' | 'sha' | 'path' | 'dir'> {
  const { files, skipped } = scoped(f, path);
  const findings: VetFinding[] = licence(f, path);
  let tokens = 0;
  const unmeasured = new Set<string>();
  const rootPrompt = path.split('/').some((d) => PROMPT_DIR.test(d)) || f.files.includes(`${path ? `${path}/` : ''}SKILL.md`);
  for (const rel of files) {
    // Medium line findings: at most NET_CAP per rule per file are built; the rest are only counted, for the summary.
    const counts = new Map<string, number>();
    const add: Add = (rule, mk, key = rule) => { const c = (counts.get(key) ?? 0) + 1; counts.set(key, c); if (c <= NET_CAP) findings.push(mk()); };
    let text: string, size = 0;
    try {
      const buf = readFileSync(join(f.dir, ...(f.map[rel] ?? rel).split('/')));
      if (buf.subarray(0, 8192).includes(0)) continue;
      text = buf.toString('utf8');
      size = buf.length;
    } catch { continue; }
    const bare = text.replace(/^﻿/, '');
    let textScan = true, obj: Record<string, unknown> | undefined;
    if (/\.json$/i.test(rel)) {
      let json: unknown;
      try { json = JSON.parse(bare); } catch { /* reported below */ }
      if (isObj(json)) {
        // Parsed: the structured rules judge hook commands, MCP servers and lifecycle scripts; the rest is data.
        findings.push(...hookShell(rel, bare, json), ...mcpRemote(rel, bare, json), ...allowRules(rel, bare, json), ...pkgScripts(rel, bare, json));
        obj = json;
        if (isObj(json.hooks)) for (const [ev, g] of Object.entries(json.hooks)) if (CTX_HOOKS.has(ev) && JSON.stringify(g).includes('"command"')) unmeasured.add(`${rel}: ${ev} hook`);
        textScan = false;
      } else if (MANIFEST.test(rel)) {
        findings.push({ severity: 'medium', rule: 'invalid-manifest', file: rel, line: 0, text: 'not valid JSON, so its hooks and servers could not be read' });
      }
    }
    const inner = path && rel.startsWith(`${path}/`) ? rel.slice(path.length + 1) : rel;
    const ck = ctxKind(inner);
    if (ck) tokens += estimateTokens(alwaysLoadedText(ck, bare));
    if (!textRules(inner, bare)) continue;
    const lock = isLock(rel, bare, obj);
    if (obj) netJson(rel, bare, obj, add, lock);
    const check = lineChecker(), med = lineRules(inner, !textScan, rootPrompt, lock);
    const minified = size > 5120 && /\.js$/i.test(rel) && inner.split('/').slice(0, -1).some((d) => MIN_DIR.test(d));
    let mini = false;
    for (const [l, n] of joinContinuations(bare)) {
      if (!l) { check(l); continue; } // blank: only ends a continued pipe
      if (textScan && l.length >= 4 && secretHit(l)) // 4 = the shortest secret pattern
        findings.push({ severity: 'high', rule: 'secrets', file: rel, line: n, text: show(l.trim()) });
      if (textScan && check(l)) findings.push({ severity: 'high', rule: 'unpinned-remote', file: rel, line: n, text: show(l.trim()) });
      if (l.length < 5) continue; // the shortest medium pattern is `eval(`
      for (const [rule, at, key, pre] of med) {
        const i = at(l);
        if (i >= 0) add(rule, () => ({ severity: LOW_RULES.has(rule) ? 'low' : 'medium', rule, file: rel, line: n, text: show(pre ? pre + l.trim() : l.slice(Math.max(0, i - 30)).trim()) }), key);
      }
      if (minified && !mini && l.length > 1000) { mini = true; findings.push({ severity: 'medium', rule: 'obfuscated', file: rel, line: n, text: 'minified JS' }); }
    }
    if (/\.md$/i.test(rel) && (isPrompt(inner, rootPrompt) || /(?:^|\/)SKILL\.md$/.test(inner))) injection(rel, bare, add);
    for (const [key, c] of counts) {
      if (c <= NET_CAP) continue;
      const [rule, kind] = key.split('/') as [VetFinding['rule'], string | undefined];
      findings.push({ severity: LOW_RULES.has(rule) ? 'low' : 'medium', rule, file: rel, line: 0, text: `${c - NET_CAP} more ${key === 'network' ? 'network URLs' : `${rule} findings${kind ? ` (${kindName(kind)})` : ''}`} in this file` });
    }
  }
  for (const s of skipped) findings.push({ severity: 'medium', rule: 'unsafe-archive', file: s.path, line: 0, text: show(s.why) });
  const seen = new Set<string>();
  const uniq = findings.filter((x) => { const k = `${x.rule}\0${x.file}\0${x.line}\0${x.text}`; return !seen.has(k) && !!seen.add(k); });
  const all = uniq.map((x) => ({ ...x, file: esc(x.file) }));
  all.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line);
  const at = path ? `${path}/` : '';
  const kind = f.files.includes(`${at}.claude-plugin/plugin.json`) ? 'plugin' : f.files.includes(`${at}SKILL.md`) ? 'skill' : 'repo';
  return { kind, findings: all, context: { tokens, unmeasured: [...unmeasured].sort() }, files: files.length };
}
