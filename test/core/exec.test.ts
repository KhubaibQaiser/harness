import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultExec, defaultExecBytes } from '../../src/core/exec.js';

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

describe('defaultExec options', () => {
  it('flags a timeout and kills the child', () => {
    const t0 = Date.now();
    const r = defaultExec(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('does not flag a normal run', () => {
    expect(defaultExec(process.execPath, ['-e', '1'], { timeoutMs: 5000 }).timedOut).toBeUndefined();
  });
  it('runs in cwd', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exec-cwd-')));
    expect(defaultExec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir }).stdout).toBe(dir);
  });
  it('feeds input to stdin', () => {
    expect(defaultExec('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'x' }).stdout).toBe('x');
    expect(defaultExecBytes(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 10, 'yz').stdout.toString()).toBe('yz');
  });
  it('reports a missing absolute path as missing, not as a failed run', () => {
    expect(defaultExec(join(tmpdir(), 'no-such-binary-xyz'), []).missing).toBe(true);
  });
});
