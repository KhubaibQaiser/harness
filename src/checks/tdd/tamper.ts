// Anti-tampering: an edit may not weaken tests or coverage config to make them pass.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTestFile, toRepoPath } from '../../core/paths.js';
import type { Check } from '../../hooks/dispatch.js';
import { editTarget } from '../../hooks/edit-target.js';
import type { HookInput } from '../../hooks/types.js';

type Edit = { old_string?: unknown; new_string?: unknown; replace_all?: unknown };

// Content of the file after the tool call; unchanged if an old_string is missing (the edit itself will fail).
export function afterContent(input: Pick<HookInput, 'tool_name' | 'tool_input'>, current: string): string {
  const ti = input.tool_input ?? {};
  if (input.tool_name === 'Write') return typeof ti.content === 'string' ? ti.content : current;
  const edits: Edit[] = input.tool_name === 'MultiEdit' ? (Array.isArray(ti.edits) ? ti.edits : []) : [ti];
  let text = current;
  for (const e of edits) {
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string' || !e.old_string || !text.includes(e.old_string)) return current;
    text = e.replace_all === true ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string as string);
  }
  return text;
}

// ponytail: string-aware scanner. Template `${}` nesting is treated as part of the string, and regex literals are not recognised (a `/*` or quote inside one can confuse it).
function strip(s: string): string {
  let out = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === q || (c === '\n' && q !== '`')) q = '';
    } else if (c === '"' || c === "'" || c === '`') {
      q = c;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? s.length : e + 1;
    } else out += c;
  }
  return out;
}

const MARKERS: [string, RegExp][] = [
  ['.skip(', /\.skip(?=[.(])/g],
  ['.only(', /\.only(?=[.(])/g],
  ['.skipIf(', /\.skipIf\(/g],
  ['.runIf(', /\.runIf\(/g],
  ['.fails(', /\.fails\(/g],
  ['.todo(', /\.todo\(/g],
  ...['xit', 'xdescribe', 'xtest', 'fit', 'fdescribe'].map((m): [string, RegExp] => [`${m}(`, new RegExp(`\\b${m}\\(`, 'g')]),
];
const ASSERT = /\bexpect\s*\(|\bexpect\.(?:assertions|hasAssertions|soft)\s*\(|\bassert\s*\(|\bassert\.\w+\s*\(/g;
const LIT = `true|false|\\d+(?:\\.\\d+)?|"[^"\\n]*"|'[^'\\n]*'`;
const NOOP = new RegExp(`expect\\(\\s*(${LIT})\\s*\\)\\s*\\.(?:toBe|toEqual)\\(\\s*\\1\\s*\\)|expect\\(\\s*(?:${LIT})\\s*\\)\\s*\\.toBeTruthy\\(\\)`, 'g');
const THRESHOLD = /["']?\b(branches|functions|lines|statements)\b["']?\s*:\s*(\d+(?:\.\d+)?)/g;
const CONFIG = /(^|\/)(vitest\.(config|workspace)|jest\.config)\.[^/]+$/;
const PKG = /(^|\/)package\.json$/;
const SELECTION = ['include', 'exclude', 'testMatch', 'testPathIgnorePatterns', 'coveragePathIgnorePatterns'];

const count = (s: string, re: RegExp): number => s.match(re)?.length ?? 0;
// Each key with its value up to the end of the line, or through a following [...] array (may span lines), whitespace-normalised, sorted.
const selection = (s: string, key: string): string =>
  [...s.matchAll(new RegExp(`${key}(?:[^\\[\\n]*:[ \\t]*\\n\\s*)?[^\\[\\n]*(?:\\[[^\\]]*\\])?[^\\n]*`, 'g'))].map((m) => m[0].replace(/\s+/g, ' ').trim()).sort().join('\n');

function thresholds(b: string, a: string): string[] {
  const out: string[] = [];
  const vals = (s: string) => [...s.matchAll(THRESHOLD)].map((m) => [m[1]!, Number(m[2])] as const);
  const nowBy = new Map<string, number[]>();
  for (const [k, v] of vals(a)) nowBy.set(k, [...(nowBy.get(k) ?? []), v]);
  const seen = new Map<string, number>();
  for (const [k, was] of vals(b)) {
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    const now = nowBy.get(k)?.[i];
    if (now === undefined) out.push(`coverage threshold ${k} removed`);
    else if (now < was) out.push(`coverage threshold ${k} lowered ${was}→${now}`);
  }
  return out;
}

const KEYS = ['branches', 'functions', 'lines', 'statements'];
// jest.coverageThreshold flattened to path -> value (global and per-path); null when either side is not valid JSON.
function pkgThresholds(before: string, after: string): string[] | null {
  const flat = (text: string): Map<string, number> | null => {
    const m = new Map<string, number>();
    const walk = (o: unknown, path: string) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'number' && KEYS.includes(k)) m.set(`${path}/${k}`, v);
        else walk(v, `${path}/${k}`);
      }
    };
    try {
      walk((JSON.parse(text) as { jest?: { coverageThreshold?: unknown } })?.jest?.coverageThreshold, '');
    } catch {
      return null;
    }
    return m;
  };
  const was = flat(before);
  const now = flat(after);
  if (!was || !now) return null;
  const out: string[] = [];
  for (const [path, w] of was) {
    const key = path.slice(path.lastIndexOf('/') + 1);
    const n = now.get(path);
    if (n === undefined) out.push(`coverage threshold ${key} removed`);
    else if (n < w) out.push(`coverage threshold ${key} lowered ${w}→${n}`);
  }
  return out;
}

export function tamperFindings(before: string, after: string, file: string): string[] {
  const b = strip(before);
  const a = strip(after);
  if (PKG.test(file)) return pkgThresholds(before, after) ?? thresholds(b, a);
  const out: string[] = [];
  for (const [label, re] of MARKERS) if (count(a, re) > count(b, re)) out.push(`${label} added`);
  const removed = count(b, ASSERT) - count(a, ASSERT);
  if (removed > 0) out.push(`${removed} assertion${removed === 1 ? '' : 's'} removed`);
  if (count(a, NOOP) > count(b, NOOP)) out.push('no-op assertion added');
  if (CONFIG.test(file)) {
    out.push(...thresholds(b, a));
    if (count(a, /passWithNoTests\s*:\s*true/g) > count(b, /passWithNoTests\s*:\s*true/g)) out.push('passWithNoTests enabled');
    const off = /\b(?:enabled|thresholds)\s*:\s*false/g;
    if (count(a, off) > count(b, off)) out.push('coverage disabled');
    // ponytail: line-and-array text compare; a reformat of these keys is a (cheap to resolve) false positive.
    for (const k of SELECTION) if (selection(a, k) !== selection(b, k)) out.push(`test selection changed (${k})`);
  }
  return out;
}

export const tamper: Check = {
  name: 'tamper',
  events: ['PreToolUse'],
  pure: true,
  run(ctx) {
    const p = editTarget(ctx.input);
    if (!ctx.config.checks.tdd || p === null) return { kind: 'allow' };
    const rel = toRepoPath(ctx.root, p);
    if (rel === null || !(isTestFile(rel) || CONFIG.test(rel) || PKG.test(rel))) return { kind: 'allow' };
    let before = '';
    try {
      before = readFileSync(resolve(ctx.root, p), 'utf8');
    } catch {
      // missing file: before is empty
    }
    const findings = tamperFindings(before, afterContent(ctx.input, before), rel);
    if (!findings.length) return { kind: 'allow' };
    return { kind: 'deny', reason: `Tests can't be weakened to pass: ${findings.join('; ')}. Fix the code instead, or ask the user.`, check: 'tamper' };
  },
};
