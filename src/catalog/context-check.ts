import type { ExecBytes } from '../core/exec.js';
import { cleanTmp, fetchTarball } from '../vet/fetch.js';
import { scan } from '../vet/scan.js';
import type { CatalogItem } from './schema.js';

/** Plugin and external-skill items with a pinned git source; MCP stays unmeasured and own items are measured locally. */
export const measurable = (i: CatalogItem): boolean => (i.kind === 'plugin' || i.kind === 'external-skill') && (i.source.type === 'github' || i.source.type === 'git-subdir');

/** Tokens the item adds to context at its pinned commit, by the same count `harness vet` makes. */
export function measureItemContext(item: CatalogItem, exec: ExecBytes): { tokens: number } | { error: string } {
  const s = item.source;
  if (s.type !== 'github' && s.type !== 'git-subdir') return { error: `${item.id}: source has no pinned commit` };
  const path = s.type === 'git-subdir' ? s.path : '';
  const f = fetchTarball({ repo: s.repo, ref: s.sha, sha: s.sha, path }, exec);
  if ('error' in f) return f;
  try { return { tokens: scan(f, path).context.tokens }; } catch (e) { return { error: (e as Error).message }; } finally { cleanTmp(f.dir); }
}

/** Sets cost.context_tokens in an item file's text, touching only the cost line or block (block, or one-line flow with or without spaces). */
export function setContextTokens(text: string, n: number): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^cost:/.test(l));
  if (at < 0) return text;
  const val = /(context_tokens"?\s*:\s*)(null|\d+)/;
  if (/^cost:\s*\{/.test(lines[at])) {
    const l = lines[at], body = l.slice(l.indexOf('{') + 1);
    const pad = /^\s/.test(body) ? ' ' : '', colon = /:\s/.test(body) ? ': ' : ':', comma = /,\s/.test(body) ? ', ' : ',';
    lines[at] = val.test(l) ? l.replace(val, `$1${n}`) : l.replace(/\s*\}\s*$/, `${comma}${body.includes('"context"') ? '"context_tokens"' : 'context_tokens'}${colon}${n}${pad}}`);
    return lines.join('\n');
  }
  let end = at + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  const hit = lines.findIndex((l, i) => i > at && i < end && /^\s+context_tokens:/.test(l));
  if (hit >= 0) lines[hit] = lines[hit].replace(/(context_tokens:\s*)(null|\d+)/, `$1${n}`);
  else lines.splice(end, 0, `${/^(\s+)/.exec(lines[at + 1] ?? '')?.[1] ?? '  '}context_tokens: ${n}`);
  return lines.join('\n');
}
