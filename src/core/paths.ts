import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import picomatch from 'picomatch';

// Native realpath gives what git reports: true case (macOS, Windows) and long names for 8.3 short ones (C:\Users\RUNNER~1).
export const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return realpathSync(p); // some Windows volumes reject the native call
  }
};

// ponytail: any realpath error counts as missing, so a dangling final link returns its own path.
// Realpath of the deepest existing ancestor, with the not-yet-existing remainder re-appended (new files don't exist yet).
export function realish(p: string): string {
  const rest: string[] = [];
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try {
      return join(real(cur), ...rest.reverse());
    } catch {
      if (dirname(cur) === cur) return resolve(p);
      rest.push(basename(cur));
    }
  }
}

const rootCache = new Map<string, string>();

export function toRepoPath(root: string, p: string): string | null {
  let r = rootCache.get(root);
  if (r === undefined) rootCache.set(root, (r = realish(root)));
  const rel = relative(r, realish(resolve(root, p)));
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** picomatch <= 4.0.7 has an extglob ReDoS with no fixed version (GHSA-fc5q-39xc-vjpf). A glob from agent text is
 *  never compiled when this is true (over 3 extglob groups, or over 256 characters); callers count it as a match.
 *  The 3-group threshold is safe only because the hooks match against short, fixed names (ruled commands, protected
 *  and decision paths). A call site that matches arbitrary or long paths needs a stricter check (see tooComplex in
 *  src/report/metrics/skills.ts): `+(*)+(*)` against a 24-letter folder ran past 15 s. */
export const riskyGlob = (g: string): boolean => g.length > 256 || (g.match(/[+*?@!]\(/g)?.length ?? 0) > 3;

export const matches = (rel: string, globs: string[]): boolean => globs.length > 0 && picomatch(globs, { dot: true })(rel);

export const isTestFile = (rel: string): boolean => /\.(test|spec)\.[^/]+$/.test(rel) || /(^|\/)__tests__\//.test(rel);

/** Globs for the test files isTestFile and isAnyTestFile name, plus `test/`, `tests/` folders and Go `*_test.go`; pinned to them by test/core/paths.test.ts. */
export const TEST_FILE_GLOBS: string[] = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', '**/test_*.py', '**/*_test.py', '**/*_test.go', '**/conftest.py'];

/** JS/TS tests (isTestFile) plus Python tests: test_*.py, *_test.py, conftest.py, any .py under a tests/ dir. */
export const isAnyTestFile = (rel: string): boolean => isTestFile(rel) || /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/.test(rel) || /(^|\/)tests\/(.*\/)?[^/]*\.py$/.test(rel);

export const pairKey = (rel: string): string => rel.replace(/(^|\/)__tests__\//, '$1').replace(/\.(test|spec)(\.[^./]+)$/, '$2');

/** Harness's own local files: install gitignores them, and the in-progress size never counts them (pr-size spec §5). */
/** Task contracts (done contract). Here, a leaf with no harness imports, so protect's table can name it. */
export const TASKS_DIR = '.harness/tasks';
export const HARNESS_LOCAL = ['.harness/state/', '.harness/logs/', '.harness/backup/', '.harness/results/', '.harness/debug/', '.harness/reports/', '.harness/reviews/', '.harness/verdicts/'];

/** `.harness/` exists and is not just the skills' work folders (`.harness/tmp`, made before init): harness is or was installed. An empty `.harness/` counts, as the old existsSync check did. */
export function hasHarnessDir(root: string): boolean {
  try {
    return readdirSync(join(root, '.harness')).join('/') !== 'tmp';
  } catch {
    return false;
  }
}

/** Folders the skills and commands make in `.harness/` before any install: repo presets, work folders, vet reports. */
const PRE_INSTALL = new Set(['presets', 'tmp', 'vet']);
/**
 * With no manifest, the `.harness/` entries that keep init from installing (owner, 2026-11-18): the folder is harness's
 * only when a "keep" uninstall left its snapshot there, or it holds just the pre-install folders. Anything else may be
 * the person's, and uninstall would treat a runtime-folder name as harness's.
 */
/** A "keep" uninstall's snapshot: a plain file in a real `state/` folder, with the shape stampHarnessFiles writes. */
function keepSnapshot(root: string): boolean {
  try {
    if (lstatSync(join(root, '.harness/state')).isSymbolicLink() || !lstatSync(join(root, '.harness/state/files-snapshot.json')).isFile()) return false;
    const v = JSON.parse(readFileSync(join(root, '.harness/state/files-snapshot.json'), 'utf8'));
    const files = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h));
    return typeof v?.cli?.id === 'string' && files(v.cli.files) && files(v.lastSeen?.files);
  } catch {
    return false;
  }
}

export function unknownHarnessEntries(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, '.harness'));
  } catch {
    return [];
  }
  if (keepSnapshot(root)) return [];
  return names.filter((n) => !PRE_INSTALL.has(n)).sort().map((n) => `.harness/${n}`);
}

/** `p` is `dir` or inside it, on a path boundary; case-blind on darwin and win32 like trustedCli. */
export function within(p: string, dir: string, platform: NodeJS.Platform): boolean {
  const m = platform === 'win32' ? win32 : posix;
  const fold = platform === 'win32' || platform === 'darwin' ? (s: string) => s.toLowerCase() : (s: string) => s;
  const rel = m.relative(fold(dir), fold(p));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + m.sep) && !m.isAbsolute(rel));
}
