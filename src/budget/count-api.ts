// The one place ANTHROPIC_API_KEY is read. Exact token counts via the count_tokens endpoint; any failure falls back to the estimate.
import type { HarnessConfig } from '../core/config.js';
import type { CountTokens } from './measure.js';

export const COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
export const PER_CALL_MS = 5000;
export const TOTAL_MS = 20000;

export const countKey = (env: NodeJS.ProcessEnv, config: HarnessConfig): string | null =>
  config.context.count === 'offline' ? null : env.ANTHROPIC_API_KEY || null;

export function apiCountTokens(
  key: string, model: string, deps: { fetch?: typeof fetch; now?: () => number; onFail?: (reason: string) => void } = {},
): CountTokens {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  return async (texts) => {
    const deadline = now() + TOTAL_MS;
    const fail = (reason: string): null => { deps.onFail?.(reason); return null; };
    // Reasons are only a status, 'timeout' or 'network error': never the key, a header or a body.
    const one = async (text: string): Promise<number | string> => {
      const ms = Math.min(PER_CALL_MS, deadline - now());
      if (ms <= 0) return 'timeout';
      try {
        const res = await doFetch(COUNT_URL, {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
          signal: AbortSignal.timeout(ms),
        });
        if (!res.ok) return String(res.status);
        const n = ((await res.json()) as { input_tokens?: unknown }).input_tokens;
        return typeof n === 'number' ? n : 'bad response';
      } catch (e) {
        return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network error';
      }
    };
    const base = await one('.');
    if (typeof base === 'string') return fail(base);
    const out: Record<string, number> = {};
    for (const { id, text } of texts) {
      const n = await one(text);
      if (typeof n === 'string') return fail(n);
      out[id] = Math.max(0, n - base);
    }
    return out;
  };
}
