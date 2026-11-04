import { readFileSync } from 'node:fs';
import { validateAnswers } from '../ai/answers.js';
import { validateProduct } from '../ai/product.js';
import { detect } from '../install/detect.js';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness validate answers <file>\n       harness validate product <file>';

/** Checks what the interview wrote. Exit 0 prints ok; exit 2 prints one error per line. Safe in a plain terminal and in Claude Code. */
export function validate(args: string[], { root, out }: CliEnv): number {
  const [what, file] = args;
  if (args.length !== 2 || (what !== 'answers' && what !== 'product')) return out(USAGE), 2;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return out(`${what}: could not read ${file} (${(e as NodeJS.ErrnoException).code ?? 'error'})`), 2;
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
