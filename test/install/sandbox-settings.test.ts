// Owner ruling 2026-11-13: Claude Code's sandbox is harness's primary defense. init/update/sync write
// sandbox.filesystem.denyWrite for every protected harness path (derived from protect's table), with the same
// record / replace / uninstall rules as the other harness settings blocks.
import { expect, test } from 'vitest';
import { DENY_WRITE_SKIPPED, denyWritePaths, PROTECTED } from '../../src/checks/protect.js';
import { mergeSettings, removeFromSettings } from '../../src/install/merge.js';

const FILE = (blocks: string[], kind = 'update') => ({ rel: '.claude/settings.json', kind, hash: 'x', blocks }) as never;
const dw = (after: string) => JSON.parse(after).sandbox?.filesystem?.denyWrite;

test('denyWrite comes from protect\'s table: each protected path, but the work folders, the logs and the test results', () => {
  const paths = denyWritePaths();
  for (const p of ['./.harness/config.yaml', './.harness/hooks', './.harness/state', './.harness/manifest.json', './.claude/settings.json']) expect(paths).toContain(p);
  for (const p of ['./.harness/tmp', './.harness/logs', './.harness/results', './.harness/reviews']) expect(paths).not.toContain(p);
  // Every entry of protect's table is either denied or skipped on purpose: the two can't drift apart.
  for (const glob of PROTECTED) {
    const p = glob.replace(/\/\*\*$/, '');
    expect(paths.includes(`./${p}`) || DENY_WRITE_SKIPPED.some((s) => p === s || p.startsWith(`${s}/`)), glob).toBe(true);
  }
  // A path protect adds later is picked up with no change here; .harness/reviews (#218) is skipped: `harness review` writes it.
  expect(denyWritePaths(['.harness/future/**', '.harness/reviews/**', '.harness/tmp/**', '.harness/logs/**', '.harness/results/**', '.harness/config.yaml'])).toEqual(['./.harness/future', './.harness/config.yaml']);
  expect(PROTECTED).toContain('.harness/reviews/**');
  expect(paths).not.toContain('./.harness/reviews');
});

test('the merge writes denyWrite in every sandbox mode, recorded per path; a re-render is stable', () => {
  for (const sandbox of ['unattended', 'always', 'off'] as const) {
    const m = mergeSettings(null, { sandbox });
    expect(dw(m.after), sandbox).toEqual(denyWritePaths());
    for (const p of denyWritePaths()) expect(m.blocks).toContain(JSON.stringify({ denyWrite: p }));
    const again = mergeSettings(m.after, { sandbox, recorded: m.blocks });
    expect(again.after).toBe(m.after);
    expect(again.blocks).toEqual([]);
  }
});

test('uninstall removes harness\'s denyWrite paths and the containers it made; a person\'s own path stays', () => {
  const before = JSON.stringify({ model: 'x' }, null, 2) + '\n';
  const m = mergeSettings(before, { sandbox: 'unattended' });
  expect(removeFromSettings(m.after, FILE(m.blocks), before, [])!.after).toBe(before);
  const own = JSON.stringify({ sandbox: { filesystem: { denyWrite: ['./secrets'] } } }, null, 2) + '\n';
  const m2 = mergeSettings(own, { sandbox: 'unattended' });
  expect(dw(m2.after)).toEqual(['./secrets', ...denyWritePaths()]);
  expect(dw(removeFromSettings(m2.after, FILE(m2.blocks), own, [])!.after)).toEqual(['./secrets']);
});

test('a hand edit is kept and noted; a removed harness path comes back on the next render', () => {
  const odd = JSON.stringify({ sandbox: { filesystem: { denyWrite: 'nope' } } });
  const r = mergeSettings(odd, { sandbox: 'unattended' });
  expect(JSON.parse(r.after).sandbox.filesystem.denyWrite).toBe('nope');
  expect(r.notes.join('\n')).toMatch(/sandbox\.filesystem\.denyWrite is not an array; left as is/);
  const m = mergeSettings(null, { sandbox: 'unattended' });
  const s = JSON.parse(m.after);
  s.sandbox.filesystem.denyWrite = s.sandbox.filesystem.denyWrite.filter((p: string) => p !== './.harness/config.yaml');
  const back = mergeSettings(JSON.stringify(s), { sandbox: 'unattended', recorded: m.blocks });
  expect(dw(back.after)).toContain('./.harness/config.yaml');
  // Not silently: the person removed it, so the render says it is back and why.
  expect(back.notes).toContain(".claude/settings.json: harness's sandbox.filesystem.denyWrite path ./.harness/config.yaml was removed by hand and is added back: harness needs it to protect its files.");
  // A first install adds every path without that note.
  expect(m.notes.join('\n')).not.toMatch(/removed by hand/);
});

test('`always` turns the sandbox on for interactive sessions too, failIfUnavailable included, and says how to allow hosts', () => {
  const m = mergeSettings(null, { sandbox: 'always' });
  const sb = JSON.parse(m.after).sandbox;
  expect(sb).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
  expect(m.notes.join('\n')).toMatch(/sandbox\.network\.allowedDomains/);
  expect(mergeSettings(null, { sandbox: 'unattended' }).notes.join('\n')).not.toMatch(/allowedDomains/);
});
