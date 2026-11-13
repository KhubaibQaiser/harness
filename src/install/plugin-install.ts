import { esc } from '../core/config.js';
import { defaultExec, type Exec } from '../core/exec.js';

// Matches the marketplace being unknown, never the id alone. Claude Code 2.1.322 (live check A1, 2026-11-12) says
// `Plugin "x" not found in marketplace "harness-pins"` when no trusted session has registered the project's marketplace yet,
// and its "marketplace update" hint fails too. Every harness id comes from its pins marketplace, so that wording means "not registered".
const P = 'harness-pins(?:-[0-9a-f]+)?';
const NO_MARKET = new RegExp(`marketplace\\b.*${P}.*(not found|unknown|not registered)|${P}.*marketplace.*(not found|unknown|not registered)|not found in marketplace\\W+${P}\\b`, 'i');
const notRegistered = (market: string) => `Claude Code hasn't registered \`${market}\` yet. Restart Claude Code in this folder (trust it if asked), then run /harness:sync.`;

/** The last stdout line that parses as a JSON object (the CLI may print progress lines before it). */
function lastJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Runs `claude plugin install <id> --scope project --json` for each id; nothing is thrown. */
export function installPlugins(ids: string[], exec: Exec = defaultExec): { ok: string[]; failed: { id: string; message: string }[] } {
  const ok: string[] = [];
  const failed: { id: string; message: string }[] = [];
  for (const id of ids) {
    const r = exec('claude', ['plugin', 'install', id, '--scope', 'project', '--json']);
    const j = lastJson(r.stdout);
    // Documented result line: { command, outcome: 'ok' | 'failed', message }. No JSON line at all falls back to the exit status.
    if (!r.missing && (j ? j.outcome === 'ok' : r.status === 0)) {
      ok.push(id);
      continue;
    }
    // The CLI's own words are untrusted text: escaped before they reach the terminal.
    const raw = r.missing ? 'Claude Code CLI not found on PATH' : esc(String(j?.message || r.stderr?.trim().split('\n')[0] || `exit ${r.status}`));
    failed.push({ id, message: !r.missing && NO_MARKET.test(raw) ? notRegistered(id.slice(id.lastIndexOf('@') + 1)) : raw });
  }
  return { ok, failed };
}

/** From `claude plugin list --json`; null when the CLI is missing, fails or prints something else. */
// ponytail: the container (bare array or { plugins }) is not documented; Task 27 verifies it against the real CLI.
export function pluginList(exec: Exec = defaultExec): { id: string; version: string; enabled: boolean; scope?: string }[] | null {
  const r = exec('claude', ['plugin', 'list', '--json']);
  if (r.missing || r.status !== 0) return null;
  try {
    const v = JSON.parse(r.stdout);
    const list = Array.isArray(v) ? v : v?.plugins;
    if (!Array.isArray(list)) return null;
    return list.filter((p) => typeof p?.id === 'string').map((p) => ({ id: p.id, version: typeof p.version === 'string' ? p.version : '', enabled: p.enabled === true, ...(typeof p.scope === 'string' ? { scope: p.scope } : {}) }));
  } catch {
    return null;
  }
}
