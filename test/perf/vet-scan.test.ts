import { describe, expect, it } from 'vitest';
import { scan } from '../../src/vet/scan.js';
import { makeRepo } from '../install/helpers.js';

const MB = 1_000_000;
const QUARTER = MB / 4;
const BIG = 4 * MB; // 16x the small input
const rep = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));
const hooks = (n: number, pretty: boolean) =>
  JSON.stringify({ hooks: { Stop: Array.from({ length: n }, (_, i) => ({ hooks: [{ type: 'command', command: `echo ${i}` }] })) } }, null, pretty ? 2 : 0);
const servers = (n: number) => JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { command: 'npx', args: ['-y', `p${i}@1.0.0`] }])) }, null, 2);

type Case = [string, string, (size: number) => string];
// Each case is a file that used to (or could) make a scan path quadratic, built at a given size.
const cases: Case[] = [
  ...['curl -o x ', 'env ', 'npx ', 'curl u | sudo ', 'sh -c ', 'curl ', 'curl -o x;', 'curl -o x && ', 'printenv a | ', 'a\\\n'].map((u): Case => [`${JSON.stringify(u)}`, 'x.sh', (n) => rep(u, n)]),
  ...['a'.repeat(199) + ' ', 'a'.repeat(199) + '+', '0'.repeat(199) + ' ', 'eval ', 'new ', 'nc ', ';   ', 'ignore ', 'ignore' + ' '.repeat(50), 'system ', 'do not ', 'permissionDecision', 'permissionDecision:', 'requests.', 'https', 'a;'].map((u): Case => [`${JSON.stringify(u)} in a skill`, 'skills/a/SKILL.md', (n) => rep(u, n)]),
  ...['\n', 'a\n', '<!--\n', '\u{E0041}\n'].flatMap((u): Case[] => [[`${JSON.stringify(u)} in a script`, 'x.sh', (n) => rep(u, n)], [`${JSON.stringify(u)} in a skill`, 'skills/a/SKILL.md', (n) => rep(u, n)]]),
  ...['tarball: ' + 'a'.repeat(50), 'resolution: {' + 'a '.repeat(50), '"resolved": "' + ' '.repeat(50)].map((u): Case => [`${JSON.stringify(u.slice(0, 16))} in a lockfile`, 'yarn.lock', (n) => '# yarn lockfile v1\n' + rep(u, n)]),
  ['lockfile data line that fails at its end', 'pnpm-lock.yaml', (n) => 'lockfileVersion: 9\ntarball: ' + 'a'.repeat(n) + '('],
  ...['telemetry ', 'opentelemetry', 'DO_NOT_TRACK ', '@segment', 'OPT_'].map((u): Case => [`${JSON.stringify(u)} in a script`, 'x.sh', (n) => rep(u, n)]),
  ['a long licence file', 'LICENSE', (n) => rep('Permission to use ', n)],
  ['a long skill description', 'skills/a/SKILL.md', (n) => '---\nname: a\ndescription: ' + rep('word ', n) + '\n---\n'],
  ['distinct-key frontmatter in an agent', 'agents/a.md', (n) => '---\n' + Array.from({ length: Math.ceil(n / 9) }, (_, i) => `k${String(i).padStart(5, '0')}: v\n`).join('') + '---\n'],
  ...['[', '{a: '].map((u): Case => [`${JSON.stringify(u)} frontmatter in an agent`, 'agents/a.md', (n) => '---\n' + rep(u, n) + '\n---\n']),
  ['a long minified script', 'scripts/m.js', (n) => rep('a;b=1;', n)],
  ['a long run of one base64 character', 'skills/a/SKILL.md', (n) => 'A'.repeat(n)],
  ['a settings.json with many allow rules', '.claude/settings.json', (n) => JSON.stringify({ permissions: { allow: Array.from({ length: Math.ceil(n / 16) }, (_, i) => `R${i}`) } }, null, 2)],
  ['a pretty hooks.json', 'hooks/hooks.json', (n) => hooks(Math.ceil(n / 70), true)],
  ['a minified hooks.json', 'hooks/hooks.json', (n) => hooks(Math.ceil(n / 35), false)],
  ['an .mcp.json with many servers', '.mcp.json', (n) => servers(Math.ceil(n / 110))],
  ['frontmatter of many indented lines in an agent', 'agents/a.md', (n) => '---\n' + rep(' \t \n', n) + '---\n'],
  ['frontmatter of one long blank line in a skill', 'skills/a/SKILL.md', (n) => '---\n' + ' '.repeat(n) + '\n---\n'],
  ['frontmatter hooks in a skill, then a long body', 'skills/a/SKILL.md', (n) => '---\nname: a\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: x\n---\n' + rep('hooks: x\n', n)],
];

// Median of three scans, after one warm-up.
const time = (name: string, body: string): number => {
  const dir = makeRepo({ [name]: body }, { git: false });
  const run = () => {
    const t = performance.now();
    scan({ dir, files: [name], map: { [name]: name }, skipped: [], large: [] }, '');
    return performance.now() - t;
  };
  run();
  return [run(), run(), run()].sort((a, b) => a - b)[1]!;
};

// 250 KB against 4 MB is 16x the input: a linear scan grows about 16-20x (measured per 4x step: about 3.8-5.8x, newline-heavy
// files highest; macOS CI hit 8.2-9.4x for one 4x step), a quadratic one about 256x. 50 sits well between the two, and the
// ceiling only catches gross blowups.
describe('vet scan time grows linearly', () => {
  it.each(cases)('%s', (_n, name, build) => {
    const big = build(BIG);
    expect(big.length).toBeGreaterThan(BIG * 0.9);
    const small = time(name, build(QUARTER));
    const large = time(name, big);
    expect(large, `4 MB took ${large.toFixed(0)} ms`).toBeLessThan(4000);
    expect(large / Math.max(small, 2), `${small.toFixed(1)} ms -> ${large.toFixed(1)} ms`).toBeLessThan(50);
    // Four 4 MB scans (warm-up plus median of 3) can pass vitest's 5 s default on a slow CI runner; the 4000 ms assert above is the real ceiling.
  }, 60_000);
});

describe('vet scan with many files', () => {
  it('5000 small agents/*.md grows linearly', () => {
    const run = (n: number) => {
      const names = Array.from({ length: n }, (_, i) => `agents/a${i}.md`);
      const dir = makeRepo(Object.fromEntries(names.map((p) => [p, '---\nname: a\ndescription: d\n---\nbody\n'])), { git: false });
      const t = performance.now();
      scan({ dir, files: names, map: Object.fromEntries(names.map((p) => [p, p])), skipped: [], large: [] }, '');
      return performance.now() - t;
    };
    run(100);
    const small = run(1250), large = run(5000);
    expect(large, `5000 files took ${large.toFixed(0)} ms`).toBeLessThan(1000);
    expect(large / Math.max(small, 2), `${small.toFixed(1)} ms -> ${large.toFixed(1)} ms`).toBeLessThan(8);
  });
});
