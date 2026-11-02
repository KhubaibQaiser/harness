import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseModule } from 'magicast';
import type { PackageFacts } from './detect.js';
import type { Change } from './apply.js';
import { removeBlocks } from './merge.js';
import { eolOf, withEol } from './text.js';

export type TestConfigResult = { change: Change } | { manual: string[] } | { none: true };

/** `@scope/name` -> `scope__name`; the root package -> `root`; anything outside [A-Za-z0-9._-] -> `_`. */
export function resultFileName(pkg: PackageFacts): string {
  const base = pkg.dir === '.' ? 'root' : (pkg.name ?? pkg.dir).replace(/^@/, '').replace(/\//g, '__');
  return base.replace(/[^A-Za-z0-9._-]/g, '_') + '.json';
}

// Vitest resolves outputFile against config.root (the cwd unless `root` is set); Jest resolves --outputFile against
// process.cwd(). Both run from the package dir, so the path is relative to it.
function resultPath(pkg: PackageFacts, root: string, resultsDir: string): string {
  const rel = relative(join(root, pkg.dir), resolve(root, resultsDir)).split(sep).join('/');
  return `${rel}/${resultFileName(pkg)}`;
}

type Ins = { at: number; text: string; empty?: string };

const unwrap = (n: any): any => (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'ParenthesizedExpression') ? unwrap(n.expression) : n);
const keyOf = (p: any): string | null => (p.type === 'ObjectProperty' && !p.computed ? (p.key.name ?? p.key.value ?? null) : null);
const prop = (o: any, name: string): any => o.properties.find((p: any) => keyOf(p) === name);
const strVal = (n: any): string | null => (n?.type === 'StringLiteral' ? n.value : null);

/** Insert text for a new property into an object literal; keeps the layout (multi-line or inline) of the existing properties. */
function addProp(src: string, eol: string, o: any, text: string): Ins {
  const last = o.properties[o.properties.length - 1];
  if (!last) return { at: o.start + 1, text: ` ${text} `, empty: text };
  const multiline = src.slice(o.start, last.start).includes('\n');
  if (!multiline) return { at: last.end, text: `, ${text}` };
  const lineStart = src.lastIndexOf('\n', last.start) + 1;
  return { at: last.end, text: `,${eol}${/^[ \t]*/.exec(src.slice(lineStart))![0]}${text}` };
}

function addElem(arr: any, text: string): Ins {
  const last = arr.elements[arr.elements.length - 1];
  return last ? { at: last.end, text: `, ${text}` } : { at: arr.start + 1, text };
}

const hasJson = (arr: any) => arr.elements.some((e: any) => strVal(e) === 'json' || (e?.type === 'ArrayExpression' && strVal(e.elements[0]) === 'json'));

const covText = (enable: boolean, reporter = true) => [...(enable ? ['enabled: true'] : []), ...(reporter ? ["reporter: ['text', 'json']"] : [])].join(', ');

function vitestManual(header: string, path: string, enable: boolean): string[] {
  return [header, 'test: {', "  reporters: ['default', 'json'],", `  outputFile: { json: '${path}' },`, `  coverage: { ${covText(enable)} },`, '},'];
}

/** Several inserts at one offset (new properties of one empty object) become one comma-joined insert. */
function mergeInserts(ins: Ins[]): Ins[] {
  const out: Ins[] = [];
  for (const i of ins) {
    const prev = out.find((o) => o.at === i.at);
    if (!prev) out.push({ ...i });
    else if (prev.empty !== undefined && i.empty !== undefined) { prev.empty += `, ${i.empty}`; prev.text = ` ${prev.empty} `; }
    else prev.text += i.text;
  }
  return out;
}

/** Returns the inserts for the `test` object, null when it holds something we cannot edit safely, [] when already set up. */
function editTest(src: string, eol: string, t: any, path: string, enable: boolean): Ins[] | null {
  const ins: Ins[] = [];
  if (prop(t, 'root')) return null; // a custom root changes how outputFile resolves
  const rep = prop(t, 'reporters');
  if (!rep) ins.push(addProp(src, eol, t, "reporters: ['default', 'json']"));
  else if (rep.value.type !== 'ArrayExpression') return null;
  else if (!hasJson(rep.value)) ins.push(addElem(rep.value, "'json'"));

  const out = prop(t, 'outputFile');
  if (!out) ins.push(addProp(src, eol, t, `outputFile: { json: '${path}' }`));
  else if (out.value.type !== 'ObjectExpression') return null;
  else {
    const j = prop(out.value, 'json');
    if (!j) ins.push(addProp(src, eol, out.value, `json: '${path}'`));
    else if (strVal(j.value) !== path) return null;
  }

  const cov = prop(t, 'coverage');
  if (!cov) ins.push(addProp(src, eol, t, `coverage: { ${covText(enable)} }`));
  else if (cov.value.type !== 'ObjectExpression') return null;
  else {
    if (enable && !prop(cov.value, 'enabled')) ins.push(addProp(src, eol, cov.value, 'enabled: true'));
    const r = prop(cov.value, 'reporter');
    if (!r) ins.push(addProp(src, eol, cov.value, "reporter: ['text', 'json']"));
    else if (r.value.type !== 'ArrayExpression') return null;
    else if (!hasJson(r.value)) ins.push(addElem(r.value, "'json'"));
  }
  return ins;
}

function vitestChange(pkg: PackageFacts, root: string, path: string): TestConfigResult {
  const rel = pkg.dir === '.' ? pkg.testConfig : `${pkg.dir}/${pkg.testConfig}`;
  // vitest writes coverage only with --coverage or coverage.enabled
  const enable = !/(^|\s)--coverage(\s|$)/.test(pkg.scripts.test ?? '');
  const header = pkg.testConfig ? `${rel}:` : `Create \`${pkg.dir === '.' ? '' : pkg.dir + '/'}vitest.config.ts\` with:`;
  const manual: TestConfigResult = { manual: vitestManual(header, path, enable) };
  if (!pkg.testConfig) return manual;
  let before: string;
  let lf = '';
  let ins: Ins[] | null = null;
  try {
    before = readFileSync(join(root, rel!), 'utf8');
    lf = before.replace(/\r\n/g, '\n');
    // the parser's offsets are in LF text (it normalises CRLF), so edit positions are computed on lf and mapped back
    const body: any[] = (parseModule(before).$ast as any).body;
    const def = body.find((n) => n.type === 'ExportDefaultDeclaration');
    let obj = unwrap(def?.declaration);
    if (obj?.type === 'CallExpression' && obj.callee.name === 'defineConfig') obj = unwrap(obj.arguments[0]);
    if (obj?.type !== 'ObjectExpression') return manual;
    const eol = '\n';
    const test = prop(obj, 'test');
    if (!test) ins = [addProp(lf, eol, obj, `test: { reporters: ['default', 'json'], outputFile: { json: '${path}' }, coverage: { ${covText(enable)} } }`)];
    else if (unwrap(test.value)?.type === 'ObjectExpression') ins = editTest(lf, eol, unwrap(test.value), path, enable);
  } catch {
    return manual;
  }
  if (!ins) return manual;
  if (!ins.length) return { none: true };
  const eol = eolOf(before);
  const crlf = (at: number) => (eol === '\r\n' ? at + lf.slice(0, at).split('\n').length - 1 : at);
  ins = mergeInserts(ins).map((i) => ({ ...i, at: crlf(i.at), text: withEol(i.text, eol) }));
  let after = before;
  for (const i of [...ins].sort((a, b) => b.at - a.at)) after = after.slice(0, i.at) + i.text + after.slice(i.at);
  const blocks = ins.map((i) => i.text);
  // Uninstall removes blocks by exact text; refuse any edit that would not round-trip.
  if (removeBlocks(after, blocks) !== before) return manual;
  try { parseModule(after); } catch { return manual; } // a round-trip alone does not prove the result is valid code
  return { change: { kind: 'update', rel: rel!, before, after, blocks } };
}

function jestChange(pkg: PackageFacts, root: string, path: string): TestConfigResult {
  const script = pkg.scripts.test;
  const rel = pkg.dir === '.' ? 'package.json' : `${pkg.dir}/package.json`;
  const flags = `--json --outputFile=${path} --coverage`;
  const manual: TestConfigResult = { manual: [`${rel}: add \`${flags}\` to the jest call in the "test" script`] };
  if (script === undefined) return manual;
  if (/(^|\s)--json(\s|$)/.test(script)) return { none: true };
  if (!/^jest(\s+[\w=.:,/@-]+)*$/.test(script) || !/^[\w./@-]+$/.test(path)) return manual;
  const add = ` ${/(^|\s)--coverage(\s|$)/.test(script) ? flags.replace(' --coverage', '') : flags}`;
  let before: string;
  try { before = readFileSync(join(root, rel), 'utf8'); } catch { return manual; }
  const lit = JSON.stringify(script);
  const re = new RegExp(`("test"\\s*:\\s*)${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  const hits = [...before.matchAll(re)];
  if (hits.length !== 1) return manual;
  const at = hits[0].index! + hits[0][0].length - 1; // just before the closing quote
  const after = before.slice(0, at) + add + before.slice(at);
  if (removeBlocks(after, [add]) !== before) return manual;
  return { change: { kind: 'update', rel, before, after, blocks: [add] } };
}

/** True when the package already writes its results file: set up as init would, or by hand in a config init cannot edit. */
export function hasResultsOutput(pkg: PackageFacts, root: string, resultsDir: string): boolean {
  const r = testConfigChange(pkg, root, resultsDir);
  if ('none' in r) return true;
  if ('change' in r) return false;
  const path = resultPath(pkg, root, resultsDir);
  const file = pkg.test === 'vitest' ? pkg.testConfig : pkg.test === 'jest' ? 'package.json' : undefined;
  if (!file) return false;
  try {
    return readFileSync(join(root, pkg.dir, file), 'utf8').includes(path);
  } catch {
    return false;
  }
}

export function testConfigChange(pkg: PackageFacts, root: string, resultsDir: string): TestConfigResult {
  if (pkg.test === 'none') return { none: true };
  const path = resultPath(pkg, root, resultsDir);
  return pkg.test === 'vitest' ? vitestChange(pkg, root, path) : jestChange(pkg, root, path);
}
