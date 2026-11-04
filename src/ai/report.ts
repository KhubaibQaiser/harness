import { esc } from '../core/config.js';
import { RAW_CONTROL } from './product.js';
import type { Picks } from './picks.js';

export const LIMITS_SENTENCE = "Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.";

const section = (md: string, name: string): string | null => {
  const m = new RegExp(`^## ${name}[ \\t]*$`, 'm').exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
};

/** Checks the recommend skill's report.md: the four sections, a 30/60/90 roadmap, and every finding id from picks. */
export function validateReport(md: string, p: Picks): string[] {
  const errors: string[] = [];
  if (RAW_CONTROL.test(md)) errors.push('report: must not contain control characters');
  for (const s of ['Findings', 'Roadmap', 'Deliberate exclusions', 'Limits']) if (section(md, s) === null) errors.push(`report: missing section "## ${s}"`);
  const road = section(md, 'Roadmap');
  if (road !== null) for (const d of [30, 60, 90]) if (!new RegExp(`\\b${d}\\b`).test(road)) errors.push(`report: "## Roadmap" must mention ${d} days`);
  const found = section(md, 'Findings');
  if (found !== null) for (const f of p.findings) if (!new RegExp(`(?<![\\w-])${f.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(found)) errors.push(`report: finding "${esc(f.id)}" is not in "## Findings"`);
  return errors;
}

/** Adds the enforcement sentence at the end of `## Limits` when it is missing. Call after validateReport passes. */
export function finalizeReport(md: string): string {
  if (md.includes(LIMITS_SENTENCE)) return md;
  const m = /^## Limits[ \t]*$/m.exec(md);
  if (!m) return `${md.replace(/\s*$/, '')}\n\n## Limits\n\n${LIMITS_SENTENCE}\n`;
  const start = m.index + m[0].length;
  const next = md.slice(start).search(/^## /m);
  const end = next < 0 ? md.length : start + next;
  return `${md.slice(0, end).replace(/\s*$/, '')}\n\n${LIMITS_SENTENCE}\n${end < md.length ? `\n${md.slice(end)}` : ''}`;
}
