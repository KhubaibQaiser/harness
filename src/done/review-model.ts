// The review's model seam (spec §4.4 step 4): one `claude -p` call per prompt, run by verify itself, with no tools and no repo.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { parse } from 'yaml';
import { esc, isObj } from '../core/config.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { packageDir } from '../core/package-dir.js';
import { real, realish } from '../core/paths.js';
import { findOnPath } from '../checks/stop/runner.js';
import { escPath } from '../review/context.js';

export type ReviewModel = (call: { system: string; message: string; model: string; timeoutMs: number }) => Promise<{ text: string } | { error: string }>;

/**
 * One turn, no tools, from a prompt file (one argv line each, so a Windows .cmd shim gets it whole). The documented
 * `--safe-mode` and `--strict-mcp-config` keep the person's CLAUDE.md, memory, plugins, hooks and MCP servers out of the
 * reviewer; `--no-session-persistence` keeps its runs out of their session list. Login works as usual (`--bare` would not).
 */
export const claudeArgs = (model: string, systemFile: string): string[] =>
  ['-p', '--model', model, '--output-format', 'json', '--max-turns', '1', '--tools', '', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--system-prompt-file', systemFile];

const short = (s: string) => esc(s.split('\n').find((l) => l.trim())?.trim() ?? '').slice(0, 300);
const under = (dir: string, p: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The `claude` PATH finds, refused when it, or the PATH folder it was found through, is inside the repo: repo code can't stand in for the reviewer. */
export function reviewClaude(root: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { path: string } | { error: string } {
  const bin = findOnPath('claude', env, platform);
  if (!bin) return { error: 'claude is not on PATH' };
  const repo = realish(root), at = real(bin);
  if (under(repo, at) || under(repo, realish(dirname(bin)))) return { error: `claude resolves inside the repo (${escPath(bin)}); put Claude Code's own claude first on PATH` };
  return { path: at };
}

export function claudeModel(o: { root: string; exec?: Exec; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): ReviewModel {
  const { exec = defaultExec, env = process.env, platform = process.platform } = o;
  return async ({ system, message, model, timeoutMs }) => {
    const bin = reviewClaude(o.root, env, platform);
    if ('error' in bin) return bin;
    // An empty folder: no repo CLAUDE.md, settings or files reach the reviewer.
    const cwd = mkdtempSync(join(tmpdir(), 'harness-review-')), file = join(cwd, 'system.md');
    try {
      writeFileSync(file, system);
      // ponytail: Windows runs a .cmd shim by name (syncCommand needs it); elsewhere the checked file itself runs.
      const r = exec(platform === 'win32' ? 'claude' : bin.path, claudeArgs(model, file), { cwd, input: message, timeoutMs });
      if (r.missing) return { error: 'claude is not on PATH' };
      if (r.timedOut) return { error: `review timed out after ${Math.round(timeoutMs / 1000)}s` };
      let out: unknown;
      try { out = JSON.parse(r.stdout); } catch { out = null; }
      // ponytail: unverified whether claude -p starts under CLAUDECODE; its env is left alone (no bypass of Claude Code's own check).
      const hint = env.CLAUDECODE ? ' (inside Claude Code: run harness verify in your own terminal)' : '';
      if (!isObj(out) || out.type !== 'result') return { error: `claude exited ${r.status} without a result: ${short(r.stderr ?? '') || 'no stderr'}${hint}` };
      if (r.status !== 0 || out.is_error || typeof out.result !== 'string')
        return { error: `claude${r.status ? ` exited ${r.status}` : ''}: ${short(typeof out.result === 'string' ? out.result : String(out.subtype ?? 'error'))}` };
      return { text: out.result };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

const BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
export function fencedJson(text: string): { value: unknown } | { error: string } {
  const m = [...text.matchAll(BLOCK)];
  if (m.length !== 1) return { error: `the reply must hold exactly one \`\`\`json block (found ${m.length})` };
  try {
    return { value: JSON.parse(m[0]![1]!) };
  } catch (e) {
    return { error: `the reply's json block is not valid JSON: ${short((e as Error).message)}` };
  }
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const template = (rel: string) => readFileSync(join(packageDir('templates'), ...rel.split('/')), 'utf8');
/** From the harness package, never the repo, so a change under review can't soften its reviewer. */
export function agentPrompt(name: 'staff-reviewer' | 'review-judge'): { system: string; model: string | null } {
  const t = template(`agents/${name}.md`), m = FM.exec(t);
  const fm = (m ? parse(m[1]!) : null) as { model?: unknown } | null;
  return { system: t.slice(m?.[0].length ?? 0).trim(), model: typeof fm?.model === 'string' ? fm.model : null };
}
export const rubricText = (): string => template('skills/review-rubric/SKILL.md').replace(FM, '').trim();
