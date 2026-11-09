// `harness context [--json] [--offline]`: the always-loaded and on-demand context against the budget (spec §5, §7.1).
// Reads only; writes nothing. The only network use in harness: Anthropic's token-counting API, with a key from the env.
import { dirname } from 'node:path';
import { apiCountTokens, countKey } from '../budget/count-api.js';
import { pluginEntry } from '../budget/measure.js';
import { contextSet, ownerTotals, type ContextSet } from '../budget/summary.js';
import { loadConfig } from '../core/config.js';
import { packageDir } from '../core/package-dir.js';
import { contextRecs } from './context-apply.js';
import { CATALOG_ESTIMATE, ESTIMATE_NOTE, reportJson, reportText } from './context-copy.js';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness context [--json] [--offline]';
const FLAGS = new Set(['--json', '--offline']);

/**
 * Re-counts every row with text in one API run. The plugin row has no text in the set, so its skill and agent text is
 * read again from dirs.plugin and counted too. A catalog pick keeps its recorded number, marked. Null on any failure.
 */
async function apiCounted(s: ContextSet, key: string, model: string, deps: { plugin: string; fetch?: typeof fetch; onFail: (r: string) => void }): Promise<ContextSet | null> {
  const rows = [...s.always, ...s.onDemand];
  const pluginText = pluginEntry(deps.plugin).text;
  const textOf = (e: (typeof rows)[number]) => (e.path === 'plugin:harness' ? pluginText : e.text);
  const texts = rows.flatMap((e, i) => { const text = textOf(e); return text ? [{ id: String(i), text }] : []; });
  const counts = await apiCountTokens(key, model, { fetch: deps.fetch, onFail: deps.onFail })(texts);
  if (!counts) return null;
  const next = rows.map((e, i) => {
    if (Object.hasOwn(counts, String(i))) return { ...e, tokens: counts[String(i)] };
    // No text to send: the number stays, and the row says it is an estimate.
    return e.tokens > 0 ? { ...e, note: e.owner.startsWith('catalog:') ? CATALOG_ESTIMATE : ESTIMATE_NOTE } : e;
  });
  const always = next.slice(0, s.always.length);
  return { ...s, always, onDemand: next.slice(s.always.length), ...ownerTotals(always), method: 'exact', model };
}

export async function context(args: string[], cli: CliEnv & { fetch?: typeof fetch }): Promise<number> {
  const flags = new Set(args);
  if (flags.size !== args.length || args.some((a) => !FLAGS.has(a))) return cli.out(USAGE), 2;
  const { config, warnings } = loadConfig(cli.root);
  const templates = packageDir('templates');
  const plugin = dirname(templates);
  let s = contextSet(cli.root, config, { templates, plugin });
  const recs = contextRecs(cli.root, config, { templates, plugin });
  let fallback: string | null = null;
  const offline = flags.has('--offline') || config.context.count === 'offline';
  const key = offline ? null : countKey(cli.env, config);
  if (key) s = (await apiCounted(s, key, config.context.count_model, { plugin, fetch: cli.fetch, onFail: (r) => { fallback = r; } })) ?? s;
  if (flags.has('--json')) cli.out(JSON.stringify(reportJson(s, recs, fallback), null, 2));
  else for (const line of [...reportText(s, recs, fallback, !offline && !key), ...warnings.map((w) => `warn ${w}`)]) cli.out(line);
  return s.total > s.budget ? 1 : 0;
}
