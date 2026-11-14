import { expect, test } from 'vitest';
import { hostProblem } from '../../src/core/hosts.js';

const MSG = (h: string) => `can't list ${h}: GitHub is reachable only in runs that push (harness-run --push), and example.com must stay unreachable for the container check`;

test('hostProblem refuses GitHub hosts, *, and wildcards covering example.com or GitHub', () => {
  for (const h of ['github.com', 'api.github.com', '*.github.com', 'githubusercontent.com', 'objects.githubusercontent.com', '*', '*.com', 'example.com', '*.example.com', 'GitHub.com']) {
    expect(hostProblem(h), h).toBe(MSG(h));
  }
});

test('hostProblem accepts ordinary hosts', () => {
  for (const h of ['registry.npmjs.org', '*.npmjs.org', 'notgithub.com', 'github.com.evil.org', 'www.example.com']) expect(hostProblem(h), h).toBeNull();
});
