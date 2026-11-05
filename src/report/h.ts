import { HIDDEN_CLASS } from '../core/config.js';

const HTML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HEX = 16, PAD = 4, BMP_MAX = 0xffff;
const HIDDEN = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f${HIDDEN_CLASS}]`, 'gu');
/** HTML escape, then control, zero-width and bidi characters as \uXXXX. Use on every string that came from a transcript. */
export const h = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => HTML[c]!).replace(HIDDEN, (c) => {
    const cp = c.codePointAt(0)!;
    return cp > BMP_MAX ? `\\u{${cp.toString(HEX)}}` : `\\u${cp.toString(HEX).padStart(PAD, '0')}`;
  });
