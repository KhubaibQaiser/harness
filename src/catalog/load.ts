import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { packageDir } from '../core/package-dir.js';
import { ID_RE, validateItem } from './schema.js';
import type { Catalog, CatalogItem } from './schema.js';

export type CompactItem = Pick<CatalogItem, 'id' | 'kind' | 'applies_when' | 'why' | 'cost' | 'stance' | 'stance_reason' | 'conflicts_with' | 'requires'>;

const readYaml = (p: string): unknown => parse(readFileSync(p, 'utf8'));

/** File-level checks live here; per-field checks are validateItem's. A missing items/ is an empty catalog. */
export function loadCatalog(dir = packageDir('catalog')): { catalog: Catalog; excluded: { id: string; reason: string }[]; errors: string[] } {
  const errors: string[] = [];
  const items: CatalogItem[] = [];
  const files = new Map<string, string>(); // id -> file it came from
  const itemsDir = join(dir, 'items');
  const names = existsSync(itemsDir) ? readdirSync(itemsDir).filter((f) => f.endsWith('.yaml')).sort() : [];
  for (const f of names) {
    let raw: unknown;
    try {
      raw = readYaml(join(itemsDir, f));
    } catch (e) {
      errors.push(`${f}: not valid YAML (${(e as Error).message.split('\n')[0]})`);
      continue;
    }
    const r = validateItem(raw, f);
    if (!r.ok) { errors.push(...r.errors); continue; }
    const { id } = r.item;
    if (files.has(id)) errors.push(`duplicate id "${id}" in ${files.get(id)} and ${f}`);
    if (f !== `${id}.yaml`) errors.push(`${f}: file name must be ${id}.yaml (the item id)`);
    if (!files.has(id)) { files.set(id, f); items.push(r.item); }
  }
  const excluded: { id: string; reason: string }[] = [];
  const exFile = join(dir, 'excluded.yaml');
  let list: unknown = [];
  try {
    if (existsSync(exFile)) list = readYaml(exFile) ?? [];
  } catch (e) {
    errors.push(`excluded.yaml: not valid YAML (${(e as Error).message.split('\n')[0]})`);
  }
  if (!Array.isArray(list)) errors.push('excluded.yaml: must be a list of { id, reason }');
  else list.forEach((e, i) => {
    if (typeof e?.id !== 'string' || typeof e?.reason !== 'string' || !e.reason.trim()) return void errors.push(`excluded.yaml[${i}]: must be { id, reason } with non-empty strings`);
    if (!ID_RE.test(e.id)) return void errors.push(`excluded.yaml[${i}]: id must be lowercase letters, digits and hyphens`);
    if (excluded.some((x) => x.id === e.id)) return void errors.push(`duplicate excluded id "${e.id}"`);
    excluded.push({ id: e.id, reason: e.reason });
    if (files.has(e.id)) errors.push(`"${e.id}" is in both items/ and excluded.yaml`);
  });
  let version = 1;
  try {
    const head = existsSync(join(dir, 'catalog.yaml')) ? readYaml(join(dir, 'catalog.yaml')) : null;
    const v = (head as { version?: unknown } | null)?.version;
    if (typeof v === 'number' && Number.isInteger(v)) version = v;
    else errors.push('catalog.yaml: version must be an integer');
  } catch (e) {
    errors.push(`catalog.yaml: not valid YAML (${(e as Error).message.split('\n')[0]})`);
  }
  return { catalog: { version, items }, excluded, errors };
}

export const compactCatalog = (c: Catalog): CompactItem[] =>
  c.items
    .map(({ id, kind, applies_when, why, cost, stance, stance_reason, conflicts_with, requires }) => ({ id, kind, applies_when, why, cost, stance, stance_reason, conflicts_with, requires }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
