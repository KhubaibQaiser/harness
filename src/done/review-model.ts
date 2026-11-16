// The review's model seam (spec §4.4 step 4): one `claude -p` call per prompt, run by verify itself, with no tools and no repo.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { esc, isObj } from '../core/config.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { packageDir } from '../core/package-dir.js';

export type ReviewModel = (call: { system: string; message: string; model: string; timeoutMs: number }) => Promise<{ text: string } | { error: string }>;

/** One turn, no tools: the prompt can't make the model read, run or write anything. */
export const claudeArgs = (model: string, system: string): string[] => ['-p', '--model', model, '--output-format', 'json', '--max-turns', '1', '--tools', '', '--system-prompt', system];

const short = (s: string) => esc(s.split('\n').find((l) => l.trim())?.trim() ?? '').slice(0, 300);

export function claudeModel(exec: Exec = defaultExec, env: NodeJS.ProcessEnv = process.env): ReviewModel {
  return async ({ system, message, model, timeoutMs }) => {
    // An empty folder: no repo CLAUDE.md, settings or files reach the reviewer.
    const cwd = mkdtempSync(join(tmpdir(), 'harness-review-'));
    try {
      const r = exec('claude', claudeArgs(model, system), { cwd, input: message, timeoutMs });
      if (r.missing) return { error: 'claude is not on PATH' };
      if (r.timedOut) return { error: `review timed out after ${Math.round(timeoutMs / 1000)}s` };
      let out: unknown;
      try { out = JSON.parse(r.stdout); } catch { out = null; }
      // ponytail: unverified whether claude -p starts under CLAUDECODE; its env is left alone (no bypass of Claude Code's own check).
      const hint = env.CLAUDECODE ? ' (inside Claude Code: run harness verify in your own terminal)' : '';
      if (!isObj(out) || out.type !== 'result') return { error: `claude exited ${r.status} without a result: ${short(r.stderr ?? '') || 'no stderr'}${hint}` };
      if (out.is_error || typeof out.result !== 'string') return { error: `claude: ${short(typeof out.result === 'string' ? out.result : String(out.subtype ?? 'error'))}` };
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
