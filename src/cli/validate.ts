import { readFileSync } from 'node:fs';
import { validateAnswers } from '../ai/answers.js';
import { saveDebug } from '../ai/debug.js';
import { type Picks, validatePicks } from '../ai/picks.js';
import { finalizeReport, validateReport } from '../ai/report.js';
import { loadCatalog } from '../catalog/load.js';
import { writeAtomic } from '../core/atomic.js';
import { packageDir } from '../core/package-dir.js';
import { validateProduct } from '../ai/product.js';
import { detect } from '../install/detect.js';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness validate answers <file>\n       harness validate product <file>\n       harness validate picks <file> --answers <file> [--attempt 1|2]\n       harness validate report <file> --picks <file> [--attempt 1|2]';

/** Checks what the interview wrote. Exit 0 prints ok; exit 2 prints one error per line. Safe in a plain terminal and in Claude Code. */
export function validate(args: string[], { root, out }: CliEnv): number {
  if (args[0] === 'picks' || args[0] === 'report') return recommend(args, root, out);
  const [what, file] = args;
  if (args.length !== 2 || (what !== 'answers' && what !== 'product')) return out(USAGE), 2;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return out(`${what}: could not read ${JSON.stringify(file)}(${(e as NodeJS.ErrnoException).code ?? 'error'})`), 2;
  }
  let errors: string[];
  if (what === 'product') errors = validateProduct(text);
  else {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return out('answers: not valid JSON'), 2;
    }
    const r = validateAnswers(raw, detect(root));
    errors = r.ok ? [] : r.errors;
  }
  if (!errors.length) return out('ok'), 0;
  for (const e of errors) out(e);
  return 2;
}

const read = (file: string): string | { error: string } => {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    return { error: `could not read ${JSON.stringify(file)} (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
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
type Kind = 'picks' | 'report';
function recommend(args: string[], root: string, out: (l: string) => void): number {
  const [what, file, flag, other, ...tail] = args as [Kind, ...string[]];
  const f2 = what === 'picks' ? '--answers' : '--picks';
  let attempt = 1;
  if (tail.length === 2 && tail[0] === '--attempt' && (tail[1] === '1' || tail[1] === '2')) attempt = Number(tail[1]);
  else if (tail.length) return out(USAGE), 2;
  if (!file || flag !== f2 || !other) return out(USAGE), 2;
  const text = read(file);
  const side = read(other);
  for (const t of [text, side]) if (typeof t !== 'string') return out(`${what}: ${t.error}`), 2;
  const sideRaw = json(side as string);

  let errors: string[];
  let final: string | undefined;
  if (what === 'picks') {
    const a = validateAnswers(sideRaw, detect(root));
    if (!a.ok) return out('answers: the answers file is not valid; run harness validate answers first'), a.errors.forEach((e) => out(e)), 2;
    const raw = json(text as string);
    const { catalog, errors: ce } = loadCatalog(packageDir('catalog'));
    if (ce.length) return ce.forEach((e) => out(`catalog: ${e}`)), 2;
    if (raw === undefined) errors = ['picks: not valid JSON'];
    else {
      const r = validatePicks(raw, catalog, a.answers);
      errors = r.ok ? [] : r.errors;
    }
  } else {
    const fs = (sideRaw as Picks | undefined)?.findings;
    if (!Array.isArray(fs) || !fs.every((x) => typeof x?.id === 'string')) return out('picks: the picks file is not valid; run harness validate picks first'), 2;
    errors = validateReport(text as string, sideRaw as Picks);
    if (!errors.length) final = finalizeReport(text as string);
  }
  if (!errors.length) {
    if (final !== undefined && final !== text) writeAtomic(file, final);
    return out('ok'), 0;
  }
  for (const e of errors) out(e);
  if (attempt < 2) return 2;
  const rel = saveDebug(root, what, text as string);
  out(`Recommend output failed validation twice. Raw output is in \`${rel}\`. Stopping.`);
  return 1;
}
