// Several harness groups per event (the AskUserQuestion groups): matched by content, then by matcher, never by position.
// Every layout ends with uninstall byte-identical to the file before install.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergeSettings, removeFromSettings } from '../../src/install/merge.js';

const frag = JSON.parse(readFileSync('templates/settings.fragment.json', 'utf8'));
const [MAIN, ASK] = frag.hooks.PreToolUse;
// The 80efdd2 fragment: one PreToolUse and one PostToolUse group, each with `|AskUserQuestion`.
const OLD = { ...frag.hooks, PreToolUse: [{ ...MAIN, matcher: `${MAIN.matcher}|AskUserQuestion` }], PostToolUse: [{ ...frag.hooks.PostToolUse[0], matcher: `${frag.hooks.PostToolUse[0].matcher}|AskUserQuestion` }] };
const DISPATCH = ['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs'];
const own = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
const text = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
const merge = (before: string, recorded: string[]) => mergeSettings(before, { sandbox: 'unattended', recorded });
const pre = (t: string) => JSON.parse(t).hooks.PreToolUse;

/** An install of `hooks` (the old fragment by default) on top of `original`, with its recorded blocks. */
function install(original: object, hooks: Record<string, any[]> = OLD) {
  const s = structuredClone(original) as any;
  const blocks: string[] = [];
  s.hooks ??= {};
  for (const [ev, gs] of Object.entries(hooks)) for (const g of gs) ((s.hooks[ev] ??= []).push(g), blocks.push(JSON.stringify({ event: ev, group: g })));
  s.permissions = { deny: [...frag.permissions.deny] };
  for (const d of frag.permissions.deny) blocks.push(JSON.stringify({ deny: d }));
  return { s, blocks };
}
/** Merge, keep the manifest blocks as mergeManifestFiles does, then uninstall: the result must be `original` exactly. */
function roundTrip(current: object, blocks: string[], original: string) {
  const r = merge(text(current), blocks);
  const kept = [...new Set([...blocks.filter((b) => !r.dropped.includes(b)), ...r.blocks])];
  const notes: string[] = [];
  const u = removeFromSettings(r.after, { rel: '.claude/settings.json', kind: 'update', hash: 'x', blocks: kept } as never, original, notes);
  expect(u?.after).toBe(original);
  const again = merge(r.after, kept);
  expect(again).toMatchObject({ after: r.after, blocks: [], dropped: [] }); // a second update changes nothing
  return { r, notes };
}

describe('mergeEvent by matcher', () => {
  it('repro 1: a dispatcher group of the person\'s own before the recorded old group keeps the main group', () => {
    const task = { matcher: 'Task', hooks: [{ type: 'command', command: 'node', args: DISPATCH }] };
    const original = { hooks: { PreToolUse: [task] } };
    const { s, blocks } = install(original);
    const { r } = roundTrip(s, blocks, text(original));
    expect(pre(r.after)).toEqual([task, MAIN]); // the Task group takes the ask slot; the pause dialog is the fallback
    expect(r.notes).toEqual(['.claude/settings.json: hooks.PreToolUse[0] is a harness hook you edited; left as is. harness doctor checks it.']);
  });

  it('an edited ask group before the recorded old group: the old one becomes main, the edit keeps the ask slot', () => {
    const edited = { ...ASK, hooks: [{ ...ASK.hooks[0], timeout: 30 }] };
    const original = { hooks: { PreToolUse: [edited] } };
    const { s, blocks } = install(original);
    expect(pre(roundTrip(s, blocks, text(original)).r.after)).toEqual([edited, MAIN]);
  });

  it('repro 2: the main group twice and the ask group removed: both copies stay recorded, the ask group is added, uninstall leaves no hook', () => {
    const original = { hooks: { PreToolUse: [own, own] } };
    const { s, blocks } = install(original, frag.hooks);
    s.hooks.PreToolUse = [own, own, MAIN, MAIN];
    const { r } = roundTrip(s, blocks, text(original));
    expect(pre(r.after)).toEqual([own, own, MAIN, MAIN, ASK]);
    expect(r.dropped).toEqual([]);
  });

  it('the old group twice: replaced by main and ask; three times: the third is removed', () => {
    for (const n of [2, 3]) {
      const original = { hooks: { PreToolUse: [own] } };
      const { s, blocks } = install(original);
      s.hooks.PreToolUse.push(...Array.from({ length: n - 1 }, () => OLD.PreToolUse[0]));
      expect(pre(roundTrip(s, blocks, text(original)).r.after)).toEqual([own, MAIN, ASK]);
    }
  });

  it('current groups in reverse order, and with the ask group duplicated, are left alone', () => {
    const original = { model: 'x' };
    for (const layout of [[ASK, MAIN], [MAIN, ASK, ASK], [ASK, ASK, MAIN]]) {
      const { s, blocks } = install(original, frag.hooks);
      s.hooks.PreToolUse = layout;
      const { r } = roundTrip(s, blocks, text(original));
      expect(pre(r.after), JSON.stringify(layout.map((g) => g.matcher))).toEqual(layout);
      expect(r.blocks).toEqual([]);
    }
  });

  it('an upgrade with the old main group edited keeps the edit and adds the ask group', () => {
    const { s, blocks } = install({});
    s.hooks.PreToolUse[0] = { ...s.hooks.PreToolUse[0], hooks: [{ ...s.hooks.PreToolUse[0].hooks[0], timeout: 20 }] };
    const r = merge(text(s), blocks);
    expect(pre(r.after)).toEqual([s.hooks.PreToolUse[0], ASK]);
  });
});
