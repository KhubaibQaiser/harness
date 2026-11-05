import { describe, expect, it } from 'vitest';
import { scan } from '../../src/vet/scan.js';
import { makeRepo } from '../install/helpers.js';

const MB = 1_000_000;
const rep = (unit: string) => unit.repeat(Math.ceil(MB / unit.length));
const hooks = (n: number, pretty: boolean) =>
  JSON.stringify({ hooks: { Stop: Array.from({ length: n }, (_, i) => ({ hooks: [{ type: 'command', command: `echo ${i}` }] })) } }, null, pretty ? 2 : 0);
const servers = (n: number) => JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { command: 'npx', args: ['-y', `p${i}@1.0.0`] }])) }, null, 2);

// Each case is a 1 MB file that used to (or could) make a scan path quadratic.
const cases: [string, string, string][] = [
  ...['curl -o x ', 'env ', 'npx ', 'curl u | sudo ', 'sh -c ', 'curl ', 'curl -o x;', 'curl -o x && ', 'printenv a | ', 'a\\\n'].map((u): [string, string, string] => [`1 MB of ${JSON.stringify(u)}`, 'x.sh', rep(u)]),
  ...['a'.repeat(199) + ' ', 'a'.repeat(199) + '+', '0'.repeat(199) + ' ', 'eval ', 'new ', 'nc ', ';   ', 'ignore ', 'ignore' + ' '.repeat(50), 'system ', 'do not ', 'permissionDecision', 'permissionDecision:', 'requests.', 'https', 'a;'].map((u): [string, string, string] => [`1 MB of ${JSON.stringify(u)} in a skill`, 'skills/a/SKILL.md', rep(u)]),
  ['a long minified script', 'scripts/m.js', rep('a;b=1;')],
  ['a long run of one base64 character', 'skills/a/SKILL.md', 'A'.repeat(MB)],
  ['a settings.json with many allow rules', '.claude/settings.json', JSON.stringify({ permissions: { allow: Array.from({ length: 60000 }, (_, i) => `R${i}`) } }, null, 2)],
  ['a pretty hooks.json', 'hooks/hooks.json', hooks(14000, true)],
  ['a minified hooks.json', 'hooks/hooks.json', hooks(28000, false)],
  ['an .mcp.json with many servers', '.mcp.json', servers(9000)],
];

describe('vet scan time', () => {
  it.each(cases)('%s scans in under 200 ms', (_n, name, body) => {
    expect(body.length).toBeGreaterThan(MB * 0.9);
    const dir = makeRepo({ [name]: body }, { git: false });
    const t = performance.now();
    scan({ dir, files: [name], map: { [name]: name }, skipped: [], large: [] }, '');
    expect(performance.now() - t).toBeLessThan(200);
  });
});
