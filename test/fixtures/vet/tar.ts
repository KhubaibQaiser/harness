import { gzipSync } from 'node:zlib';

export interface TarSpec { name: string; body?: string | Buffer; type?: '0' | '1' | '2' | '5' | 'x' | 'L'; link?: string }

const put = (b: Buffer, off: number, s: string) => void b.write(s, off, 'latin1');

/** Builds a ustar tar.gz in memory. Each name is prefix + name, as GitHub's tarballs do. Names are not validated, so hostile ones can be written. */
export function tarGz(entries: TarSpec[], prefix = 'o-r-abc1234/'): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    const type = e.type ?? '0';
    const h = Buffer.alloc(512);
    put(h, 0, (type === 'x' || type === 'L' ? e.name : prefix + e.name).slice(0, 100));
    put(h, 100, '0000644\0');
    put(h, 124, body.length.toString(8).padStart(11, '0') + '\0');
    put(h, 136, '00000000000\0');
    put(h, 148, '        ');
    put(h, 156, type);
    if (e.link) put(h, 157, e.link.slice(0, 100));
    put(h, 257, 'ustar\x0000');
    const sum = h.reduce((a, c) => a + c, 0);
    put(h, 148, sum.toString(8).padStart(6, '0') + '\0 ');
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** One pax record: "<len> key=value\n", len counting itself. */
export function pax(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let len = rest.length + 1;
  while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
  return `${len}${rest}`;
}
