import { expect, test } from 'vitest';
import { mergeManifestFiles, renameRecorded, type Manifest } from '../../src/install/manifest.js';
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
  for (const plugins of [[plugin('p1')], [plugin('p1'), plugin('p2')], [plugin('p2'), plugin('p3')]]) {
    const r = mergeSettings(text, { sandbox: 'off', recorded: entry.blocks, plugins: pinnedPlugins(plugins) });
    const c: Change = text === null ? { kind: 'create', rel: entry.rel, content: r.after, blocks: r.blocks } : { kind: 'update', rel: entry.rel, before: text, after: r.after, blocks: r.blocks, dropped: r.dropped };
    entry = mergeManifestFiles(man([entry]), [c])[0];
    text = r.after;
  }
  expect(entry.blocks!.filter((b) => JSON.parse(b).marketplace)).toHaveLength(1);
  expect(entry.blocks!.filter((b) => JSON.parse(b).plugin).map((b) => JSON.parse(b).plugin).sort()).toEqual(['p2@harness-pins', 'p3@harness-pins']);
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
