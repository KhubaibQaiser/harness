import { gunzipSync } from 'node:zlib';

export interface TarEntry { path: string; type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other'; data: Buffer }

const TYPES: Record<string, TarEntry['type']> = { '0': 'file', '\0': 'file', '5': 'dir', '2': 'symlink', '1': 'hardlink' };
const str = (b: Buffer, off: number, len: number): string => {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? s.length : z).toString('utf8');
};

function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  for (let i = 0; i < data.length; ) {
    const sp = data.indexOf(0x20, i);
    const len = Number(data.subarray(i, sp).toString());
    if (sp < 0 || !(len > 0) || i + len > data.length) throw new Error('archive is corrupt');
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    if (rec.startsWith('path=')) path = rec.slice(5);
    i += len;
  }
  return path;
}

/** Reads a tar.gz in memory (never touches disk). Strips the first path component; link targets are not followed. */
export function readTar(gz: Buffer, maxOut: number): TarEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: maxOut });
  } catch (e) {
    throw new Error((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? `archive expands past ${Math.round(maxOut / 1048576)} MB` : 'archive is corrupt');
  }
  const out: TarEntry[] = [];
  let longName: string | undefined, paxName: string | undefined;
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((c) => c === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (parseInt(str(h, 148, 8).trim(), 8) !== sum) throw new Error('archive is corrupt');
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    if (!(size >= 0) || off + 512 + size > tar.length) throw new Error('archive is corrupt');
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    const flag = String.fromCharCode(h[156]);
    if (flag === 'g') continue;
    if (flag === 'x') { paxName = paxPath(data); continue; }
    if (flag === 'L') { longName = str(data, 0, data.length); continue; }
    const prefix = str(h, 345, 155);
    const name = paxName ?? longName ?? (prefix && str(h, 257, 5) === 'ustar' ? `${prefix}/` : '') + str(h, 0, 100);
    paxName = longName = undefined;
    const i = name.indexOf('/');
    const path = i < 0 ? '' : name.slice(i + 1);
    if (path === '') continue;
    out.push({ path, type: TYPES[flag] ?? 'other', data: Buffer.from(data) });
  }
  return out;
}
