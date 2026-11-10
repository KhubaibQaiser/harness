// Fixed-pattern secret scan (team-decisions spec 7.2): no dependency, no network.
// Patterns miss secrets without a known shape. Never put a matched value in a message.
export interface SecretHit {
  kind: string;
  start: number;
  end: number;
}

export const SECRET_PATTERNS: readonly [kind: string, re: RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['GitHub token', /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Anthropic or OpenAI key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['Anthropic or OpenAI key', /\bsk-[A-Za-z0-9]{32,}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  // Spec: [a-z][a-z0-9+.-]*://... A bare scheme scan is quadratic on a long run of letters. The lookbehind plus the
  // leading [0-9+.-]* start the match at the run start, so it is linear and still catches `2https://` or `-https://`.
  // Same hit count as the spec pattern; the span may start a few characters earlier, so a redaction can cover slightly more.
  ['URL with credentials', /(?<![a-z0-9+.-])[0-9+.-]*[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi],
  ['assignment', /(api[_-]?key|secret|token|passw(or)?d)\s*[:=]\s*['"]?[^\s'"]{8,}/gi],
];

export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const [kind, re] of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) hits.push({ kind, start: m.index, end: m.index + m[0].length });
  }
  return hits.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function redactSecrets(text: string): string {
  let out = '';
  let at = 0;
  for (const h of scanSecrets(text)) {
    if (h.start < at) {
      at = Math.max(at, h.end); // overlapping hit: extend the redaction already placed
      continue;
    }
    out += text.slice(at, h.start) + '[redacted]';
    at = h.end;
  }
  return out + text.slice(at);
}
