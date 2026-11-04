import { esc } from '../core/config.js';
import { defaultExec, type Exec } from '../core/exec.js';

const PINS = 'harness-pins';
const NOT_REGISTERED = `Claude Code hasn't registered \`${PINS}\` yet. Restart Claude Code in this folder (trust it if asked), then run /harness:sync.`;

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
    if (!r.missing && r.status === 0 && j?.ok !== false && !j?.error) {
      ok.push(id);
      continue;
    }
    // The CLI's own words are untrusted text: escaped before they reach the terminal.
    const raw = r.missing ? 'Claude Code CLI not found on PATH' : esc(String(j?.error ?? j?.message ?? (r.stderr?.trim().split('\n')[0] || `exit ${r.status}`)));
    failed.push({ id, message: !r.missing && raw.includes(PINS) ? NOT_REGISTERED : raw });
  }
  return { ok, failed };
}

/** From `claude plugin list --json`; null when the CLI is missing, fails or prints something else. */
export function pluginList(exec: Exec = defaultExec): { id: string; version: string; enabled: boolean }[] | null {
  const r = exec('claude', ['plugin', 'list', '--json']);
  if (r.missing || r.status !== 0) return null;
  try {
    const v = JSON.parse(r.stdout);
    if (!Array.isArray(v)) return null;
    return v.filter((p) => typeof p?.id === 'string').map((p) => ({ id: p.id, version: typeof p.version === 'string' ? p.version : '', enabled: p.enabled === true }));
  } catch {
    return null;
  }
}
