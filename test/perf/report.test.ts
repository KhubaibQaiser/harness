import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { streamTranscript } from '../../src/report/transcript.js';
import { assistant, attachment, prompt, system, toolResult } from '../fixtures/transcripts/make.js';

const MB = 1_000_000;
const dir = mkdtempSync(join(tmpdir(), 'perf-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// About 1 MB of mixed records, appended until the file reaches `size`, so building it never holds the whole file.
const block = (() => {
  const recs = [
    prompt('run the tests'),
    assistant({ content: [{ type: 'text', text: 'word '.repeat(200) }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }] }),
    toolResult('t1', { content: 'ok 12 passed\n'.repeat(400) }),
    attachment('hook_success', { hookEvent: 'PreToolUse', command: 'node .harness/hooks/dispatch.mjs', durationMs: 40 }),
    { type: 'file-history-snapshot', snapshot: { files: 'x'.repeat(2000) } },
    system('stop_hook_summary', { preventedContinuation: false }),
  ].map((r) => JSON.stringify({ timestamp: '2026-11-01T00:00:00.000Z', version: '2.1.317', cwd: '/repo', ...r }) + '\n').join('');
  return recs.repeat(Math.ceil(MB / recs.length));
})();
const file = (size: number) => {
  const f = join(dir, `t${size}.jsonl`);
  writeFileSync(f, '');
  for (let n = 0; n < size; n += block.length) appendFileSync(f, block);
  return f;
};

const run = async (f: string) => {
  let peak = 0, n = 0;
  const rss0 = process.memoryUsage().rss;
  const t = performance.now();
  await streamTranscript(f, () => {
    if (++n % 5000 === 0) peak = Math.max(peak, process.memoryUsage().rss);
  });
  return { ms: performance.now() - t, grew: Math.max(peak, process.memoryUsage().rss) - rss0 };
};

// 10 MB against 100 MB is 10x the input: a linear scan grows about 10x (measured 9.1x), a quadratic one about 100x.
// 30 sits well between the two, as in vet-scan.test.ts.
describe('report transcript scan', () => {
  it('100 MB in under 5 s, linear growth, bounded memory', async () => {
    const small = file(10 * MB), big = file(100 * MB);
    await run(small); // warm-up
    const a = await run(small), b = await run(big);
    expect(b.ms, `100 MB took ${b.ms.toFixed(0)} ms`).toBeLessThan(5000);
    expect(b.ms / Math.max(a.ms, 2), `${a.ms.toFixed(0)} ms -> ${b.ms.toFixed(0)} ms`).toBeLessThan(30);
    expect(b.grew, `RSS grew ${(b.grew / MB).toFixed(0)} MB`).toBeLessThan(256 * MB);
  }, 60_000);
});
