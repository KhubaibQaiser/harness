import { checkCatalog } from '../catalog/check.js';
import { compactCatalog, loadCatalog } from '../catalog/load.js';
import { resolvePins } from '../catalog/resolve.js';
import { measurable, measureItemContext, rewriteCost } from '../catalog/context-check.js';
import { defaultExec, defaultExecBytes, type Exec, type ExecBytes } from '../core/exec.js';
import { packageDir } from '../core/package-dir.js';
import { checkPresetDir } from './preset.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness catalog\n       harness catalog check [--resolve [--context [--write-context]] [--only <id,...>]]';

export function catalog(args: string[], { out }: CliEnv, deps: { dir?: string; exec?: Exec; execBytes?: ExecBytes } = {}): number {
  const { catalog: c, errors } = loadCatalog(deps.dir ?? packageDir('catalog'));
  if (!args.length) {
    if (errors.length) return errors.forEach((e) => out(e)), 1;
    return out(JSON.stringify({ catalog_version: c.version, items: compactCatalog(c) }, null, 2)), 0;
  }
  if (args[0] !== 'check') return out(USAGE), 2;
  let resolve = false;
  let only: string[] | undefined;
  let context = false, write = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--resolve') resolve = true;
    else if (args[i] === '--context') context = true;
    else if (args[i] === '--write-context') write = true;
    else if (args[i] === '--only' && args[i + 1] && !args[i + 1].startsWith('--')) only = args[++i].split(',').filter(Boolean);
    else return out(USAGE), 2;
  }
  if (write && !context) return out('Usage: --write-context needs --context'), 2;
  if (context && !resolve) return out('Usage: --context needs --resolve'), 2;
  if (only && (!resolve || !only.length)) return out(USAGE), 2;
  const problems = [...errors, ...checkCatalog(c)];
  const pd = join(deps.dir ?? packageDir('catalog'), 'presets');
  if (existsSync(pd)) for (const r of checkPresetDir(pd, c, false)) problems.push(...r.errors.map((e) => `presets/${r.id}: ${e}`));
  let unpinned: { id: string; reason: string }[] = [];
  if (resolve) {
    const r = resolvePins(c, deps.exec ?? defaultExec, only);
    problems.push(...r.problems);
    unpinned = r.unpinned;
  }
  const notMeasured: string[] = [], changes: string[] = [];
  if (context) {
    const dirPath = deps.dir ?? packageDir('catalog');
    for (const it of c.items.filter((i) => measurable(i) && (!only || only.includes(i.id)))) {
      const m = measureItemContext(it, deps.execBytes ?? defaultExecBytes);
      const sha = (it.source as { sha: string }).sha.slice(0, 7);
      if ('error' in m && m.limit) { notMeasured.push(`${it.id} (too large for vet to measure)`); continue; }
      if ('error' in m) { problems.push(`${it.id}: could not verify cost.context_tokens: ${m.error}`); continue; }
      const rec = it.cost.context_tokens;
      if (write) {
        if (rec === m.tokens) continue;
        const f = join(dirPath, 'items', `${it.id}.yaml`);
        if (!existsSync(f)) { problems.push(`${it.id}: items/${it.id}.yaml not found, could not rewrite cost line`); continue; }
        let next: string | undefined;
        try { next = rewriteCost(readFileSync(f, 'utf8'), m.tokens); } catch { /* reported below */ }
        if (next === undefined) { problems.push(`${it.id}: could not rewrite cost line`); continue; }
        writeFileSync(f, next);
        changes.push(`${it.id}: cost.context_tokens ${rec ?? 'none'} -> ${m.tokens} at ${sha}`);
      } else if (rec === undefined || rec === null) notMeasured.push(it.id);
      else if (rec !== m.tokens) problems.push(`${it.id}: cost.context_tokens is ${rec}, measured ${m.tokens} at ${sha}`);
    }
  }
  changes.forEach((p) => out(p));
  problems.forEach((p) => out(p));
  if (notMeasured.length) out(`Not measured:\n${notMeasured.map((id) => `  ${id}`).join('\n')}`);
  if (unpinned.length) out(`Unpinned:\n${unpinned.map((u) => `  ${u.id}: ${u.reason}`).join('\n')}`);
  return problems.length ? 1 : 0;
}
