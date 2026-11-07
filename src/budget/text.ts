// Text rules for repo context files: line endings, HTML comments, frontmatter. Pure; no I/O.
import { parse } from 'yaml';

/** Claude Code skips a file over this size, so it counts 0 and is never read here. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Cut for a skill's description text (R§1); the same unit as the docs' character limits. */
export const CUT_CHARS = 40_000;

export const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** The open fence after this line: null when outside one. */
export function fenceAfter(line: string, open: string | null): string | null {
  if (open === null) return FENCE_OPEN.exec(line)?.[1] ?? null;
  const c = FENCE_CLOSE.exec(line)?.[1];
  return c && c[0] === open[0] && c.length >= open.length ? null : open;
}

/** Remove block-level `<!-- … -->` comments outside code fences. An unclosed comment stays (over-counting is safe). */
export function stripComments(s: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let pending: string[] | null = null; // original lines of a comment that has not closed yet
  let tail = ''; // text before the comment opened, kept on the closing line
  for (const line of s.split('\n')) {
    if (pending) {
      const end = line.indexOf('-->');
      pending.push(line);
      if (end < 0) continue;
      const rest = tail + line.slice(end + 3);
      if (rest.trim() !== '') out.push(rest);
      pending = null;
      continue;
    }
    const inFence = fence !== null;
    fence = fenceAfter(line, fence);
    // Block-level only: the comment opens the line (CommonMark HTML block); `x <!-- c --> y` is inline and stays.
    if (inFence || fence !== null || !line.trimStart().startsWith('<!--')) { out.push(line); continue; }
    const whole = line.replace(/<!--.*?-->/g, '');
    const open = whole.indexOf('<!--');
    if (open < 0) { if (whole.trim() !== '' || line.trim() === '') out.push(whole); continue; }
    tail = whole.slice(0, open);
    pending = [line];
  }
  if (pending) out.push(...pending);
  return out.join('\n');
}

export interface Front { data: Record<string, unknown> | null; body: string; bad: boolean }

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(s: string): Front {
  const t = s.startsWith('\uFEFF') ? s.slice(1) : s;
  const m = FRONT.exec(t);
  if (!m) return { data: null, body: s, bad: false };
  try {
    const y: unknown = parse(m[1]);
    if (y === null || y === undefined) return { data: {}, body: t.slice(m[0].length), bad: false };
    if (typeof y !== 'object' || Array.isArray(y)) return { data: null, body: s, bad: true };
    return { data: y as Record<string, unknown>, body: t.slice(m[0].length), bad: false };
  } catch {
    return { data: null, body: s, bad: true };
  }
}

// Split on commas outside braces, so a glob such as a/b.{ts,tsx} stays one pattern.
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && depth > 0) depth--;
    cur += ch;
  }
  return [...parts, cur];
}

export function pathsOf(data: Record<string, unknown> | null): string[] | null {
  if (!data || !('paths' in data)) return null;
  const p = data.paths;
  const list = Array.isArray(p) ? p.map(String) : typeof p === 'string' ? splitTop(p) : [];
  return list.map((x) => x.trim()).filter(Boolean);
}
