import { gitArgs, runnerName, type Seg, walkCommands, type Where } from '../guard.js';

export type PrTarget =
  | { kind: 'create'; base?: string; head?: string }
  | { kind: 'push'; all: boolean; refs: { src: string; dst: string }[] }
  | { kind: 'raise'; lines?: string; files?: string };
export type RaiseArgs = { lines?: string; files?: string };

const HOOK_SCRIPT = '.harness/hooks/dispatch.mjs';
export const RAISE_FLAG = '--pr-size-raise';

/** `--pr-size-raise --lines n [--files n]`'s raw values, or null for any other word, so the hook and the entry read one way. */
export function raiseArgs(args: string[]): RaiseArgs | null {
  const out: RaiseArgs = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i] === '--lines' ? 'lines' : args[i] === '--files' ? 'files' : null;
    if (key && args[i + 1] !== undefined) out[key] = args[++i];
    else if (args[i] !== RAISE_FLAG) return null;
  }
  return out;
}

/** `node <…>/.harness/hooks/dispatch.mjs … --pr-size-raise …` (the walker steps past `node`, a runner, to the script); a
 *  hidden runner (`$X`) is never one, and the entry writes nothing. */
function raiseTarget(toks: string[], k: number): PrTarget | null {
  const script = toks[k]?.replace(/\\/g, '/');
  if (runnerName(toks[k - 1] ?? '') !== 'node' || !script?.endsWith(HOOK_SCRIPT) || !toks.slice(k + 1).includes(RAISE_FLAG)) return null;
  return { kind: 'raise', ...(raiseArgs(toks.slice(k + 1)) ?? {}) };
}

// gh pr create flags that take a value, so a value like `--title "--base x"` is not read as a flag.
const GH_VALUE_FLAGS = new Set([
  '-t', '--title', '-b', '--body', '-F', '--body-file', '-a', '--assignee', '-l', '--label', '-m', '--milestone',
  '-p', '--project', '-r', '--reviewer', '-R', '--repo', '-T', '--template', '--recover',
]);
const PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
const PUSH_DELETE_FLAGS = new Set(['--delete', '-d']);
// Bundled short flags such as -fd or -df include the delete flag.
const BUNDLED_DELETE = /^-[A-Za-z]*d[A-Za-z]*$/;
const PUSH_ALL_FLAGS = new Set(['--all', '--branches', '--mirror']);

/** The words after `pr <sub>`, or null when `rest` (the words after gh) is not `pr <sub>`; -R/--repo may come between. */
export function afterPr(rest: string[], sub: string): string[] | null {
  const words: string[] = [];
  let i = 0;
  for (; i < rest.length && !words[1]; i++) {
    if (rest[i] === '-R' || rest[i] === '--repo') i++;
    else if (!rest[i].startsWith('-')) words.push(rest[i]);
  }
  return words[0] === 'pr' && words[1] === sub ? rest.slice(i) : null;
}
const afterPrCreate = (rest: string[]) => afterPr(rest, 'create') ?? afterPr(rest, 'new'); // `pr new` is gh's alias

function createTarget(args: string[]): PrTarget {
  const t: { kind: 'create'; base?: string; head?: string } = { kind: 'create' };
  for (let i = 0; i < args.length; i++) {
    const m = /^(?:(--base|--head)=|(-B|-H)(?=.))(.*)$/s.exec(args[i]);
    const flag = m ? m[1] ?? m[2] : args[i];
    const key = flag === '-B' || flag === '--base' ? 'base' : flag === '-H' || flag === '--head' ? 'head' : null;
    if (key) {
      const v = m ? m[3] : args[++i];
      if (v !== undefined) t[key] = key === 'head' ? v.slice(v.lastIndexOf(':') + 1) : v;
    } else if (GH_VALUE_FLAGS.has(args[i])) i++;
  }
  return t;
}

/** A push of branches, or null for a push that only deletes or only sends tags: no PR grows from it. */
function pushTarget(args: string[]): PrTarget | null {
  const refs: { src: string; dst: string }[] = [];
  let all = false, positional = 0, del = false, tags = false, refspecs = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PUSH_VALUE_FLAGS.has(a)) i++;
    else if (PUSH_ALL_FLAGS.has(a)) all = true;
    else if (PUSH_DELETE_FLAGS.has(a) || BUNDLED_DELETE.test(a)) del = true;
    else if (a === '--tags') tags = true;
    else if (!a.startsWith('-') && positional++ > 0) {
      refspecs++;
      const [raw, ...rest] = a.replace(/^\+/, '').split(':');
      const src = raw.replace(/^refs\/heads\//, '');
      const dst = rest.join(':').replace(/^refs\/heads\//, '') || src;
      if (src && !raw.startsWith('refs/tags/') && !dst.startsWith('refs/tags/')) refs.push({ src, dst }); // an empty source deletes
    }
  }
  if (del || (!all && !refs.length && (refspecs > 0 || tags))) return null;
  return { kind: 'push', all, refs };
}

function visitSeg(out: PrTarget[]) {
  return ({ toks, k, prev }: Seg): null => {
    const name = runnerName(toks[k] ?? '');
    // A command name the shell expands ($GH, $(which gh), `which gh`) is hidden: any `pr create` after it counts.
    const hidden = toks[k]?.startsWith('$') ? toks.slice(k + 1) : k === 0 && (prev === ')' || prev === '`') ? toks : null;
    const raise = raiseTarget(toks, k);
    if (raise) out.push(raise);
    else if (hidden && afterPrCreate(hidden)) out.push({ kind: 'create' });
    else if (name === 'gh') {
      const args = afterPrCreate(toks.slice(k + 1));
      if (args) out.push(createTarget(args));
    } else if (name === 'git') {
      const args = gitArgs(['git', ...toks.slice(k + 1)]);
      const t = args[0] === 'push' ? pushTarget(args.slice(1)) : null;
      if (t) out.push(t);
    }
    return null;
  };
}

/** Every `gh pr create`, `git push` and `--pr-size-raise` the command could run, under every reading, without duplicates. */
export function prTargets(command: string, w: Where): PrTarget[] {
  const out: PrTarget[] = [];
  walkCommands<never>(command, w, visitSeg(out), {
    whole: (words) => (['eval', 'gh', 'pr'].every((x) => words.includes(x)) && (words.includes('create') || words.includes('new')) ? (out.push({ kind: 'create' }), null) : null),
  });
  return [...new Map(out.map((t) => [JSON.stringify(t), t])).values()];
}
