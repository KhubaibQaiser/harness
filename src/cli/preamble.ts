import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CATALOG_BROKEN, loadCatalog } from '../catalog/load.js';
import type { Catalog } from '../catalog/schema.js';
import { validateConfig } from '../core/config-io.js';
import type { HarnessConfig } from '../core/config.js';
import { gitRoot } from '../core/repo-root.js';
import { ManifestError, readManifest, type Manifest } from '../install/apply.js';

const CONFIG = '.harness/config.yaml';

/** The git root and the manifest of an installed harness, or the exit code after printing why not. `notGit` is the command's own wording. */
export function openInstall(cli: { root: string; out: (s: string) => void }, notGit: string): { root: string; m: Manifest } | number {
  const { out } = cli;
  const root = gitRoot(cli.root);
  if (!root) return out(notGit), 1;
  let m: Manifest | null;
  try {
    m = readManifest(root);
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  if (!m) return out('Harness is not installed here (no `.harness/manifest.json`). Run /harness:init to install it.'), 1;
  return { root, m };
}

/** The validated config, or the exit code after printing why not. */
export function readConfig(root: string, out: (s: string) => void): HarnessConfig | number {
  try {
    const v = validateConfig(parseYaml(readFileSync(join(root, CONFIG), 'utf8')));
    if (!v.ok) return v.errors.forEach((e) => out(e)), out('Next step: run harness doctor.'), 1;
    return v.config;
  } catch (e) {
    return out(`Could not read \`${CONFIG}\`: ${(e as Error).message}\nNext step: run harness doctor.`), 1;
  }
}

/** The catalog (the injected one first), or the exit code after printing why not. */
export function readCatalog(given: Catalog | undefined, out: (s: string) => void): Catalog | number {
  const lc = given ? { catalog: given, errors: [] as string[] } : loadCatalog();
  if (lc.errors.length) return lc.errors.forEach((e) => out(e)), out(CATALOG_BROKEN), 1;
  return lc.catalog;
}
