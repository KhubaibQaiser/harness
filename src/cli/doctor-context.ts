import { dirname } from 'node:path';
import { contextSet, type ContextSet } from '../budget/summary.js';
import type { HarnessConfig } from '../core/config.js';
import { packageDir } from '../core/package-dir.js';

export const contextDirs = () => ({ templates: packageDir('templates'), plugin: dirname(packageDir('templates')) });

export const contextLine = (s: ContextSet): string =>
  `Context: ~${s.total} of ${s.budget} tokens always loaded (best estimate); harness ~${s.harness}. Run harness context for details.`;

/** One line: ok within budget, note when the repo's own text pushes it over, fix when harness alone is over. Offline. */
export function contextChecks(
  root: string, config: HarnessConfig,
  p: { ok: (s: string) => void; fix: (w: string, n: string) => void; note: (w: string, n?: string) => void },
): void {
  const s = contextSet(root, config, contextDirs());
  if (s.harness > s.budget) p.fix(`harness's own always-loaded text (~${s.harness} tokens) is over the budget of ${s.budget}`, 'report this as a harness bug, or raise context.budget_tokens');
  else if (s.total > s.budget) p.note(`always-loaded context ~${s.total} tokens is over the budget of ${s.budget}`, 'run /harness:context-optimize');
  else p.ok(`always-loaded context ~${s.total} of ${s.budget} tokens (best estimate); harness ~${s.harness}`);
}
