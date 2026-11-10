import { describe, expect, it } from 'vitest';
import { redactSecrets, scanSecrets, SECRET_PATTERNS } from '../../src/core/secrets.js';

// Built at runtime so no secret-shaped literal sits in the repo.
const rep = (c: string, n: number): string => c.repeat(n);
const kinds = (t: string): string[] => scanSecrets(t).map((h) => h.kind);

describe('scanSecrets', () => {
  it('has the eight kinds, all global', () => {
    expect(new Set(SECRET_PATTERNS.map(([k]) => k)).size).toBe(8);
    expect(SECRET_PATTERNS).toHaveLength(10);
    expect(SECRET_PATTERNS.every(([, re]) => re.global)).toBe(true);
  });

  it('private key', () => {
    expect(kinds(['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '))).toEqual(['private key']);
    expect(kinds('-----BEGIN PUBLIC KEY-----')).toEqual([]);
  });

  it('AWS key: 16 chars after AKIA hits, 15 does not', () => {
    expect(kinds(`id ${'AKIA' + rep('A', 16)} end`)).toEqual(['AWS access key']);
    expect(kinds('AKIA' + rep('A', 15))).toEqual([]);
  });

  it('GitHub token: 36 hits, 35 does not; fine-grained too', () => {
    expect(kinds('ghp_' + rep('a', 36))).toEqual(['GitHub token']);
    expect(kinds('ghp_' + rep('a', 35))).toEqual([]);
    expect(kinds('github_pat_' + rep('a', 22))).toEqual(['GitHub token']);
  });

  it('Slack token', () => {
    expect(kinds('xoxb-' + rep('1', 10))).toEqual(['Slack token']);
    expect(kinds('xoxb-' + rep('1', 9))).toEqual([]);
  });

  it('Anthropic or OpenAI key: 20 hits, 19 does not', () => {
    expect(kinds('sk-ant-' + rep('a', 20))).toEqual(['Anthropic or OpenAI key']);
    expect(kinds('sk-ant-' + rep('a', 19))).toEqual([]);
    expect(kinds('sk-' + rep('a', 32))).toEqual(['Anthropic or OpenAI key']);
  });

  it('JWT', () => {
    const p = rep('a', 10);
    expect(kinds(`eyJ${p}.eyJ${p}.${p}`)).toEqual(['JWT']);
    expect(kinds(`eyJ${p}.eyJ${p}`)).toEqual([]);
  });

  it('URL with credentials: needs a password', () => {
    expect(kinds(['https://user', 'pw@host'].join(':'))).toEqual(['URL with credentials']);
    expect(kinds('https://user@host')).toEqual([]);
    for (const pre of ['2', '-', '--', 'x-', '+', '.']) {
      expect(kinds(`${pre}https://u:p@h`), pre).toEqual(['URL with credentials']);
    }
  });

  it('assignment: 8+ chars hits, short does not', () => {
    expect(kinds('token = ' + rep('x', 8))).toEqual(['assignment']);
    expect(kinds('token = short')).toEqual([]);
  });

  it('a 40-hex sha is not a secret', () => {
    expect(scanSecrets('verified_at ' + rep('a1b2', 10))).toEqual([]);
  });

  it('returns hits in text order with offsets', () => {
    const a = 'AKIA' + rep('A', 16);
    const g = 'ghp_' + rep('a', 36);
    const hits = scanSecrets(`${g} ${a}`);
    expect(hits.map((h) => h.kind)).toEqual(['GitHub token', 'AWS access key']);
    expect(hits[0]).toMatchObject({ start: 0, end: g.length });
  });
});

describe('redactSecrets', () => {
  it('keeps surrounding text', () => {
    expect(redactSecrets(`before ${'ghp_' + rep('a', 36)} after`)).toBe('before [redacted] after');
  });
  it('redacts two hits', () => {
    const t = `${'AKIA' + rep('A', 16)} and ${'xoxb-' + rep('1', 10)}`;
    expect(redactSecrets(t)).toBe('[redacted] and [redacted]');
  });
  it('overlapping hits redact once', () => {
    const t = `token=${'ghp_' + rep('a', 36)}`;
    expect(redactSecrets(t)).toBe('[redacted]');
  });
  it('leaves clean text alone', () => {
    expect(redactSecrets('nothing here')).toBe('nothing here');
  });
});
