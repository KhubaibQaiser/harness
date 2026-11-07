import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
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

/** Sets cost.context_tokens in an item file's text, touching only the cost line or block (block, or one-line flow with or without spaces, a trailing comment, CRLF). A line it can't read comes back unchanged: callers must check with rewriteCost. */
export function setContextTokens(text: string, n: number): string {
  const lines = text.split('\n');
  const cr = (i: number) => (lines[i].endsWith('\r') ? '\r' : '');
  const at = lines.findIndex((l) => /^cost:/.test(l));
  if (at < 0) return text;
  const val = /(context_tokens"?\s*:\s*)(null|\d+)/;
  if (/^cost:\s*\{/.test(lines[at])) {
    const l = lines[at].replace(/\r$/, ''), m = /^(cost:\s*\{)(.*?)(\s*)\}(\s*#.*)?$/.exec(l);
    if (!m) return text;
    let inner = m[2];
    if (val.test(inner)) inner = inner.replace(val, `$1${n}`);
    else {
      const colon = /:\s/.test(inner) ? ': ' : ':', comma = /,\s/.test(inner) ? ', ' : ',';
      inner = `${inner.replace(/,\s*$/, '')}${comma}${inner.includes('"context"') ? '"context_tokens"' : 'context_tokens'}${colon}${n}`;
    }
    lines[at] = `${m[1]}${inner}${m[3]}}${m[4] ?? ''}${cr(at)}`;
    return lines.join('\n');
  }
  let end = at + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  const hit = lines.findIndex((l, i) => i > at && i < end && /^\s+context_tokens:/.test(l));
  if (hit >= 0) lines[hit] = lines[hit].replace(/(context_tokens:\s*)(null|\d+)/, `$1${n}`);
  else lines.splice(end, 0, `${/^(\s+)/.exec(lines[at + 1] ?? '')?.[1] ?? '  '}context_tokens: ${n}${cr(at + 1)}`);
  return lines.join('\n');
}

/** setContextTokens, checked: the result must parse to the same item with only cost.context_tokens changed; otherwise undefined. */
export function rewriteCost(text: string, n: number): string | undefined {
  try {
    const out = setContextTokens(text, n);
    const want = parse(text) as { cost: Record<string, unknown> };
    want.cost.context_tokens = n;
    return isDeepStrictEqual(parse(out), want) ? out : undefined; // an unchanged rewrite fails this too
  } catch { return undefined; }
}
