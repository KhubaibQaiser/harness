import { expect, test } from 'vitest';
import { identityProblemsIn } from '../../src/catalog/presets.js';

// The old EMAIL regex took about 4.7 s on 80k hostile characters; a linear one takes a few ms.
// Runs in the perf project (alone, no parallel suite), with a ceiling that only a quadratic path can reach.
test('identity check is linear on hostile input', () => {
  for (const t of ['a'.repeat(80_000), 'a@' + 'b.'.repeat(40_000)]) {
    const t0 = performance.now();
    identityProblemsIn(t, 'a');
    expect(performance.now() - t0).toBeLessThan(1000);
  }
});
