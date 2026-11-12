import type { CaseInfo } from './build.js';

const USD_DECIMALS = 2;
export interface EvalArgsOpts { runs: number; model: string; maxCost: number; out: string; scaffold: boolean; tools: string[] }

/** Arguments for `claude`; the target comes before the list flags (docs). Free graders only, local report. */
export function evalArgs(dir: string, o: EvalArgsOpts): string[] {
  return [
    'plugin', 'eval', dir, '--ablation', 'none', '--no-publish', '--trust-plugin',
    '--json', `${o.out}/result.json`, '--report', `${o.out}/report.html`, '--output-dir', o.out,
    '--runs', String(o.runs), '--model', o.model, '--max-cost-usd', String(o.maxCost),
    ...(o.scaffold ? ['--scaffold'] : []),
    ...(o.tools.length ? ['--allow-tools', ...o.tools] : []),
  ];
}

/** Spend estimate from earlier results: total for the kinds that have one, and the kinds that do not. */
export interface PlanEstimate { usd: number; missing: string[] }

export function planLines(cases: CaseInfo[], runs: number, model: string, maxCost: number, est: PlanEstimate | null): string[] {
  const total = cases.length * runs;
  const kinds = [...new Set(cases.map((c) => c.kind))].join(', ');
  const variants = [...new Set(cases.flatMap((c) => (c.variant ? [c.variant] : [])))].join(', ') || 'none';
  const none = `no estimate yet; the $${maxCost} ceiling caps the spend`;
  const estimate = est === null
    ? `No estimate yet; the $${maxCost} ceiling caps the spend`
    : `Estimate from your last run: ~$${est.usd.toFixed(USD_DECIMALS)}${est.missing.length ? `, without ${est.missing.join(', ')} (${none})` : ''}`;
  return [
    `kinds: ${kinds} (one eval run per kind)`, `model: ${model}`, `cases: ${cases.length}`, `variants: ${variants}`, `runs per case: ${runs}`,
    `agent runs: ${total}`, 'judge calls: 0', estimate,
    'The ceiling covers all kinds together: each kind gets what is left, and a later kind does not start when less than one agent run is left.',
    'Spend can pass the ceiling by up to one agent run.',
  ];
}
