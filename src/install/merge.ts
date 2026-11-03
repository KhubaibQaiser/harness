import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseModule } from 'magicast';
import type { SandboxMode } from '../core/config.js';
import { eolOf, jsonIndentOf, quoteOf, requote, withEol } from './text.js';

export class MergeError extends Error {
  constructor(message: string) { super(message); this.name = 'MergeError'; }
}

// Package-local only: source/tests live in <pkg>/src/install, the bundle in <pkg>/dist. Never probes outside the package.
const modulePath = fileURLToPath(import.meta.url);
const templatesDir = fileURLToPath(new URL(/[\\/]src[\\/]install[\\/]merge\.[jt]s$/.test(modulePath) ? '../../templates/' : '../templates/', import.meta.url));
const template = (name: string): string => {
  const p = join(templatesDir, name);
  if (!existsSync(p)) throw new MergeError(`template ${name} not found at ${p}`);
  return readFileSync(p, 'utf8');
};

/**
 * Removes each text block from `after`: the last occurrence that starts at a line boundary, else the
 * last occurrence (init appends, so the last one is ours even if earlier user text contains it). For every
 * text merge except the AGENTS.md marker replace, this returns the pre-merge content byte for byte.
 * Settings blocks are structural JSON and are not removed this way.
 */
export function removeBlocks(after: string, blocks: string[]): string {
  let out = after;
  for (const block of blocks) {
    // The checkout may have other line endings than the install that recorded the block (core.autocrlf).
    const b = [block, block.replace(/\r?\n/g, '\r\n'), block.replace(/\r\n/g, '\n')].find((x) => out.includes(x)) ?? block;
    const last = out.lastIndexOf(b);
    let i = last;
    while (i > 0 && out[i - 1] !== '\n') i = out.lastIndexOf(b, i - 1);
    if (i === -1) i = last; // no occurrence at a line start: fall back to the last one
    if (i !== -1) out = out.slice(0, i) + out.slice(i + b.length);
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const SETTINGS = '.claude/settings.json';
const bad = (msg: string): never => { throw new MergeError(`${SETTINGS}: ${msg}`); };

/** A harness hook runs the repo's dispatcher: `command`, or any string in `args`, names it. */
export const isHarnessHook = (h: unknown): boolean =>
  isObj(h) && [h.command, ...(Array.isArray(h.args) ? h.args : [])].some((x) => typeof x === 'string' && x.includes('.harness/hooks/dispatch.mjs'));

const parse = (b: string): unknown => { try { return JSON.parse(b); } catch { return null; } };

// The `always` keys. `failIfUnavailable` is never committed: it belongs to the unattended launch's --settings only.
const SANDBOX = { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false };

/**
 * Deletes each recorded `{"set":[...path],"value":v}` key of `s` whose value still deep-equals v, deepest path first, so a
 * created parent (`value: {}`) goes only once it is empty. Returns those blocks, and the dotted paths of changed values kept.
 */
export function removeSets(s: unknown, blocks: string[]): { sets: string[]; changed: string[] } {
  const sets = blocks.map((b) => [b, parse(b)] as [string, any]).filter(([, p]) => isObj(p) && Array.isArray(p.set) && p.set.length).sort((a, b) => b[1].set.length - a[1].set.length);
  const changed: string[] = [];
  for (const [, { set, value }] of sets) {
    const parent = set.slice(0, -1).reduce((o: unknown, k: string) => (isObj(o) ? o[k] : undefined), s);
    const k = set.at(-1);
    if (!isObj(parent) || !Object.hasOwn(parent, k)) continue;
    if (isDeepStrictEqual(parent[k], value)) delete parent[k];
    else if (!isObj(value)) changed.push(set.join('.')); // a parent the person added keys to is theirs now: no note
  }
  return { sets: sets.map(([b]) => b), changed };
}

/**
 * `blocks` for settings are structural, not text (JSON re-serialization changes the bytes):
 * one JSON.stringify string per inserted hook group, `{"event":"Stop","group":{...}}`,
 * and one per inserted deny rule, `{"deny":"Read(./secrets/**)"}`. Uninstall removes them by deep equality.
 * A harness group equal to a `recorded` block but not to the fragment is replaced at its index; its old block is `dropped`.
 */
export function mergeSettings(before: string | null, opts: { sandbox: SandboxMode; recorded?: string[] }): { after: string; blocks: string[]; dropped: string[]; notes: string[] } {
  let s: any;
  try { s = before === null ? {} : JSON.parse(before); } catch (e) { return bad(`is not valid JSON: ${(e as Error).message}`); }
  if (!isObj(s)) bad('must be a JSON object');
  if (s.hooks !== undefined && !isObj(s.hooks)) bad('"hooks" must be an object');
  if (s.permissions !== undefined && !isObj(s.permissions)) bad('"permissions" must be an object');
  if (s.permissions?.deny !== undefined && !Array.isArray(s.permissions.deny)) bad('"permissions.deny" must be an array');

  const frag = JSON.parse(template('settings.fragment.json'));
  const blocks: string[] = [];
  const dropped: string[] = [];
  const notes: string[] = [];
  s.hooks ??= {};
  // The fragment has one group per event.
  for (const [ev, [want]] of Object.entries<any[]>(frag.hooks)) {
    if (s.hooks[ev] !== undefined && !Array.isArray(s.hooks[ev])) {
      notes.push(`${SETTINGS}: hooks.${ev} is not an array; left untouched and the harness ${ev} hook was not added.`);
      continue;
    }
    const list: any[] = (s.hooks[ev] ??= []);
    let ours = false;
    list.forEach((g, i) => {
      if (!isObj(g) || !Array.isArray(g.hooks)) return void notes.push(`${SETTINGS}: hooks.${ev}[${i}] is not a group with a "hooks" array; left untouched.`);
      g.hooks.forEach((h: unknown, j: number) => {
        if (!isObj(h) || typeof h.command !== 'string') notes.push(`${SETTINGS}: hooks.${ev}[${i}].hooks[${j}] is not a command hook; left untouched.`);
      });
      if (!g.hooks.some(isHarnessHook)) return;
      ours = true;
      if (isDeepStrictEqual(g, want)) return;
      const rec = opts.recorded?.find((b) => isDeepStrictEqual(parse(b), { event: ev, group: g }));
      if (rec === undefined) return void notes.push(`${SETTINGS}: hooks.${ev}[${i}] is a harness hook you edited; left as is. harness doctor checks it.`);
      list[i] = want;
      dropped.push(rec);
      blocks.push(JSON.stringify({ event: ev, group: want }));
    });
    if (ours) continue;
    list.push(want);
    blocks.push(JSON.stringify({ event: ev, group: want }));
  }
  s.permissions ??= {};
  s.permissions.deny ??= [];
  for (const d of frag.permissions.deny as string[]) {
    if (s.permissions.deny.includes(d)) continue;
    s.permissions.deny.push(d);
    blocks.push(JSON.stringify({ deny: d }));
  }
  if (opts.sandbox === 'always') {
    if (s.sandbox !== undefined && !isObj(s.sandbox)) bad('"sandbox" must be an object');
    if (s.sandbox === undefined) {
      s.sandbox = {};
      blocks.push(JSON.stringify({ set: ['sandbox'], value: {} }));
    }
    for (const [k, v] of Object.entries(SANDBOX)) {
      if (!Object.hasOwn(s.sandbox, k)) {
        s.sandbox[k] = v;
        blocks.push(JSON.stringify({ set: ['sandbox', k], value: v }));
      } else if (!isDeepStrictEqual(s.sandbox[k], v)) notes.push(`${SETTINGS}: sandbox.${k} is already ${JSON.stringify(s.sandbox[k])}; left as is (harness would set ${JSON.stringify(v)}).`);
    }
  } else {
    const r = removeSets(s, opts.recorded ?? []);
    dropped.push(...r.sets);
    for (const p of r.changed) notes.push(`${SETTINGS}: ${p} was changed; left as is.`);
  }
  const eol = before === null ? '\n' : eolOf(before);
  const tail = before === null || /\n$/.test(before) ? eol : '';
  return { after: withEol(JSON.stringify(s, null, before === null ? 2 : jsonIndentOf(before)), eol) + tail, blocks, dropped, notes };
}

/** Separator to put before an appended block: nothing for an empty file, else finish the last line and add a blank one. */
const sep = (before: string, eol: string) => (before === '' ? '' : (before.endsWith('\n') ? '' : eol) + eol);

const START = '<!-- harness:start -->';
const END = '<!-- harness:end -->';
export function mergeAgents(before: string | null): { after: string; blocks: string[] } {
  const eol = before === null ? '\n' : eolOf(before);
  const block = withEol(template('agents-block.md').trimEnd(), eol);
  if (before === null) return { after: block + eol, blocks: [block + eol] };
  const count = (m: string) => before.split(m).length - 1;
  if (count(START) > 1 || count(END) > 1) throw new MergeError('AGENTS.md has a repeated harness marker; fix it by hand');
  const s = before.indexOf(START), e = before.indexOf(END);
  if (s === -1 && e === -1) {
    const added = sep(before, eol) + block + eol; // separator is part of the block so removal is exact
    return { after: before + added, blocks: [added] };
  }
  if (s === -1 || e === -1 || e < s) throw new MergeError('AGENTS.md has a missing or misordered harness marker; fix it by hand');
  // Marker replace: removing the block gives back the text outside the markers only; the user's
  // original text between the markers was overwritten and cannot be restored.
  return { after: before.slice(0, s) + block + before.slice(e + END.length), blocks: [block] };
}

/** Returns null when there is nothing to import (AGENTS.md absent, or the import is already there). */
export function mergeClaudeMd(before: string | null, agentsExists: boolean): { after: string; blocks: string[] } | null {
  if (!agentsExists) return null;
  if (before === null) return { after: '@AGENTS.md\n', blocks: ['@AGENTS.md\n'] };
  if (/(^|\s)@AGENTS\.md(\s|$)/.test(before)) return null;
  const eol = eolOf(before);
  const block = (before === '' ? '' : (before.endsWith('\n') ? '' : eol) + eol) + `@AGENTS.md${eol}`;
  return { after: before + block, blocks: [block] };
}

function appendLines(before: string | null, lines: string[]): { after: string; blocks: string[] } {
  const text = before ?? '';
  const eol = eolOf(text);
  const have = new Set(text.split(/\r?\n/));
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return { after: text, blocks: [] };
  const block = (text === '' || text.endsWith('\n') ? '' : eol) + add.map((l) => l + eol).join('');
  return { after: text + block, blocks: [block] };
}

export const mergeGitignore = (before: string | null) => appendLines(before, ['.harness/state/', '.harness/logs/', '.harness/backup/', '.harness/results/']);
export const mergeIgnoreFile = (before: string | null, entry: '.harness/') => appendLines(before, [entry]);

/**
 * Adds '.harness/' to the flat config's global ignores: an object whose only key is `ignores`, or `globalIgnores([...])`. With none, a new
 * `{ ignores: ['.harness/'] }` entry is appended to the exported array. Null when the config is not a plain array
 * (or the edit would not round-trip). Inserted text uses the file's quote style and layout, so formatters stay clean.
 */
export function mergeEslintFlatIgnores(before: string): { after: string; blocks: string[] } | null {
  try {
    const lf = before.replace(/\r\n/g, '\n'); // the parser's offsets are in LF text
    const body: any[] = (parseModule(lf).$ast as any).body;
    const def = body.find((n) => n.type === 'ExportDefaultDeclaration');
    if (!def) return null;
    let root = def.declaration;
    if (root.type === 'CallExpression') root = root.arguments.length === 1 ? root.arguments[0] : null; // defineConfig([...])
    if (root?.type === 'Identifier') {
      for (const n of body) {
        const decl = n.type === 'ExportNamedDeclaration' ? n.declaration : n;
        const v = decl?.type === 'VariableDeclaration' && decl.declarations.find((d: any) => d.id.name === root.name);
        if (v) { root = v.init; break; }
      }
    }
    if (root?.type !== 'ArrayExpression') return null;
    const q = quoteOf(lf);
    const entry = requote("'.harness/'", q);
    const keyName = (p: any) => (p.type === 'ObjectProperty' && !p.computed ? (p.key?.name ?? p.key?.value) : null);
    // A global-ignores entry: { ignores: [...] } alone, or ESLint's globalIgnores([...]) helper.
    const isHelper = (e: any) => e?.type === 'CallExpression' && e.callee?.name === 'globalIgnores';
    const global = root.elements.find((e: any) => (e?.type === 'ObjectExpression' && e.properties.length === 1 && keyName(e.properties[0]) === 'ignores') || isHelper(e));
    let at: number;
    let text: string;
    if (global) {
      const arr = isHelper(global) ? global.arguments[0] : global.properties[0].value;
      if (arr?.type !== 'ArrayExpression') return null;
      if (arr.elements.some((el: any) => el?.type === 'StringLiteral' && /^\.harness\/?$/.test(el.value))) return { after: before, blocks: [] };
      const last = arr.elements[arr.elements.length - 1];
      [at, text] = last ? [last.end, `, ${entry}`] : [arr.start + 1, entry];
    } else {
      const obj = `{ ignores: [${entry}] }`;
      const last = root.elements[root.elements.length - 1];
      if (!last) [at, text] = [root.start + 1, obj];
      else if (!lf.slice(root.start, last.start).includes('\n')) [at, text] = [last.end, `, ${obj}`];
      else {
        const lineStart = lf.lastIndexOf('\n', last.start) + 1;
        [at, text] = [last.end, `,\n${/^[ \t]*/.exec(lf.slice(lineStart))![0]}${obj}`];
      }
    }
    const eol = eolOf(before);
    const crlfAt = eol === '\r\n' ? at + lf.slice(0, at).split('\n').length - 1 : at;
    const block = withEol(text, eol);
    const after = before.slice(0, crlfAt) + block + before.slice(crlfAt);
    if (removeBlocks(after, [block]) !== before) return null;
    parseModule(after.replace(/\r\n/g, '\n'));
    return { after, blocks: [block] };
  } catch {
    return null;
  }
}
