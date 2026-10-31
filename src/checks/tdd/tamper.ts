// Anti-tampering: an edit may not weaken tests or coverage config to make them pass.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTestFile, toRepoPath } from '../../core/paths.js';
import type { Check } from '../../hooks/dispatch.js';
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

// ponytail: regex strip, so `//` or `/*` inside a string literal (e.g. a URL) hides the rest of that text; upgrade to a tokenizer if that gets abused.
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const MARKERS = ['.skip(', '.only(', 'xit(', 'xdescribe(', 'xtest(', '.todo(', 'fit(', 'fdescribe('];
const esc = (m: string) => (/^\w/.test(m) ? '\\b' : '') + m.replace(/[.(]/g, '\\$&');
const ASSERT = /\b(?:expect|assert)\s*[(.]/g;
const LIT = `true|false|\\d+(?:\\.\\d+)?|"[^"\\n]*"|'[^'\\n]*'`;
const NOOP = new RegExp(`expect\\(\\s*(${LIT})\\s*\\)\\s*\\.(?:toBe|toEqual)\\(\\s*\\1\\s*\\)|expect\\(\\s*(?:${LIT})\\s*\\)\\s*\\.toBeTruthy\\(\\)`, 'g');
const THRESHOLD = /\b(branches|functions|lines|statements)\s*:\s*(\d+)/g;
const CONFIG = /(^|\/)(vitest\.(config|workspace)|jest\.config)\.[^/]+$/;

const count = (s: string, re: RegExp): number => s.match(re)?.length ?? 0;

export function tamperFindings(before: string, after: string, file: string): string[] {
  const b = strip(before);
  const a = strip(after);
  const out: string[] = [];
  for (const m of MARKERS) {
    const re = new RegExp(esc(m), 'g');
    if (count(a, re) > count(b, re)) out.push(`${m} added`);
  }
  const removed = count(b, ASSERT) - count(a, ASSERT);
  if (removed > 0) out.push(`${removed} assertion${removed === 1 ? '' : 's'} removed`);
  if (count(a, NOOP) > count(b, NOOP)) out.push('no-op assertion added');
  if (CONFIG.test(file)) {
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
  }
  return out;
}

export const tamper: Check = {
  name: 'tamper',
  events: ['PreToolUse'],
  run(ctx) {
    const { tool_name, tool_input = {} } = ctx.input;
    const p = tool_input.file_path;
    if (!ctx.config.checks.tdd || (tool_name !== 'Edit' && tool_name !== 'Write' && tool_name !== 'MultiEdit') || typeof p !== 'string' || !p) return { kind: 'allow' };
    const rel = toRepoPath(ctx.root, p);
    if (rel === null || !(isTestFile(rel) || CONFIG.test(rel))) return { kind: 'allow' };
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
