import picomatch from 'picomatch';
import { SAFE_DIFF } from '../core/git-safe.js';

export interface Hunk { oldStart: number; newStart: number; rows: { kind: '+' | '-' | ' '; text: string; old?: number; new?: number }[] }
export interface DiffFile { path: string; old_path?: string; status: 'added' | 'deleted' | 'modified' | 'renamed' | 'mode' | 'submodule' | 'binary'; binary: boolean; hunks: Hunk[]; lines: number }

// ponytail: a constant; becomes a key only if real PRs need it
export const DIFF_CAP = 3000;

/** After `...SAFE_GIT` (the spawn adds it). `-z --raw` gives exact paths, `-p` the hunks. `--no-color`: a repo's color.ui=always must not reach the parser. */
export const diffArgs = (mergeBase: string, head: string): string[] => ['diff', ...SAFE_DIFF, '--no-color', '-M', '-z', '--find-renames', '--raw', '-p', mergeBase, head];

function hunks(block: string): Hunk[] {
  const out: Hunk[] = [];
  let h: Hunk | undefined, o = 0, n = 0;
  for (const l of block.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) { o = Number(m[1]); n = Number(m[2]); out.push(h = { oldStart: o, newStart: n, rows: [] }); continue; }
    if (!h) continue; // header lines before the first hunk
    const k = l[0], text = l.slice(1);
    if (k === ' ') h.rows.push({ kind: ' ', text, old: o++, new: n++ });
    else if (k === '-') h.rows.push({ kind: '-', text, old: o++ });
    else if (k === '+') h.rows.push({ kind: '+', text, new: n++ });
  }
  return out;
}

/** Raw records come first (NUL-separated, an empty record ends them), then one `diff --git` block per record, in order. Header paths are never parsed. */
export function parseDiff(out: string): DiffFile[] {
  const t = out.split('\0');
  const raw: { meta: string[]; paths: string[] }[] = [];
  let i = 0;
  for (; i < t.length && t[i]!.startsWith(':'); ) {
    const meta = t[i]!.slice(1).split(' ');
    const two = /^[RC]/.test(meta[4] ?? '');
    raw.push({ meta, paths: t.slice(i + 1, i + (two ? 3 : 2)) });
    i += two ? 3 : 2;
  }
  const patch = t.slice(i).join('\0').replace(/^\0+/, '');
  const blocks = patch ? patch.split(/^(?=diff --git )/m) : [];
  if (blocks.length !== raw.length) throw new Error(`review: git diff gave ${raw.length} files but ${blocks.length} patches`);
  return raw.map(({ meta, paths }, k) => {
    const [oldMode, newMode, , , st = ''] = meta;
    const block = blocks[k]!, hs = hunks(block);
    const binary = /^Binary files /m.test(block);
    const status: DiffFile['status'] = oldMode === '160000' || newMode === '160000' ? 'submodule' : binary ? 'binary' : st === 'A' ? 'added' : st === 'D' ? 'deleted'
      : st[0] === 'R' ? 'renamed' : !hs.length && oldMode !== newMode ? 'mode' : 'modified';
    const lines = hs.reduce((s, h) => s + h.rows.filter((r) => r.kind !== ' ').length, 0);
    return { path: paths[paths.length - 1]!, ...(paths.length === 2 && { old_path: paths[0]! }), status, binary, hunks: hs, lines };
  });
}

/** §6.1-§6.3: RIGHT is the added and context lines of the new file, LEFT the removed lines of the old one. */
export function commentable(files: DiffFile[]): Record<string, { RIGHT: number[]; LEFT: number[] }> {
  const out: Record<string, { RIGHT: number[]; LEFT: number[] }> = {};
  for (const f of files) {
    const rows = f.hunks.flatMap((h) => h.rows);
    out[f.path] = { RIGHT: rows.flatMap((r) => (r.new !== undefined ? [r.new] : [])), LEFT: rows.flatMap((r) => (r.kind === '-' ? [r.old!] : [])) };
  }
  return out;
}

/** Excluded files are listed, not sent; then whole files go in diff order while they fit. A file that doesn't fit is skipped and later ones are still tried. */
export function capDiff(files: DiffFile[], cap: number, exclude: string[]): { sent: DiffFile[]; omitted: { path: string; why: string }[] } {
  const ex = exclude.length ? picomatch(exclude, { dot: true }) : () => false;
  const sent: DiffFile[] = [], omitted: { path: string; why: string }[] = [];
  let used = 0;
  for (const f of files) {
    if (ex(f.path)) omitted.push({ path: f.path, why: 'excluded by pr_size.exclude' });
    else if (used + f.lines > cap) omitted.push({ path: f.path, why: 'not reviewed: over the size cap' });
    else { sent.push(f); used += f.lines; }
  }
  return { sent, omitted };
}
