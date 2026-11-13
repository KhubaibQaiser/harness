import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { mergeManifestFiles, readManifest, renameRecorded, rehashManifest, type Manifest } from '../../src/install/manifest.js';
import { applyChanges } from '../../src/install/apply.js';
import { changedFiles, readRepoSnapshot, snapshotHarnessFiles } from '../../src/core/harness-files.js';
import { hashText } from '../../src/install/text.js';
import { makeRepo } from './helpers.js';
import { mergeMcp, mergeSettings, pinnedPlugins } from '../../src/install/merge.js';
import type { Change } from '../../src/install/apply.js';

const F = '.harness/state/test-results/root.json', T = '.harness/results/root.json';

test('renameRecorded rewrites a block that holds the old path', () => {
  const r = renameRecorded({ rel: 'package.json', kind: 'update', hash: 'h', blocks: [` --outputFile=${F}`, ' other'] }, F, T);
  expect(r).toEqual({ found: true, entry: { rel: 'package.json', kind: 'update', hash: 'h', blocks: [` --outputFile=${T}`, ' other'] } });
});

test("renameRecorded rewrites a hunk's from and leaves its to", () => {
  const r = renameRecorded({ rel: 'v.ts', kind: 'update', hash: 'h', replace: [{ from: `json: '${F}'\n`, to: `x '${F}'\n` }], formatted: true }, F, T);
  expect(r.found).toBe(true);
  expect(r.entry.replace).toEqual([{ from: `json: '${T}'\n`, to: `x '${F}'\n` }]);
});

test('renameRecorded leaves an entry without the old path unchanged', () => {
  const e = { rel: 'v.ts', kind: 'update' as const, hash: 'h', blocks: ['a'], replace: [{ from: 'b', to: 'c' }] };
  expect(renameRecorded(e, F, T)).toEqual({ found: false, entry: e });
});

const man = (files: Manifest['files']): Manifest => ({ version: '1', createdAt: 't', files });

test('mergeManifestFiles drops deleted entries and copies item from the change', () => {
  const old = man([{ rel: 'a.md', kind: 'create', hash: 'h', item: 'a' }, { rel: 'b.md', kind: 'create', hash: 'h' }, { rel: 'c.md', kind: 'create', hash: 'h' }]);
  const changes: Change[] = [{ kind: 'delete', rel: 'a.md', before: 'x' }, { kind: 'update', rel: 'b.md', before: 'x', after: 'y', blocks: [], item: 'b' }, { kind: 'create', rel: 'd.md', content: 'z', item: 'd' }];
  const files = mergeManifestFiles(old, changes);
  expect(files.map((f) => [f.rel, f.item])).toEqual([['b.md', 'b'], ['c.md', undefined], ['d.md', 'd']]);
});

const plugin = (id: string) => ({ id, kind: 'plugin', source: { type: 'github', repo: `o/${id}`, plugin: id, sha: 'a'.repeat(40) } }) as any;

test('replaced marketplace blocks do not accumulate across three updates', () => {
  let text: string | null = null;
  let entry: Manifest['files'][number] = { rel: '.claude/settings.json', kind: 'create', hash: 'h' };
  const markets = new Set<string>();
  for (const plugins of [[plugin('p1')], [plugin('p1'), plugin('p2')], [plugin('p2'), plugin('p3')]]) {
    const r = mergeSettings(text, { sandbox: 'off', recorded: entry.blocks, plugins: pinnedPlugins(plugins) });
    markets.add(r.market);
    const c: Change = text === null ? { kind: 'create', rel: entry.rel, content: r.after, blocks: r.blocks } : { kind: 'update', rel: entry.rel, before: text, after: r.after, blocks: r.blocks, dropped: r.dropped };
    entry = mergeManifestFiles(man([entry]), [c])[0];
    text = r.after;
  }
  expect(entry.blocks!.filter((b) => JSON.parse(b).marketplace)).toHaveLength(1);
  expect(entry.blocks!.filter((b) => JSON.parse(b).plugin).map((b) => JSON.parse(b).plugin).sort()).toEqual([...markets].flatMap((m) => [`p2@${m}`, `p3@${m}`]));
  expect(markets.size).toBe(1); // the recorded name is kept on every update
});

test('mcp blocks are kept as structural blocks', () => {
  const first = mergeMcp(null, [{ name: 's', item: 'i', config: { command: 'x' } }]);
  const old = man([{ rel: '.mcp.json', kind: 'create', hash: 'h', blocks: first.blocks }]);
  // an unrelated update of the file: the blocks are JSON, not text, and must survive
  const files = mergeManifestFiles(old, [{ kind: 'update', rel: '.mcp.json', before: first.after, after: first.after.replace('"x"', '"y"'), blocks: [] }]);
  expect(files[0].blocks).toEqual(first.blocks);
  const gone = mergeMcp(first.after, [], first.blocks);
  const files2 = mergeManifestFiles(old, [{ kind: 'update', rel: '.mcp.json', before: first.after, after: gone.after, blocks: gone.blocks, dropped: gone.dropped }]);
  expect(files2[0].blocks).toBeUndefined();
});

const SET = '.claude/settings.json';
const withSettings = () => {
  const root = makeRepo({});
  applyChanges(root, [{ kind: 'create', rel: SET, content: '{"a":1}\n' }], '1');
  return root;
};

test('rehashManifest updates the settings hash when install changed the bytes, and is a no-op otherwise', () => {
  const root = withSettings();
  const mp = join(root, '.harness/manifest.json');
  const before = readFileSync(mp, 'utf8');
  rehashManifest(root, [SET]);
  expect(readFileSync(mp, 'utf8')).toBe(before);
  writeFileSync(join(root, SET), '{"a":1,"enabledPlugins":{}}\n');
  rehashManifest(root, [SET]);
  expect(readManifest(root)!.files.find((f) => f.rel === SET)!.hash).toBe(hashText('{"a":1,"enabledPlugins":{}}\n'));
});

test('rehashManifest stamps the harness files', () => {
  const root = withSettings();
  writeFileSync(join(root, SET), '{"a":2}\n');
  rehashManifest(root, [SET]);
  expect(changedFiles(readRepoSnapshot(root).cli!.files, snapshotHarnessFiles(root))).toEqual([]);
});

test('state paths: a global dir is read by backupText; the repo default refuses it', async () => {
  const { backupText, statePaths, REPO_STATE } = await import('../../src/install/manifest.js');
  const root = makeRepo({ '.claude/harness/backup/x/f': 'old\n' });
  const rel = '.claude/harness/backup/x/f';
  expect(backupText(root, rel, statePaths('.claude/harness'))).toBe('old\n');
  expect(backupText(root, rel, REPO_STATE)).toBeNull();
  expect(statePaths()).toEqual({ dir: '.harness', manifest: '.harness/manifest.json', backup: '.harness/backup', lock: '.harness/apply.lock' });
});

test('state paths: no .harness/backup literal outside the statePaths default', () => {
  for (const f of ['apply', 'manifest', 'finish'])
    expect(readFileSync(join(__dirname, `../../src/install/${f}.ts`), 'utf8').split('\n').filter((l) => /'\.harness\/backup/.test(l) && !l.includes('statePaths'))).toEqual([]);
});

test('LOCK_REL equals the default state lock', async () => {
  const { REPO_STATE } = await import('../../src/install/manifest.js');
  expect((await import('../../src/install/apply.js')).LOCK_REL).toBe(REPO_STATE.lock);
});
