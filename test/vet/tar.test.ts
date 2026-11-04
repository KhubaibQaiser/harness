import { execFileSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readTar } from '../../src/vet/tar.js';
import { makeRepo } from '../install/helpers.js';
import { pax, tarGz } from '../fixtures/vet/tar.js';

const big = 1 << 20;
describe('readTar', () => {
  it('round-trips files and dirs, stripping the first component', () => {
    const e = readTar(tarGz([{ name: 'a/', type: '5' }, { name: 'a/b.md', body: 'hi' }]), big);
    expect(e.map((x) => [x.path, x.type, x.data.toString()])).toEqual([['a/', 'dir', ''], ['a/b.md', 'file', 'hi']]);
  });
  it('lets a pax path win over the header name', () => {
    const long = 'd/' + 'n'.repeat(150) + '.md';
    const e = readTar(tarGz([{ name: 'PaxHeader', type: 'x', body: pax('path', 'o-r-abc1234/' + long) }, { name: 'short', body: 'y' }]), big);
    expect(e.map((x) => x.path)).toEqual([long]);
  });
  it('reads a GNU long name and types links', () => {
    const long = 'n'.repeat(130);
    const e = readTar(tarGz([{ name: '././@LongLink', type: 'L', body: 'o-r-abc1234/' + long + '\0' }, { name: 'x', body: 'z' }, { name: 'l', type: '2', link: 'x' }, { name: 'h', type: '1', link: 'x' }]), big);
    expect(e.map((x) => [x.path, x.type])).toEqual([[long, 'file'], ['l', 'symlink'], ['h', 'hardlink']]);
  });
  it('throws on a bad checksum', () => {
    expect(() => readTar(gzipSync(Buffer.concat([Buffer.alloc(100, 97), Buffer.alloc(412, 1)])), big)).toThrow('archive is corrupt');
  });
  it('throws on truncation and non-gzip input', () => {
    const tar = Buffer.from(tarGz([{ name: 'a', body: 'x'.repeat(2000) }]));
    expect(() => readTar(tar.subarray(0, 20), big)).toThrow('archive is corrupt');
    expect(() => readTar(Buffer.from('nope'), big)).toThrow('archive is corrupt');
  });
  it('caps a gzip bomb', () => {
    expect(() => readTar(gzipSync(Buffer.alloc(2e6)), 1e6)).toThrow('archive expands past');
  });
  it('reads a real git archive', () => {
    const repo = makeRepo({ 'skills/a/SKILL.md': 'x', ['d/' + 'n'.repeat(120) + '.md']: 'y' }, { prefix: 'vet-git-', branch: 'main' });
    const gz = execFileSync('git', ['archive', '--format=tar.gz', '--prefix=o-r-abc/', 'HEAD'], { cwd: repo, maxBuffer: 1 << 24 });
    const files = readTar(gz, big).filter((e) => e.type === 'file').map((e) => e.path).sort();
    expect(files).toEqual(['d/' + 'n'.repeat(120) + '.md', 'skills/a/SKILL.md']);
  });
  it('rejects a tar cut at a header boundary, a negative size and a lenient number', () => {
    const one = gunzipSync(tarGz([{ name: 'a', body: 'x' }]));
    expect(() => readTar(gzipSync(one.subarray(0, 1024)), big)).toThrow('archive is corrupt');
    expect(() => readTar(tarGz([{ name: 'a', body: '', size: '-0000000001\0' }]), big)).toThrow('archive is corrupt');
    expect(() => readTar(tarGz([{ name: 'a', body: '', size: '1x\0' }]), big)).toThrow('archive is corrupt');
  });
  it('keeps a .. hidden in a pax or GNU long name so the caller can reject it', () => {
    const e = readTar(tarGz([{ name: 'P', type: 'x', body: pax('path', 'o-r-abc1234/../../p') }, { name: 'a' }, { name: 'L', type: 'L', body: 'o-r-abc1234/../g\0' }, { name: 'b' }]), big);
    expect(e.map((x) => x.path)).toEqual(['../../p', '../g']);
  });
  it('ignores GNU K headers, reads type 7 as a file, and types devices as other', () => {
    const e = readTar(tarGz([{ name: 'K', type: 'K', body: 'target\0' }, { name: 'c', type: '7', body: 'c' }, { name: 'd', type: '3' }]), big);
    expect(e.map((x) => [x.path, x.type])).toEqual([['c', 'file'], ['d', 'other']]);
  });
  it('reads non-ASCII names', () => {
    expect(readTar(tarGz([{ name: 'caf\u00e9.md', body: 'x' }]), big)[0].path).toBe('caf\u00e9.md');
  });
});
