import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { packageDir } from '../core/package-dir.js';
import type { Catalog } from './schema.js';

/** Cross-item checks only; per-field checks are validateItem's. */
export function checkCatalog(c: Catalog, templatesDir = packageDir('templates')): string[] {
  const errors: string[] = [];
  const ids = new Set(c.items.map((i) => i.id));
  for (const it of c.items) {
    for (const k of ['requires', 'conflicts_with'] as const) for (const t of it[k]) if (t === it.id) errors.push(`${it.id}: ${k} "${t}": an item cannot list itself`);
      else if (!ids.has(t)) errors.push(`${it.id}: ${k} "${t}", which is not in the catalog`);
    if (it.source.type === 'own') it.source.files?.forEach((f, i) => existsSync(join(templatesDir, f.from)) || errors.push(`${it.id}: source.files[${i}].from: template ${f.from} not found`));
  }
  return errors;
}
