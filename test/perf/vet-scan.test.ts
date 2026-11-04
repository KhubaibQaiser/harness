import { describe, expect, it } from 'vitest';
import { scan } from '../../src/vet/scan.js';
import { makeRepo } from '../install/helpers.js';

describe('vet scan time', () => {
  it.each(['curl -o x ', 'env ', 'npx ', 'curl u | sudo ', 'sh -c ', 'curl '])('a 1 MB hostile line of %j scans in under 200 ms', (unit) => {
    const dir = makeRepo({ 'x.sh': unit.repeat(Math.ceil(1_000_000 / unit.length)) }, { git: false });
    const t = performance.now();
    scan({ dir, files: ['x.sh'], map: { 'x.sh': 'x.sh' }, skipped: [], large: [] }, '');
    expect(performance.now() - t).toBeLessThan(200);
  });
});
