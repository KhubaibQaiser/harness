import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assistant, attachment, prompt, system, toolResult, writeSession } from '../fixtures/transcripts/make.js';

const FIXTURES = join(import.meta.dirname, '../fixtures/transcripts');
// Real-looking identity: home paths, emails, API keys. Fixtures stay synthetic (spec §10).
const LEAKS = [/\/Users\//, /\/home\//, /C:\\\\?Users/i, /[\w.+-]+@[\w-]+\.[\w.]+/, /\bsk-[\w-]{6,}/];
const leaks = (text: string) => LEAKS.filter((re) => re.test(text)).map(String);
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

describe('transcript fixtures are synthetic', () => {
  it('the leak patterns catch what they should', () => {
    for (const bad of ['/Users/x', '/home/x', 'C:\\Users\\x', 'a.b@c.io', 'sk-ant-abc123']) expect(leaks(bad), bad).not.toEqual([]);
  });
  it.each(walk(FIXTURES))('%s', (file) => expect(leaks(readFileSync(file, 'utf8'))).toEqual([]));
  it('builder defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-'));
    const file = writeSession(dir, 's', [assistant(), prompt('p'), toolResult('t'), attachment('skill_listing', {}), system('compact_boundary')], { subagents: { a: [assistant()] } });
    for (const f of [file, join(dir, 's', 'subagents', 'agent-a.jsonl')]) expect(leaks(readFileSync(f, 'utf8'))).toEqual([]);
  });
});
