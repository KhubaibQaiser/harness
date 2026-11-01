import { stringify } from 'yaml';
import { defaults, type HarnessConfig, type Issue, overlay } from './config.js';

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
