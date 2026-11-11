// Quote detection (team-decisions spec §7.1): does a `harness remember add` draft repeat tool output from this
// session's transcript? Only compares; nothing from the transcript is kept, logged or returned (C2).
import { readTranscript, TRANSCRIPT_TAIL } from './multi-file.js';

export const QUOTE_WORDS = 8;
export const UNREADABLE = "transcript unreadable, so harness can't check";
const URL = /\bhttps?:\/\/\S*/i;

/** Lowercase, NFKC, no zero-width (format) characters, every run of non-letters-or-digits one space. */
export const normalise = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\p{Cf}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const words = (s: string): string[] => normalise(s).split(' ').filter(Boolean);

/** The first field that quotes tool output, with the draft's own words that do (cut to 80 characters), or null. */
export function findQuote(fields: Record<string, string>, transcriptPath: unknown): { field: string; excerpt: string } | null {
  for (const field of ['--rule', '--why']) {
    const url = fields[field]?.match(URL);
    if (url) return { field, excerpt: url[0].slice(0, 80) };
  }
  const recs = readTranscript(transcriptPath, TRANSCRIPT_TAIL);
  if (!recs) return { field: 'the transcript', excerpt: UNREADABLE };
  // The draft's 8-word windows (a few) are looked up while the tool text is scanned once: linear in the transcript.
  const windows = new Map<string, string>();
  for (const [field, text] of Object.entries(fields)) {
    const ws = words(text);
    for (let i = 0; i + QUOTE_WORDS <= ws.length; i++) {
      const w = ws.slice(i, i + QUOTE_WORDS).join(' ');
      if (!windows.has(w)) windows.set(w, field);
    }
  }
  const firsts = new Set([...windows.keys()].map((w) => w.slice(0, w.indexOf(' '))));
  for (const r of recs) {
    for (const t of r.tool) {
      const ws = words(t);
      for (let i = 0; i + QUOTE_WORDS <= ws.length; i++) {
        if (!firsts.has(ws[i]!)) continue;
        const w = ws.slice(i, i + QUOTE_WORDS).join(' ');
        const field = windows.get(w);
        if (field) return { field, excerpt: w.slice(0, 80) };
      }
    }
  }
  return null;
}
