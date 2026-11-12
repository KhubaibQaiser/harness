import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { packageDir } from '../core/package-dir.js';
import type { CliEnv } from './index.js';

// The skills' bundled docs, printed so a skill never reads a file outside the working directory.
const DOCS: Record<string, () => string> = {
  'init-skill': () => readFileSync(join(packageDir('skills'), 'init/SKILL.md'), 'utf8'), // the update skill follows init's steps
  'init-interview': () => readFileSync(join(packageDir('skills'), 'init/interview.md'), 'utf8'),
  'init-recommend': () => readFileSync(join(packageDir('skills'), 'init/recommend.md'), 'utf8'),
  'review-rubric': () => readFileSync(join(packageDir('templates'), 'skills/review-rubric/SKILL.md'), 'utf8'),
  'preset-interview': () => readFileSync(join(packageDir('skills'), 'preset/interview.md'), 'utf8'),
  'preset-example': () => {
    const dir = join(packageDir('catalog'), 'presets');
    const inner = readdirSync(join(dir, 'khubaib-frontend'), { recursive: true, encoding: 'utf8' }).map((f) => `khubaib-frontend/${f.split('\\').join('/')}`);
    return ['khubaib-frontend.yaml', ...inner.sort()].filter((f) => lstatSync(join(dir, f)).isFile()).map((f) => `## ${f}\n\n${readFileSync(join(dir, f), 'utf8')}`).join('\n');
  },
};
const GUIDE_USAGE = `Usage: harness guide ${Object.keys(DOCS).join('|')}`;

export function guide(args: string[], { out }: CliEnv): number {
  const doc = args.length === 1 && Object.hasOwn(DOCS, args[0]!) ? DOCS[args[0]!] : undefined;
  return doc ? (out(doc()), 0) : (out(GUIDE_USAGE), 2);
}

const WORKDIR_USAGE = 'Usage: harness workdir [--clean <path>]';
const linked = (p: string) => existsSync(p) && lstatSync(p).isSymbolicLink();

/** A work folder for the skills inside the repo, `.harness/tmp/<id>/`, so they never write outside the working directory. */
export function workdir(args: string[], { root, out }: CliEnv): number {
  const tmp = join(root, '.harness', 'tmp');
  if (linked(dirname(tmp)) || linked(tmp)) return out('`.harness` or `.harness/tmp` is a symlink; harness does not write through it.'), 2;
  if (!args.length) {
    mkdirSync(tmp, { recursive: true });
    if (!existsSync(join(tmp, '.gitignore'))) writeFileSync(join(tmp, '.gitignore'), '*\n');
    return out(mkdtempSync(join(tmp, 'w-'))), 0;
  }
  const p = args.length === 2 && args[0] === '--clean' ? resolve(root, args[1]!) : null;
  if (!p) return out(WORKDIR_USAGE), 2;
  if (dirname(p) !== tmp || basename(p) === '.gitignore') return out(`Not a harness work folder (it must be directly under ${tmp}): ${p}`), 2;
  rmSync(p, { recursive: true, force: true });
  return 0;
}
