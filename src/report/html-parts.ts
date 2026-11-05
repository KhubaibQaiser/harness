import { h } from './h.js';
import type { Usage } from './transcript.js';

export const MIN_N = 5, PCT = 100, TOP = 10, PER_TURNS = 10, CHARS_PER_TOKEN = 4;
export const NO_RELEVANT = 'no relevant sessions';
export const ESTIMATE = 'estimate, characters / 4';

export const CSS = `:root{--bg:#fff;--fg:#1b1f24;--mute:#59636e;--line:#d0d7de;--card:#f6f8fa;--bar:#0969da;--warn:#9a6700;--s0:#0969da;--s1:#8250df;--s2:#1a7f37;--s3:#bf8700}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mute:#8b949e;--line:#30363d;--card:#161b22;--bar:#58a6ff;--warn:#d29922;--s0:#58a6ff;--s1:#a371f7;--s2:#3fb950;--s3:#d29922}}
body{margin:0 auto;max-width:1000px;padding:0 16px 48px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
h1,h2,h3{line-height:1.25}section{margin-top:32px}.banner{background:var(--card);border:1px solid var(--warn);padding:8px 12px;border-radius:6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.tile{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px}.tile b{display:block;font-size:1.3em}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}.scroll{overflow-x:auto}
svg{width:100%;height:auto;max-width:640px}svg.wide{max-width:none}.lbl{fill:var(--fg);font-size:11px}.track{fill:var(--card)}.bar,.s0{fill:var(--s0)}.s1{fill:var(--s1)}.s2{fill:var(--s2)}.s3{fill:var(--s3)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--card);padding:8px;border-radius:6px}.mute{color:var(--mute)}`;

export const n = (x: number): string => String(x);
/** Every cell is text and is escaped here. */
export function table(head: string[], rows: (string | number)[][]): string {
  const th = head.map((c) => `<th>${h(c)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${h(String(c))}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}
/** A chart and the table with the same numbers right after it. */
export const chart = (svg: string, head: string[], rows: (string | number)[][]): string => `${svg}${table(head, rows)}`;
/** A rate with a denominator under 5 shows counts only. */
export const rate = (num: number, den: number, none = 'n/a'): string =>
  den === 0 ? none : den < MIN_N ? `${num} of ${den}` : `${Math.round((num / den) * PCT)}% (${num} of ${den})`;
export const section = (id: string, title: string, body: string): string => `<section id="${id}"><h2>${h(title)}</h2>${body}</section>`;
export const sum = (u: Usage): number => u.input + u.output + u.cacheWrite + u.cacheRead;
export const USAGE_HEAD = ['Uncached input', 'Cache write', 'Cache read', 'Output'];
export const usageCells = (u: Usage): number[] => [u.input, u.cacheWrite, u.cacheRead, u.output];
