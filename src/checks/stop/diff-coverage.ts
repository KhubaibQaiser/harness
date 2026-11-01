// Diff coverage: share of executable changed lines (vs the base) that istanbul coverage output says ran.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from '../../core/config.js';
import { isTestFile, matches, toRepoPath } from '../../core/paths.js';
import type { Exec } from './gate.js';

const GIT_MS = 5000;

type Istanbul = Record<string, { statementMap: Record<string, { start: { line: number }; end: { line: number } }>; s: Record<string, number> }>;
type FileLines = { executable: Set<number>; covered: Set<number> };

export interface DiffCoverage {
  pct: number;
  total: number;
  covered: number;
  uncovered: { file: string; lines: number[] }[];
  problem?: 'no-base' | 'diff-failed' | 'no-fresh-coverage';
}

const add = (m: Map<string, Set<number>>, file: string, line: number) => (m.get(file) ?? m.set(file, new Set()).get(file)!).add(line);

// Added and modified lines on the new side of a `git diff -U0`.
export function changedLines(diffText: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  for (const l of diffText.split('\n')) {
    if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(4).replace(/^"|"$/g, '').replace(/^b\//, '');
    else if (file) {
      const h = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (h) for (let i = 0; i < Number(h[2] ?? 1); i++) add(out, file, Number(h[1]) + i);
    }
  }
  return out;
}

// Per repo file: executable = every line inside a statement range; covered = lines inside a statement that ran.
export function coveredLines(istanbul: Istanbul, root: string): Map<string, FileLines> {
  const out = new Map<string, FileLines>();
  for (const [key, f] of Object.entries(istanbul)) {
    const rel = toRepoPath(root, key);
    if (!rel) continue;
    const cur = out.get(rel) ?? out.set(rel, { executable: new Set(), covered: new Set() }).get(rel)!;
    for (const [id, st] of Object.entries(f.statementMap))
      for (let n = st.start.line; n <= st.end.line; n++) {
        cur.executable.add(n);
        if ((f.s[id] ?? 0) > 0) cur.covered.add(n);
      }
  }
  return out;
}

// "1-3,5": collapse consecutive runs into ranges.
export function formatLines(lines: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (lines[j + 1] === lines[j] + 1) j++;
    parts.push(j > i ? `${lines[i]}-${lines[j]}` : `${lines[i]}`);
    i = j;
  }
  return parts.join(',');
}

// Bounded walk (skips node_modules/.git) matched with picomatch: no extra git call, and it finds gitignored coverage dirs.
function coverageFiles(root: string, globs: string[], since: number): { fresh: string[] } {
  const fresh: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.isFile() && matches(r, globs) && statSync(join(dir, e.name)).mtimeMs >= since * 1000) fresh.push(join(dir, e.name));
    }
  };
  walk(root, '');
  return { fresh };
}

const ok = (r: { status: number | null; timedOut: boolean }) => r.status === 0 && !r.timedOut;

// `since` (epoch seconds) is when the stop gate's steps began; older coverage output is stale and ignored.
export function diffCoverage(root: string, cfg: HarnessConfig, exec: Exec, opts: { baseHead?: string; since: number }): DiffCoverage {
  const result = (problem: DiffCoverage['problem']): DiffCoverage => ({ pct: 100, total: 0, covered: 0, uncovered: [], problem });
  const mb = exec('git', ['merge-base', 'HEAD', cfg.stop.base_ref], GIT_MS);
  const base = ok(mb) ? mb.output.trim() : opts.baseHead;
  if (!base) return result('no-base');
  const d = exec('git', ['diff', '--relative', '-U0', base], GIT_MS);
  if (!ok(d)) return result('diff-failed');
  const changed = changedLines(d.output);
  const un = exec('git', ['ls-files', '--others', '--exclude-standard'], GIT_MS);
  if (ok(un))
    for (const f of un.output.split('\n').filter(Boolean)) {
      try {
        const text = readFileSync(join(root, f), 'utf8');
        const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        for (let i = 1; i <= n; i++) add(changed, f, i);
      } catch {
        // unreadable or vanished: nothing to count
      }
    }
  const { paths, exempt } = cfg.tdd;
  const scoped = [...changed].filter(([f]) => toRepoPath(root, f) && matches(f, paths) && !matches(f, exempt) && !isTestFile(f));
  if (scoped.length === 0) return result(undefined);

  const reports = new Map<string, FileLines>();
  const { fresh } = coverageFiles(root, cfg.stop.coverage_globs, opts.since);
  if (fresh.length === 0) return result('no-fresh-coverage');
  for (const file of fresh) {
    try {
      for (const [f, v] of coveredLines(JSON.parse(readFileSync(file, 'utf8')), root)) {
        const cur = reports.get(f) ?? reports.set(f, { executable: new Set(), covered: new Set() }).get(f)!;
        v.executable.forEach((n) => cur.executable.add(n));
        v.covered.forEach((n) => cur.covered.add(n));
      }
    } catch {
      // unreadable report: skip it
    }
  }

  let total = 0;
  let covered = 0;
  const uncovered: DiffCoverage['uncovered'] = [];
  for (const [file, lines] of scoped) {
    const rep = reports.get(file);
    const exe = [...lines].filter((n) => !rep || rep.executable.has(n)).sort((a, b) => a - b); // absent from every report: all lines count
    const miss = exe.filter((n) => !rep?.covered.has(n));
    total += exe.length;
    covered += exe.length - miss.length;
    if (miss.length) uncovered.push({ file, lines: miss });
  }
  return { pct: total === 0 ? 100 : (covered / total) * 100, total, covered, uncovered };
}
