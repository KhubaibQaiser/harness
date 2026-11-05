import { gitArgs, runnerName, type Seg, walkCommands, type Where } from '../guard.js';

export type PrTarget =
  | { kind: 'create'; base?: string; head?: string }
  | { kind: 'push'; all: boolean; refs: { src: string; dst: string }[] };

// gh pr create flags that take a value, so a value like `--title "--base x"` is not read as a flag.
const GH_VALUE_FLAGS = new Set(['-t', '--title', '-b', '--body', '-F', '--body-file', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-R', '--repo', '-T', '--template']);
const PUSH_VALUE_FLAGS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
const PUSH_ALL_FLAGS = new Set(['--all', '--branches', '--mirror']);

/** The words after `pr create`, or null when `rest` (the words after gh) is not `pr create`; -R/--repo may come between. */
function afterPrCreate(rest: string[]): string[] | null {
  const words: string[] = [];
  let i = 0;
  for (; i < rest.length && !words[1]; i++) {
    if (rest[i] === '-R' || rest[i] === '--repo') i++;
    else if (!rest[i].startsWith('-')) words.push(rest[i]);
  }
  return words[0] === 'pr' && words[1] === 'create' ? rest.slice(i) : null;
}

function createTarget(args: string[]): PrTarget {
  const t: { kind: 'create'; base?: string; head?: string } = { kind: 'create' };
  for (let i = 0; i < args.length; i++) {
    const m = /^(--base|--head)=(.*)$/s.exec(args[i]);
    const flag = m ? m[1] : args[i];
    const key = flag === '-B' || flag === '--base' ? 'base' : flag === '-H' || flag === '--head' ? 'head' : null;
    if (key) {
      const v = m ? m[2] : args[++i];
      if (v !== undefined) t[key] = key === 'head' ? v.split(':').pop()! : v;
    } else if (GH_VALUE_FLAGS.has(args[i])) i++;
  }
  return t;
}

function pushTarget(args: string[]): PrTarget {
  const refs: { src: string; dst: string }[] = [];
  let all = false, positional = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PUSH_VALUE_FLAGS.has(a)) i++;
    else if (PUSH_ALL_FLAGS.has(a)) all = true;
    else if (!a.startsWith('-') && positional++ > 0) {
      const [src, ...rest] = a.replace(/^\+/, '').split(':');
      if (src) refs.push({ src, dst: (rest.length ? rest.join(':') : src).replace(/^refs\/heads\//, '') });
    }
  }
  return { kind: 'push', all, refs };
}

function visitSeg(out: PrTarget[]) {
  return ({ toks, k, prev }: Seg): null => {
    const name = runnerName(toks[k] ?? '');
    // A command name the shell expands ($GH, $(which gh), `which gh`) is hidden: any `pr create` after it counts.
    const hidden = toks[k]?.startsWith('$') ? toks.slice(k + 1) : k === 0 && (prev === ')' || prev === '`') ? toks : null;
    if (hidden && afterPrCreate(hidden)) out.push({ kind: 'create' });
    else if (name === 'gh') {
      const args = afterPrCreate(toks.slice(k + 1));
      if (args) out.push(createTarget(args));
    } else if (name === 'git') {
      const args = gitArgs(['git', ...toks.slice(k + 1)]);
      if (args[0] === 'push') out.push(pushTarget(args.slice(1)));
    }
    return null;
  };
}

/** Every `gh pr create` and `git push` the command could run, under every reading, without duplicates. */
export function prTargets(command: string, w: Where): PrTarget[] {
  const out: PrTarget[] = [];
  walkCommands<never>(command, w, visitSeg(out), {
    whole: (words) => (['eval', 'gh', 'pr', 'create'].every((x) => words.includes(x)) ? (out.push({ kind: 'create' }), null) : null),
  });
  return [...new Map(out.map((t) => [JSON.stringify(t), t])).values()];
}
