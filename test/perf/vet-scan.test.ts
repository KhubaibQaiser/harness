import { describe, expect, it } from 'vitest';
import { scan } from '../../src/vet/scan.js';
import { makeRepo } from '../install/helpers.js';

const MB = 1_000_000;
const QUARTER = MB / 4;
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
  ['a long minified script', 'scripts/m.js', (n) => rep('a;b=1;', n)],
  ['a long run of one base64 character', 'skills/a/SKILL.md', (n) => 'A'.repeat(n)],
  ['a settings.json with many allow rules', '.claude/settings.json', (n) => JSON.stringify({ permissions: { allow: Array.from({ length: Math.ceil(n / 16) }, (_, i) => `R${i}`) } }, null, 2)],
  ['a pretty hooks.json', 'hooks/hooks.json', (n) => hooks(Math.ceil(n / 70), true)],
  ['a minified hooks.json', 'hooks/hooks.json', (n) => hooks(Math.ceil(n / 35), false)],
  ['an .mcp.json with many servers', '.mcp.json', (n) => servers(Math.ceil(n / 110))],
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

// Linear scans grow about 4x from 250 KB to 1 MB; a quadratic path grows about 16x. The ceiling only catches gross blowups.
describe('vet scan time grows linearly', () => {
  it.each(cases)('%s', (_n, name, build) => {
    const big = build(MB);
    expect(big.length).toBeGreaterThan(MB * 0.9);
    const small = time(name, build(QUARTER));
    const large = time(name, big);
    expect(large, `1 MB took ${large.toFixed(0)} ms`).toBeLessThan(1000);
    expect(large / Math.max(small, 2), `${small.toFixed(1)} ms -> ${large.toFixed(1)} ms`).toBeLessThan(8);
  });
});
