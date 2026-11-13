import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gather, type GatherDeps } from '../review/gather.js';
import type { CliEnv } from './index.js';

export const REVIEW_USAGE = 'harness review <pr> --out <dir>   (gathers a PR for review; nothing is posted yet)';

/** `harness review <pr> --out <dir>`. `<dir>` is an empty `harness workdir` folder: directly under .harness/tmp, as `workdir --clean` requires. */
export function review(args: string[], cli: CliEnv, deps: GatherDeps = {}): number {
  const { root, out } = cli;
  if (args.length !== 3 || args[1] !== '--out' || args[0]!.startsWith('-')) return out(`Usage: ${REVIEW_USAGE}`), 2;
  const tmp = join(root, '.harness', 'tmp'), p = resolve(root, args[2]!);
  const linked = [dirname(tmp), tmp, p].some((x) => existsSync(x) && lstatSync(x).isSymbolicLink());
  if (linked || dirname(p) !== tmp || basename(p) === '.gitignore' || !existsSync(p) || !lstatSync(p).isDirectory() || readdirSync(p).length)
    return out(`review: --out must be an empty folder from harness workdir, directly under ${tmp}: ${p}`), 2;
  return gather(args, cli, deps);
}
