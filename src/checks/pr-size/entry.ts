// `dispatch.mjs --pr-size`: the pr-ship skill's measure call. Prints one JSON line; exit 0 within the limit, 1 over, 2 on any error.
import { loadConfig } from '../../core/config.js';
import { repoRoot } from '../../core/repo-root.js';
import { type Git, isOver, measure } from './measure.js';

const USAGE = 'usage: dispatch.mjs --pr-size [--base <name>] [--head <name>]';

export function prSizeEntry(argv: string[], cwd: string, out: (line: string) => void, git?: Git): 0 | 1 | 2 {
  const fail = (error: string): 2 => (out(JSON.stringify({ error })), 2);
  const want: { base?: string; head?: string } = {};
  const args = argv.filter((a) => a !== '--pr-size');
  for (let i = 0; i < args.length; i++) {
    const m = /^--(base|head)(?:=([\s\S]*))?$/.exec(args[i]!);
    if (!m) return fail(USAGE);
    const v = m[2] ?? args[++i];
    if (v === undefined) return fail(USAGE);
    want[m[1] as 'base' | 'head'] = v;
  }
  const root = repoRoot(cwd);
  const { config, errors } = loadConfig(root);
  if (errors.length) return fail(`\`.harness/config.yaml\` is invalid: ${errors.join('; ')}`);
  const s = measure(root, want, config, git ? { git } : {});
  if ('error' in s) return fail(s.error);
  const over = isOver(s, config.pr_size);
  const { target_lines, max_lines, max_files } = config.pr_size;
  out(JSON.stringify({ base: s.base, head: s.head, lines: s.lines, files: s.files, target_lines, max_lines, max_files, over, top: s.top.slice(0, 10), excluded: s.excluded }));
  return over ? 1 : 0;
}
