import type { HarnessConfig } from '../core/config.js';
import type { Change, Manifest } from './apply.js';
import { detect } from './detect.js';
import { planChanges } from './plan.js';
import { matchesHash } from './text.js';

const CONFIG = '.harness/config.yaml';
const SETTINGS = '.claude/settings.json';
const MCP = '.mcp.json';

/**
 * The plan for `config` against what the manifest recorded, plus which of the files it would change the person edited
 * since harness wrote them. `owned`: harness wrote the whole file; `merged`: only harness's own parts change.
 */
export function reconcile(
  root: string, config: HarnessConfig, m: Manifest, ctx: Parameters<typeof planChanges>[3],
): { changes: Change[]; edited: { owned: string[]; merged: string[] }; notes: string[]; dropped: string[]; manual: string[]; config: HarnessConfig; market: string } {
  const entry = (rel: string) => m.files.find((f) => f.rel === rel);
  const planned = planChanges(root, config, detect(root), {
    ...ctx, recorded: entry(SETTINGS)?.blocks, mcpRecorded: entry(MCP)?.blocks, recordedFiles: m.files,
  });
  const merged = (rel: string) => entry(rel)?.kind === 'update' || !!entry(rel)?.blocks?.length || !!entry(rel)?.replace?.length;
  const edited = planned.changes
    .filter((c) => c.kind === 'update' && c.rel !== CONFIG && entry(c.rel) && !matchesHash(c.before, entry(c.rel)!.hash))
    .map((c) => c.rel);
  return {
    changes: planned.changes, edited: { owned: edited.filter((r) => !merged(r)), merged: edited.filter(merged) },
    notes: planned.notes, dropped: planned.dropped, manual: planned.manual, config: planned.config, market: planned.market,
  };
}
