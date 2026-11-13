import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { defaultExec, type Exec } from '../core/exec.js';
import { gather, type GatherDeps } from '../review/gather.js';
import { judgeInput, readFindings, verifyFindings } from '../review/verify.js';
import type { CliEnv } from './index.js';

export const REVIEW_USAGE = 'harness review <pr> --out <dir>   (gathers a PR for review; nothing is posted yet)\n       harness review --judge-input <dir> --findings <file>';

/** `harness review <pr> --out <dir>`. `<dir>` is an empty `harness workdir` folder: directly under .harness/tmp, as `workdir --clean` requires. */
export function review(args: string[], cli: CliEnv, deps: GatherDeps = {}): number {
  const { root, out } = cli;
  if (args[0] === '--judge-input') return judge(args, cli, deps.exec ?? defaultExec);
  if (args.length !== 3 || args[1] !== '--out' || args[0]!.startsWith('-')) return out(`Usage: ${REVIEW_USAGE}`), 2;
  const tmp = join(root, '.harness', 'tmp'), p = resolve(root, args[2]!);
  const linked = [dirname(tmp), tmp, p].some((x) => existsSync(x) && lstatSync(x).isSymbolicLink());
  if (linked || dirname(p) !== tmp || basename(p) === '.gitignore' || !existsSync(p) || !lstatSync(p).isDirectory() || readdirSync(p).length)
    return out(`review: --out must be an empty folder from harness workdir, directly under ${tmp}: ${p}`), 2;
  return gather(args, cli, deps);
}

/** `review --judge-input <dir> --findings <file>`: verifies the findings and writes `<dir>/judge.md` for the judge. */
function judge(args: string[], { root, out }: CliEnv, exec: Exec): number {
  const [, dir, flag, file] = args;
  if (args.length !== 4 || !dir || flag !== '--findings' || !file) return out(`Usage: ${REVIEW_USAGE}`), 2;
  const r = readFindings(root, dir, file);
  if ('errors' in r) return r.errors.forEach((e) => out(e)), 2;
  try {
    const v = verifyFindings(r.review, r.g, r.dir, exec, root);
    const p = judgeInput(v.kept, r.g, r.dir, exec, root);
    out(p ? `judge: ${v.kept.length} finding${v.kept.length === 1 ? '' : 's'} to judge in ${p}; ${v.dropped.length} dropped by verification` : 'judge: no findings to judge');
    return 0;
  } catch (e) {
    return out((e as Error).message), 1;
  }
}
