import { stringify } from 'yaml';
import { DEFAULT_RESULTS_DIR, defaults, type HarnessConfig, type Issue, overlay } from './config.js';

export function validateConfig(raw: unknown): { ok: true; config: HarnessConfig } | { ok: false; errors: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['config: must be a mapping'] };
  const config = defaults();
  const issues: Issue[] = [];
  overlay(config as unknown as Record<string, unknown>, raw as Record<string, unknown>, '', issues);
  if (issues.length === 0) return { ok: true, config };
  const text = ({ path, kind, detail }: Issue) => `${path}: ${kind === 'unknown' ? 'unknown key' : kind === 'mapping' ? 'must be a mapping' : detail}`;
  return { ok: false, errors: issues.map(text) };
}

const SECTIONS: Record<keyof HarnessConfig, string> = {
  version: 'Config schema version.',
  checks: 'Which checks run.',
  sandbox: "Claude Code's sandbox: required for unattended runs (unattended), on for everyone (always), or not used (off).",
  catalog_version: 'Version of the catalog the recommendations came from (0: no catalog).',
  project: 'What this project is, from the interview. Used to recommend tools; codeowners is input only.',
  apps: 'Runnable apps in the repo: how to start them and what login (credential names only, never values) they need.',
  items: 'Catalog items chosen for this project.',
  git: 'Git settings.',
  context: 'Budget for always-loaded context that harness adds; harness asks before an install passes it.',
  tdd: 'Red-first TDD enforcement (needs checks.tdd).',
  multi_file_gate: 'Multi-file edit gate (needs checks.multiFile).',
  unattended: 'Behaviour when no human is watching.',
  stop: 'Verification steps that must pass before the agent may stop.',
};

// `version` is the harness version stamped by init; the placeholder keeps the example file deterministic.
export function serializeConfig(c: HarnessConfig, version = '<version>'): string {
  const head = `# .harness/config.yaml — written by harness init ${version}. Edit freely; run harness doctor after.\n`;
  const body = (Object.keys(SECTIONS) as (keyof HarnessConfig)[]).map((k) => `# ${SECTIONS[k]}\n${stringify({ [k]: c[k] })}`);
  return `${head}\n${body.join('\n')}`;
}

/** The config text with the old default results_dir (one line, exactly) swapped for the new one, keeping its indent, quotes and comment; else null. */
export function migrateResultsDir(text: string): string | null {
  const re = /^(\s*results_dir:\s*)(['"]?)\.harness\/state\/test-results\2(\s*(#.*)?)$/gm;
  return [...text.matchAll(re)].length === 1 ? text.replace(re, (_m, head: string, q: string, tail: string) => `${head}${q}${DEFAULT_RESULTS_DIR}${q}${tail}`) : null;
}
