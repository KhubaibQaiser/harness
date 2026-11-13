import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { validatePrReview } from '../ai/pr-review.js';
import { gatherHash, type GatherJson } from '../review/gather.js';
import { MANIFEST_REL } from '../install/manifest.js';
import { esc, loadConfig } from '../core/config.js';
import { configToAnswers, validateAnswers } from '../ai/answers.js';
import { overlayAnswers } from './init.js';
import { readConfig } from './preamble.js';
import { saveDebug } from '../ai/debug.js';
import { type Picks, validatePicks } from '../ai/picks.js';
import { validateReport } from '../ai/report.js';
import { validateVetReview } from '../ai/vet-review.js';
import { validatePresetAnswers } from '../ai/preset-answers.js';
import { selectedIds } from '../install/plan.js';
import type { ScanResult } from '../vet/scan.js';
import { loadCatalog } from '../catalog/load.js';
import { packageDir } from '../core/package-dir.js';
import { validateProduct } from '../ai/product.js';
import { detect } from '../install/detect.js';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness validate answers <file> [--merge-config]\n       harness validate product <file>\n       harness validate picks <file> --answers <file> [--merge-config] [--attempt 1|2]\n       harness validate report <file> --picks <file> [--attempt 1|2]\n       harness validate vet-review <file> --scan <file> [--attempt 1|2]\n       harness validate pr-review <file> --gather <dir>/gather.json [--attempt 1|2]\n       harness validate preset-answers <file>';

/** Checks what the interview wrote. Exit 0 prints ok; exit 2 prints one error per line. Safe in a plain terminal and in Claude Code. */
export function validate(argv: string[], { root, out }: CliEnv): number {
  // --merge-config: the answers file is partial (an update's re-asked keys); lay it over the answers in .harness/config.yaml first.
  const args = argv.filter((a) => a !== '--merge-config');
  let merge: Merge = (raw) => raw;
  if (args.length !== argv.length) {
    const c = readConfig(root, out, true); // as update reads it, so an old results_dir doesn't stop the update flow
    if (typeof c === 'number') return c;
    merge = (raw) => (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? overlayAnswers(configToAnswers(c), raw as Record<string, unknown>) : raw);
  }
  if (args[0] === 'picks' || args[0] === 'report' || args[0] === 'vet-review' || args[0] === 'pr-review') return recommend(args, root, out, merge);
  const [what, file] = args;
  if (args.length !== 2 || (what !== 'answers' && what !== 'product' && what !== 'preset-answers')) return out(USAGE), 2;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return out(`${what}: could not read "${esc(file)}"(${(e as NodeJS.ErrnoException).code ?? 'error'})`), 2;
  }
  let errors: string[];
  if (what === 'product') errors = validateProduct(text);
  else {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return out(`${what}: not valid JSON`), 2;
    }
    const r = what === 'preset-answers' ? validatePresetAnswers(raw, loadCatalog(packageDir('catalog')).catalog, root) : validateAnswers(merge(raw), detect(root));
    errors = r.ok ? [] : r.errors;
  }
  if (!errors.length) return out('ok'), 0;
  for (const e of errors) out(e);
  return 2;
}

/** The ids a vet review may name as overlaps: the set `harness explain` lists. null: installed but the config can't be read. */
export function installedIds(root: string): string[] | null {
  if (!existsSync(join(root, MANIFEST_REL))) return [];
  const lc = loadConfig(root);
  return lc.errors.length ? null : selectedIds(lc.config);
}

const read = (file: string): string | { error: string } => {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    return { error: `could not read "${esc(file)}" (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
};
const json = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** picks/report: exit 0 ok, 2 invalid (a retry is left), 1 invalid on attempt 2 (raw output saved, stop). */
type Kind = 'picks' | 'report' | 'vet-review' | 'pr-review';
const LABEL: Record<Kind, string> = { picks: 'Recommend output', report: 'Recommend output', 'vet-review': 'Vet review', 'pr-review': 'PR review' };
type Merge = (raw: unknown) => unknown;
function recommend(args: string[], root: string, out: (l: string) => void, merge: Merge): number {
  const [what, file, flag, other, ...tail] = args as [Kind, ...string[]];
  const f2 = what === 'picks' ? '--answers' : what === 'report' ? '--picks' : what === 'pr-review' ? '--gather' : '--scan';
  let attempt = 1;
  if (tail.length === 2 && tail[0] === '--attempt' && (tail[1] === '1' || tail[1] === '2')) attempt = Number(tail[1]);
  else if (tail.length) return out(USAGE), 2;
  if (!file || flag !== f2 || !other) return out(USAGE), 2;
  // Review Focus 1: the agent can write <dir>; gather.json must be the bytes gather wrote. Never counts as an attempt.
  const gdir = what === 'pr-review' ? dirname(resolve(other)) : '';
  if (gdir && basename(other) !== 'gather.json') return out('pr-review: --gather must name <dir>/gather.json'), 2;
  const h = gdir ? gatherHash(root, gdir) : 'ok';
  if (h !== 'ok') return out(h), 2;
  const text = read(file);
  const side = read(gdir ? join(gdir, 'gather.json') : other); // the very file the hash check read
  for (const t of [text, side]) if (typeof t !== 'string') return out(`${what}: ${t.error}`), 2;
  const sideRaw = what === 'picks' ? merge(json(side as string)) : json(side as string);

  let errors: string[];
  if (what === 'picks') {
    const a = validateAnswers(sideRaw, detect(root));
    const raw = json(text as string);
    const { catalog, errors: ce } = loadCatalog(packageDir('catalog'));
    if (!a.ok) errors = ['answers: the answers file is not valid; run harness validate answers first', ...a.errors];
    else if (ce.length) errors = ce.map((e) => `catalog: ${e}`);
    else if (raw === undefined) errors = ['picks: not valid JSON'];
    else {
      const r = validatePicks(raw, catalog, a.answers);
      errors = r.ok ? [] : r.errors;
    }
  } else if (what === 'vet-review') {
    const raw = json(text as string);
    if (raw === undefined) errors = ['vet-review: not valid JSON'];
    else {
      const r = validateVetReview(raw, sideRaw as ScanResult, installedIds(root));
      errors = r.ok ? [] : r.errors;
    }
  } else if (what === 'pr-review') {
    const raw = json(text as string);
    const g = sideRaw as GatherJson;
    const inSnapshot = (f: string) => Object.hasOwn(g.map, f) && existsSync(join(gdir, 'head', ...g.map[f]!.split('/')));
    if (raw === undefined) errors = ['pr-review: not valid JSON'];
    else {
      const r = validatePrReview(raw, g, inSnapshot);
      errors = r.ok ? [] : r.errors;
    }
  } else {
    const fs = (sideRaw as Picks | undefined)?.findings;
    if (!Array.isArray(fs) || !fs.every((x) => typeof x?.id === 'string')) errors = ['picks: the picks file is not valid; run harness validate picks first'];
    else errors = validateReport(text as string, sideRaw as Picks);
  }
  if (!errors.length) return out('ok'), 0; // read-only: finalizeReport is applied by init
  for (const e of errors) out(e);
  if (attempt < 2) return 2;
  // Only an installed repo gets a .harness/ folder; anywhere else the raw output is printed.
  if (!existsSync(join(root, MANIFEST_REL))) return out(`${LABEL[what].replace(/ output$/, '')} output failed validation twice. Raw output follows. Stopping.\n${(text as string).split(/\r?\n/).map(esc).join('\n')}`), 1;
  out(`${LABEL[what]} failed validation twice. Raw output is in \`${saveDebug(root, what, text as string)}\`. Stopping.`);
  return 1;
}
