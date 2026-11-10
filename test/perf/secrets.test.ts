// The secret scan must stay linear: 1 MB of each adversarial family, against 256 KB, plus a loose ceiling.
import { expect, test } from 'vitest';
import { scanSecrets } from '../../src/core/secrets.js';

const CEILING_MS = { win32: 1000, darwin: 500 }[process.platform as string] ?? 400;
const MAX_RATIO = 10; // 4x the input should cost ~4x; 10x flags superlinear growth
const FAMILIES = ['a', '1', '-', 'a1', 'a:/', 'a://u', 'AKIA', 'ghp_', 'sk-', 'eyJ', 'a://', 'token ', '-----BEGIN '];

const best = (text: string): number => {
  scanSecrets(text); // warm-up
  let min = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    scanSecrets(text);
    min = Math.min(min, performance.now() - t);
  }
  return min;
};
const make = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length));

test.each(FAMILIES)('scan stays linear on repeats of %j', (unit) => {
  const small = best(make(unit, 256 * 1024));
  const big = best(make(unit, 1024 * 1024));
  expect(big, `1 MB took ${big.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
  expect(big / Math.max(small, 1), `1 MB ${big.toFixed(1)} ms vs 256 KB ${small.toFixed(1)} ms`).toBeLessThan(MAX_RATIO);
});
