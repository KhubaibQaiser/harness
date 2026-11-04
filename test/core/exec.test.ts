import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultExecBytes } from '../../src/core/exec.js';

describe('defaultExecBytes', () => {
  const js = 'process.stdout.write(Buffer.from([0,255,1]))';
  it('keeps stdout binary', () => {
    const r = defaultExecBytes(process.execPath, ['-e', js], 10);
    expect([...r.stdout]).toEqual([0, 255, 1]);
  });
  it('flags output over maxBytes', () => {
    expect(defaultExecBytes(process.execPath, ['-e', js], 2).tooBig).toBe(true);
  });
  it('reports a missing binary', () => {
    expect(defaultExecBytes('no-such-binary-xyz', [], 10).missing).toBe(true);
    expect(defaultExecBytes(join(tmpdir(), 'no-such-binary-xyz'), [], 10).missing).toBe(true);
  });
});
