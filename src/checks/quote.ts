// Quote detection (team-decisions spec §7.1): does a `harness remember add` draft repeat tool output from this
// session's transcript? Only compares; nothing from the transcript is kept, logged or returned (C2).
import { readTranscript, TRANSCRIPT_TAIL } from './multi-file.js';

export const QUOTE_WORDS = 8;
export const UNREADABLE = "transcript unreadable, so harness can't check";
const URL = /\bhttps?:\/\/\S*/i;

/** Lowercase, NFKC, no zero-width (format) characters, every run of non-letters-or-digits one space. Final sigma
 *  folds to σ: toLowerCase picks ς from the context, which differs between a draft span and the whole text. */
export const normalise = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/ς/g, 'σ').replace(/\p{Cf}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const words = (s: string): string[] => normalise(s).split(' ').filter(Boolean);
const WORDISH = /[\p{L}\p{N}\p{M}\p{Cf}]/u;
const ALNUM = /[\p{L}\p{N}]/u;

/** The draft's normalised words, each with the span of the original text it came from, so an excerpt can show the
 *  draft as written. A character is part of a word when it is one, or normalises to one (a circled letter). */
export function draftWords(text: string): { w: string; from: number; to: number }[] {
  const out: { w: string; from: number; to: number }[] = [];
  let from = -1, i = 0;
  const flush = (to: number) => {
    if (from >= 0) for (const w of words(text.slice(from, to))) out.push({ w, from, to });
    from = -1;
  };
  for (const c of text) {
    if (WORDISH.test(c) || ALNUM.test(c.normalize('NFKC'))) {
      if (from < 0) from = i;
    } else flush(i);
    i += c.length;
  }
  flush(i);
  return out;
}

/** At most 80 UTF-16 units, never ending in half a surrogate pair. */
const cut = (s: string): string => s.slice(0, 80).replace(/[\uD800-\uDBFF]$/, '');

/** The first field that quotes tool output, with the draft's own words that do (cut to 80 characters), or null. */
export function findQuote(fields: Record<string, string>, transcriptPath: unknown): { field: string; excerpt: string } | null {
  for (const field of ['--rule', '--why']) {
    const url = fields[field]?.match(URL);
    if (url) return { field, excerpt: cut(url[0]) };
  }
  // The draft's 8-word windows (a few) are looked up while the tool text is scanned once: linear in the transcript.
  const windows = new Map<string, { field: string; excerpt: string }>();
  for (const [field, text] of Object.entries(fields)) {
    const ws = draftWords(text);
    for (let i = 0; i + QUOTE_WORDS <= ws.length; i++) {
      const w = ws.slice(i, i + QUOTE_WORDS).map((x) => x.w).join(' ');
      if (!windows.has(w)) windows.set(w, { field, excerpt: cut(text.slice(ws[i]!.from, ws[i + QUOTE_WORDS - 1]!.to)) });
    }
  }
  if (!windows.size) return null; // no field of 8 words: nothing can be a quote, so no transcript is read
  const recs = readTranscript(transcriptPath, TRANSCRIPT_TAIL);
  if (!recs) return { field: 'the transcript', excerpt: UNREADABLE };
  const firsts = new Set([...windows.keys()].map((w) => w.slice(0, w.indexOf(' '))));
  for (const r of recs) {
    for (const t of r.tool) {
      const ws = words(t);
      for (let i = 0; i + QUOTE_WORDS <= ws.length; i++) {
        if (!firsts.has(ws[i]!)) continue;
        const hit = windows.get(ws.slice(i, i + QUOTE_WORDS).join(' '));
        if (hit) return hit;
      }
    }
  }
  return null;
}
