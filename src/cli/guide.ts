import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ensureRealDir, writeAtomic } from '../core/atomic.js';
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
const WORKDIR_NAME = /^w-[A-Za-z0-9]{6}$/; // what mkdtempSync(…/w-) makes
// The folders `harness workdir` made: `--clean` removes only these, so it can never delete a folder of the person's or another tool's.
const recordFile = (root: string) => join(root, '.harness', 'state', 'workdirs.json');
function recorded(root: string): string[] {
  try {
    const v: unknown = JSON.parse(readFileSync(recordFile(root), 'utf8'));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function record(root: string, names: string[]): void {
  ensureRealDir(root, '.harness/state');
  writeAtomic(recordFile(root), JSON.stringify(names));
}
const linked = (p: string) => existsSync(p) && lstatSync(p).isSymbolicLink();

/** A work folder for the skills inside the repo, `.harness/tmp/<id>/`, so they never write outside the working directory. */
export function workdir(args: string[], { root, out }: CliEnv): number {
  const tmp = join(root, '.harness', 'tmp');
  if (linked(dirname(tmp)) || linked(tmp)) return out('`.harness` or `.harness/tmp` is a symlink; harness does not write through it.'), 2;
  if (!args.length) {
    ensureRealDir(root, '.harness/tmp');
    const ig = join(tmp, '.gitignore');
    try { lstatSync(ig); } catch { writeAtomic(ig, '*\n'); } // lstat: a planted link there counts as present and is never written through
    const dir = mkdtempSync(join(tmp, 'w-'));
    record(root, [...recorded(root), basename(dir)]);
    return out(dir), 0;
  }
  const p = args.length === 2 && args[0] === '--clean' ? resolve(root, args[1]!) : null;
  if (!p) return out(WORKDIR_USAGE), 2;
  if (dirname(p) !== tmp || !WORKDIR_NAME.test(basename(p))) return out(`Not a harness work folder (it must be a \`w-…\` folder directly under ${tmp}): ${p}`), 2;
  const name = basename(p), names = recorded(root);
  let st;
  try { st = lstatSync(p); } catch { return record(root, names.filter((n) => n !== name)), 0; } // already gone
  if (!names.includes(name) || !st.isDirectory()) return out(`Refused: ${p} is not a folder \`harness workdir\` made (or is now a link). Nothing was removed.`), 1;
  rmSync(p, { recursive: true, force: true });
  record(root, names.filter((n) => n !== name));
  return 0;
}
