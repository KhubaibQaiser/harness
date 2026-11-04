import { esc } from '../core/config.js';
import { conflictPairs } from '../catalog/relations.js';
import type { Catalog } from '../catalog/schema.js';
import type { Answers } from './answers.js';

export interface Finding { id: string; severity: 'critical' | 'medium' | 'nit'; title: string }
export interface Pick { id: string; include: 'recommended' | 'optional'; reason: string; addresses: string[]; no_alternative?: string }
export interface Picks { catalog_version: number; findings: Finding[]; items: Pick[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const q = (s: string) => `"${esc(s)}"`; // user-controlled text never reaches the terminal raw

/** Checks the recommend skill's picks.json against the real catalog. Requires are not added here: the installer closes them. */
export function validatePicks(raw: unknown, c: Catalog, a: Answers): { ok: true; picks: Picks } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['picks: must be a mapping'] };
  const errors: string[] = [];
  for (const k of Object.keys(raw)) if (!['catalog_version', 'findings', 'items'].includes(k)) errors.push(`${esc(k)}: unknown key`);
  if (raw.catalog_version !== c.version) errors.push(`catalog_version: picks are for catalog ${typeof raw.catalog_version === 'number' ? raw.catalog_version : q(String(raw.catalog_version))}, this harness has catalog ${c.version}`);

  const findingIds = new Set<string>();
  if (!Array.isArray(raw.findings)) errors.push('findings: must be a list');
  else raw.findings.forEach((f, i) => {
    if (!isObj(f)) return void errors.push(`findings[${i}]: must be a mapping`);
    for (const k of Object.keys(f)) if (!['id', 'severity', 'title'].includes(k)) errors.push(`findings[${i}].${esc(k)}: unknown key`);
    if (!text(f.id)) errors.push(`findings[${i}].id: must be a non-empty string`);
    else if (findingIds.has(f.id)) errors.push(`findings[${i}].id: duplicate ${q(f.id)}`);
    else findingIds.add(f.id);
    if (f.severity !== 'critical' && f.severity !== 'medium' && f.severity !== 'nit') errors.push(`findings[${i}].severity: must be critical, medium or nit`);
    if (!text(f.title)) errors.push(`findings[${i}].title: must be a non-empty string`);
  });

  const byId = new Map(c.items.map((it) => [it.id, it]));
  const seen = new Set<string>();
  if (!Array.isArray(raw.items)) errors.push('items: must be a list');
  else {
    raw.items.forEach((p, i) => {
      if (!isObj(p)) return void errors.push(`items[${i}]: must be a mapping`);
      for (const k of Object.keys(p)) if (!['id', 'include', 'reason', 'addresses', 'no_alternative'].includes(k)) errors.push(`items[${i}].${esc(k)}: unknown key`);
      const it = typeof p.id === 'string' ? byId.get(p.id) : undefined;
      if (typeof p.id !== 'string') errors.push(`items[${i}].id: must be a string`);
      else if (!it) errors.push(`items[${i}].id: unknown item ${q(p.id)}`);
      else if (seen.has(p.id)) errors.push(`items[${i}].id: duplicate ${q(p.id)}`);
      else seen.add(p.id);
      if (p.include !== 'recommended' && p.include !== 'optional') errors.push(`items[${i}].include: must be recommended or optional`);
      if (!text(p.reason)) errors.push(`items[${i}].reason: must be a non-empty sentence`);
      if (!Array.isArray(p.addresses) || !p.addresses.every((x) => typeof x === 'string')) errors.push(`items[${i}].addresses: must be a list of finding ids`);
      else p.addresses.forEach((f, j) => findingIds.has(f) || errors.push(`items[${i}].addresses[${j}]: unknown finding ${q(f)}`));
      if (p.no_alternative !== undefined && typeof p.no_alternative !== 'string') errors.push(`items[${i}].no_alternative: must be a string`);
      if (it?.stance === 'discouraged' && !a.project.named_items.includes(it.id) && !text(p.no_alternative))
        errors.push(`items[${i}]: ${q(it.id)} is discouraged (${esc(it.stance_reason)}); propose it only when the user names it or no alternative fits, and say why in no_alternative`);
    });
    for (const [x, y] of conflictPairs([...seen], c)) errors.push(`items: ${q(x)} conflicts with ${q(y)}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, picks: raw as unknown as Picks };
}
