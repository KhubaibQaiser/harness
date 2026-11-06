import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { UNTRACKED, untrackedLines } from '../../../src/checks/pr-size/untracked.js';

const spies = vi.hoisted(() => ({ open: [] as unknown[][] }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return { ...real, openSync: ((...a: unknown[]) => (spies.open.push(a), (real.openSync as (...x: unknown[]) => number)(...a))) as typeof real.openSync };
});

const dir = () => mkdtempSync(join(tmpdir(), 'harness-untracked-'));

describe('chunk boundaries (64 KB reads)', () => {
  const CHUNK = 64 * 1024;
  const count = (body: string) => {
    const root = dir();
    writeFileSync(join(root, 'f.txt'), body);
    return untrackedLines(root, 'f.txt');
  };
  test('a newline on the last byte of a chunk, and one on the first byte of the next, count once each', () => {
    expect(count('x'.repeat(CHUNK - 1) + '\n' + 'y')).toBe(2);
    expect(count('x'.repeat(CHUNK) + '\n' + 'y\n')).toBe(2);
  });
  test('a \\r\\n pair split across the chunk edge counts as one line', () => {
    expect(count('x'.repeat(CHUNK - 1) + '\r\nz\n')).toBe(2);
  });
  test('exactly one chunk with no final newline is 1 line; with a final newline it is 1 line too', () => {
    expect(count('x'.repeat(CHUNK))).toBe(1);
    expect(count('x'.repeat(CHUNK - 1) + '\n')).toBe(1);
  });
});

describe('untrackedLines', () => {
  test('a file of exactly maxBytes is read; one byte more is 0 lines', () => {
    const root = dir();
    writeFileSync(join(root, 'exact.txt'), 'x\n'.repeat(UNTRACKED.maxBytes / 2));
    writeFileSync(join(root, 'over.txt'), 'x\n'.repeat(UNTRACKED.maxBytes / 2) + 'y');
    expect(untrackedLines(root, 'exact.txt')).toBe(UNTRACKED.maxBytes / 2);
    expect(untrackedLines(root, 'over.txt')).toBe(0);
  });

  test('a path with a newline is read', () => {
    const root = dir();
    try {
      mkdirSync(join(root, 'a\nb'));
    } catch {
      return; // the filesystem refuses newlines in names (Windows)
    }
    writeFileSync(join(root, 'a\nb', 'c\nd.txt'), '1\n2\n');
    expect(untrackedLines(root, 'a\nb/c\nd.txt')).toBe(2);
  });

  test('allocates no maxBytes-sized buffer per file', () => {
    const root = dir();
    writeFileSync(join(root, 'a.txt'), 'x\n');
    const alloc = vi.spyOn(Buffer, 'alloc');
    const unsafe = vi.spyOn(Buffer, 'allocUnsafe');
    for (let i = 0; i < 3; i++) untrackedLines(root, 'a.txt');
    const sizes = [...alloc.mock.calls, ...unsafe.mock.calls].map((c) => c[0] as number);
    vi.restoreAllMocks();
    expect(sizes.filter((s) => s >= UNTRACKED.maxBytes)).toEqual([]);
  });

  // Windows has no O_NOFOLLOW; it keeps the lstat check alone.
  test.skipIf(process.platform === 'win32')('opens with O_NOFOLLOW so a swapped-in symlink is not followed', async () => {
    const root = dir();
    writeFileSync(join(root, 'a.txt'), 'x\n');
    spies.open.length = 0;
    untrackedLines(root, 'a.txt');
    const { constants } = await import('node:fs');
    expect(typeof spies.open[0]![1]).toBe('number');
    expect((spies.open[0]![1] as number) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });
});
