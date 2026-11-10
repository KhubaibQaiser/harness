import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { defaults } from '../../src/core/config.js';
import { MAX_DECISION_BYTES, parseDecision, serializeDecision } from '../../src/core/decision-file.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { renderRule, ruleRel } from '../../src/core/decision-rule.js';
import { commitDecisions, isLive, outOfSync, planSync, readDecisions } from '../../src/core/decisions.js';
import { readManifest } from '../../src/install/manifest.js';
import { hashText } from '../../src/install/text.js';
import { TODAY, decision, installedRepo, syncNow, writeDecision } from './decisions-helpers.js';

const cfg = defaults().decisions;
const A = '2026-11-03-use-zod';
const B = '2026-11-04-no-default-exports';
const plan = (root: string, today = TODAY) => planSync(root, readDecisions(root, today), cfg, today);
const ruleText = (root: string, id: string) => {
  const rel = `docs/decisions/${id}.md`;
  return renderRule(parseDecision(rel, readFileSync(join(root, rel), 'utf8'), TODAY).decision!, cfg.max_lines).text;
};
const onDisk = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');

test('readDecisions: sorted by name, non-decision files in others, a dangling superseded_by is an error', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(B));
  writeDecision(root, decision(A, { status: 'superseded', superseded_by: '2026-11-05-gone' }));
  writeFileSync(join(root, 'docs/decisions/README.md'), '# ADRs\n');
  const set = readDecisions(root, TODAY);
  expect(set.decisions.map((d) => d.id)).toEqual([B]);
  expect(set.errors).toEqual([`docs/decisions/${A}.md: superseded_by must name a decision in docs/decisions/`]);
  expect(set.others).toEqual(['docs/decisions/README.md']);
});

test('readDecisions: no folder is an empty set', async () => {
  expect(readDecisions(await installedRepo(), TODAY)).toEqual({ decisions: [], errors: [], others: [] });
});

test('isLive: active and confirmed within expiry_days', () => {
  const d = { ...decision(A), rel: `docs/decisions/${A}.md` };
  expect(isLive(d, '2027-02-01', 90)).toBe(true); // 90 days after 2026-11-03
  expect(isLive(d, '2027-02-02', 90)).toBe(false);
  expect(isLive({ ...d, status: 'retired' }, TODAY, 90)).toBe(false);
});

test('add: one create, and after commit one create entry per rule, sorted by rel and none for docs/decisions/', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(B));
  writeDecision(root, decision(A));
  const p = plan(root);
  expect(p.changes).toEqual([
    { kind: 'create', rel: ruleRel(A), content: ruleText(root, A) },
    { kind: 'create', rel: ruleRel(B), content: ruleText(root, B) },
  ]);
  expect({ foreign: p.foreign, wanted: p.wanted, leftOut: p.leftOut, out: outOfSync(p) }).toEqual({ foreign: [], wanted: 2, leftOut: 0, out: true });
  syncNow(root);
  const files = readManifest(root)!.files;
  expect(files.filter((f) => f.rel.startsWith('.claude/rules/harness-decision-'))).toEqual([
    { rel: ruleRel(A), kind: 'create', hash: hashText(ruleText(root, A)) },
    { rel: ruleRel(B), kind: 'create', hash: hashText(ruleText(root, B)) },
  ]);
  expect(files.some((f) => f.rel.startsWith('docs/decisions/'))).toBe(false);
  expect(onDisk(root, ruleRel(A))).toBe(ruleText(root, A));
  expect(outOfSync(plan(root))).toBe(false);
});

test('change: one rewrite update, and the entry is rehashed', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  syncNow(root);
  const before = onDisk(root, ruleRel(A));
  writeDecision(root, decision(A, { title: 'Changed title' }));
  expect(plan(root).changes).toEqual([{ kind: 'update', rel: ruleRel(A), before, after: ruleText(root, A), blocks: [], rewrite: true }]);
  syncNow(root);
  expect(readManifest(root)!.files.find((f) => f.rel === ruleRel(A))).toEqual({ rel: ruleRel(A), kind: 'create', hash: hashText(ruleText(root, A)) });
});

test.each([
  ['retire', (root: string) => writeDecision(root, decision(A, { status: 'retired' })), TODAY],
  ['expire', () => {}, '2027-03-01'],
  ['delete the decision file', (root: string) => rmSync(join(root, `docs/decisions/${A}.md`)), TODAY],
])('%s: one delete, and the entry goes', async (_n, act, today) => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  syncNow(root);
  const before = onDisk(root, ruleRel(A));
  act(root);
  const p = plan(root, today);
  expect(p.changes).toEqual([{ kind: 'delete', rel: ruleRel(A), before }]);
  syncNow(root, today);
  expect(existsSync(join(root, ruleRel(A)))).toBe(false);
  expect(readManifest(root)!.files.some((f) => f.rel === ruleRel(A))).toBe(false);
});

test('supersede: the old rule is deleted and the new one created', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  syncNow(root);
  const before = onDisk(root, ruleRel(A));
  writeDecision(root, decision(A, { status: 'superseded', superseded_by: B }));
  writeDecision(root, decision(B));
  const p = plan(root);
  expect(p.changes).toEqual([
    { kind: 'create', rel: ruleRel(B), content: ruleText(root, B) },
    { kind: 'delete', rel: ruleRel(A), before },
  ]);
  expect(p.leftOut).toBe(1);
});

test('a foreign harness-decision-*.md stops the commit with the §4.3 line and nothing is written', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  mkdirSync(join(root, '.claude/rules'), { recursive: true });
  writeFileSync(join(root, '.claude/rules/harness-decision-x.md'), 'mine\n');
  const manifest = onDisk(root, '.harness/manifest.json');
  const p = plan(root);
  expect(p.foreign).toEqual(['.claude/rules/harness-decision-x.md']);
  const dec = { kind: 'create' as const, rel: 'docs/decisions/2026-11-05-new.md', content: 'x\n' };
  expect(() => commitDecisions(root, [dec], p, { now: () => new Date() })).toThrow("harness remember: .claude/rules/harness-decision-x.md is not harness's; rename it");
  expect(existsSync(join(root, ruleRel(A)))).toBe(false);
  expect(existsSync(join(root, dec.rel))).toBe(false);
  expect(onDisk(root, '.harness/manifest.json')).toBe(manifest);
});

test('Review focus 4: a manifest missing one rule entry gets exactly that entry back', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  writeDecision(root, decision(B));
  syncNow(root);
  const full = readManifest(root)!;
  // The other side of the conflict: its manifest never saw A's rule, but A's decision and rule merged in cleanly.
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ ...full, files: full.files.filter((f) => f.rel !== ruleRel(A)) }, null, 2) + '\n');
  const p = plan(root);
  expect({ changes: p.changes, foreign: p.foreign, adopt: p.adopt }).toEqual({ changes: [], foreign: [], adopt: [ruleRel(A)] });
  syncNow(root);
  expect(readManifest(root)!.files).toEqual(full.files);
});

test('a manifest entry whose rule file is gone and unwanted is dropped', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  syncNow(root);
  rmSync(join(root, `docs/decisions/${A}.md`));
  rmSync(join(root, ruleRel(A)));
  const p = plan(root);
  expect(p.changes).toEqual([]);
  syncNow(root);
  expect(readManifest(root)!.files.some((f) => f.rel === ruleRel(A))).toBe(false);
});

test('.claude/settings.json is byte-identical after a sync', async () => {
  const root = await installedRepo();
  const settings = onDisk(root, '.claude/settings.json');
  writeDecision(root, decision(A));
  syncNow(root);
  expect(onDisk(root, '.claude/settings.json')).toBe(settings);
});

test('decision changes are written in the same transaction and never enter the manifest', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  const text = readFileSync(join(root, `docs/decisions/${A}.md`), 'utf8');
  rmSync(join(root, `docs/decisions/${A}.md`));
  const set = { decisions: [parseDecision(`docs/decisions/${A}.md`, text, TODAY).decision!], errors: [], others: [] };
  commitDecisions(root, [{ kind: 'create', rel: `docs/decisions/${A}.md`, content: text }], planSync(root, set, cfg, TODAY), { now: () => new Date() });
  expect(onDisk(root, `docs/decisions/${A}.md`)).toBe(text);
  expect(onDisk(root, ruleRel(A))).toBe(ruleText(root, A));
  expect(readManifest(root)!.files.some((f) => f.rel.startsWith('docs/'))).toBe(false);
});

const backups = (root: string) => (existsSync(join(root, '.harness/backup')) ? readdirSync(join(root, '.harness/backup')) : []);
const rels = (root: string) => readManifest(root)!.files.map((f) => f.rel);

test('Important 1: a conflict that keeps the other side\'s manifest gets the edited rule\'s hash back, and uninstall then removes it', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  syncNow(root);
  writeDecision(root, decision(B));
  syncNow(root);
  const ySide = onDisk(root, '.harness/manifest.json'); // branch Y: added B, A as it was
  writeDecision(root, decision(A, { title: 'Edited on X' }));
  syncNow(root); // branch X: edited A, which rehashed its rule
  writeFileSync(join(root, '.harness/manifest.json'), ySide);
  const p = plan(root);
  expect({ changes: p.changes, rehash: p.rehash, out: outOfSync(p) }).toEqual({ changes: [], rehash: [ruleRel(A)], out: false });
  syncNow(root);
  expect(readManifest(root)!.files.find((f) => f.rel === ruleRel(A))!.hash).toBe(hashText(onDisk(root, ruleRel(A))));
  let out = '';
  expect(await uninstall(['--yes'], { env: {}, root, out: (s) => (out += s + '\n'), prompt: { async confirm() { return false; }, async edit(_l, v) { return v; } } })).toBe(0);
  expect(out).not.toContain('because you edited them');
  expect(existsSync(join(root, '.claude'))).toBe(false);
});

test('Important 2: an empty sync after init leaves the manifest byte-identical and makes no backup', async () => {
  const root = await installedRepo();
  const manifest = onDisk(root, '.harness/manifest.json');
  const before = backups(root);
  syncNow(root);
  expect(onDisk(root, '.harness/manifest.json')).toBe(manifest);
  expect(backups(root)).toEqual(before);
});

test('Important 2: only the rule entries are sorted, as one block; every other entry keeps its place', async () => {
  const root = await installedRepo();
  const others = rels(root);
  writeDecision(root, decision(B));
  syncNow(root);
  writeDecision(root, decision(A));
  syncNow(root);
  expect(rels(root)).toEqual([...others, ruleRel(A), ruleRel(B)]);
  // A non-rule entry written after the rules (as update or add appends) stays after them.
  const m = readManifest(root)!;
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ ...m, files: [...m.files, { rel: 'zz.txt', kind: 'create', hash: 'h' }] }, null, 2) + '\n');
  writeDecision(root, decision('2026-11-01-first'));
  syncNow(root);
  expect(rels(root)).toEqual([...others, ruleRel('2026-11-01-first'), ruleRel(A), ruleRel(B), 'zz.txt']);
});

test('Important 3: a file one byte over the cap gets the size error; a big non-decision file is in others', async () => {
  const root = await installedRepo();
  const text = serializeDecision(decision(A));
  writeDecision(root, decision(A));
  writeFileSync(join(root, `docs/decisions/${A}.md`), text + 'x'.repeat(MAX_DECISION_BYTES + 1 - Buffer.byteLength(text)));
  writeFileSync(join(root, 'docs/decisions/README.md'), '# ADRs\n' + 'y'.repeat(MAX_DECISION_BYTES));
  const set = readDecisions(root, TODAY);
  expect(set.errors).toEqual([`docs/decisions/${A}.md: file must be at most ${MAX_DECISION_BYTES} bytes`]);
  expect(set.others).toEqual(['docs/decisions/README.md']);
});

