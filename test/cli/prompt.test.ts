import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readlinePrompt } from '../../src/cli/prompt.js';

describe('readlinePrompt on a closed input', () => {
  it('a closed input at an edit prompt rejects instead of hanging', async () => {
    const input = new PassThrough();
    const prompt = readlinePrompt(input, new PassThrough());
    const answer = prompt.edit('Name', 'x');
    input.end();
    await expect(answer).rejects.toThrow('input closed');
  });

  it('an answered edit prompt still returns the answer, and Enter keeps the value', async () => {
    const input = new PassThrough();
    const prompt = readlinePrompt(input, new PassThrough());
    const a = prompt.edit('Name', 'x');
    input.write('y\n');
    expect(await a).toBe('y');
    const b = prompt.edit('Name', 'x');
    input.write('\n');
    expect(await b).toBe('x');
    prompt.close();
  });
});
