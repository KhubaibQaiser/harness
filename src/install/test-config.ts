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
  // and only with a provider installed: without one Vitest exits with MISSING DEPENDENCY
  const enable = !/(^|\s)--coverage(\s|$)/.test(pkg.scripts.test ?? '') && !pkg.noCoverageProvider;
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

export const JEST_REPORTER = '.harness/hooks/jest-results.cjs';

// Jest's --outputFile writes nothing without --json, so the harness reporter reads it (Jest does not create the
// folder, the reporter does). Reporter paths resolve against Jest's rootDir, the package dir; ./ or ../ marks them
// as paths, not module names. The ignore keeps Jest's haste map out of .harness/backup (a copy of package.json).
const JEST_IGNORE = '<rootDir>/.harness';
function reporterRel(pkg: PackageFacts, root: string): string {
  const rep = relative(join(root, pkg.dir), join(root, JEST_REPORTER)).split(sep).join('/');
  return rep.startsWith('../') ? rep : `./${rep}`;
}

type JestKey = 'reporters' | 'modulePathIgnorePatterns';

/** Lines for the keys the user's own Jest config sets: Jest lets CLI flags replace them, so they are merged by hand. */
function jestConfigLines(pkg: PackageFacts, root: string, pkgJson: Record<string, any>, values: Record<JestKey, string>): Partial<Record<JestKey, string>> {
  const out: Partial<Record<JestKey, string>> = {};
  const pjRel = pkg.dir === '.' ? 'package.json' : `${pkg.dir}/package.json`;
  for (const key of Object.keys(values) as JestKey[]) {
    const v = pkgJson.jest?.[key];
    if (v === undefined) continue;
    out[key] = Array.isArray(v) ? `${pjRel}: set \`"jest": { "${key}": ${JSON.stringify([...v, values[key]])} }\`` : `${pjRel}: add '${values[key]}' to \`jest.${key}\``;
  }
  if (!pkg.testConfig) return out;
  const cfgRel = pkg.dir === '.' ? pkg.testConfig : `${pkg.dir}/${pkg.testConfig}`;
  let lf: string;
  try {
    lf = readFileSync(join(root, pkg.dir, pkg.testConfig), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return out;
  }
  let obj: any = null;
  try {
    for (const n of (parseModule(lf).$ast as any).body) {
      const e = n.type === 'ExpressionStatement' ? n.expression : null;
      const isCjs = e?.type === 'AssignmentExpression' && e.left.type === 'MemberExpression' && e.left.object.name === 'module' && e.left.property.name === 'exports';
      let o = unwrap(n.type === 'ExportDefaultDeclaration' ? n.declaration : isCjs ? e.right : null);
      if (o?.type === 'CallExpression') o = unwrap(o.arguments[0]);
      if (o?.type === 'ObjectExpression') obj = o;
    }
  } catch {}
  for (const key of Object.keys(values) as JestKey[]) {
    const p = obj ? prop(obj, key) : null;
    if (!p && !(obj === null && new RegExp(`\\b${key}\\b`).test(lf))) continue;
    const arr = p ? unwrap(p.value) : null;
    if (arr?.type === 'ArrayExpression') {
      const text = lf.slice(arr.start, arr.end);
      out[key] = `${cfgRel}: set \`${key}: ${text.slice(0, -1).replace(/[\s,]*$/, '')}${arr.elements.length ? ', ' : ''}'${values[key]}']\``;
    } else out[key] = `${cfgRel}: add '${values[key]}' to \`${key}\``;
  }
  return out;
}

function jestChange(pkg: PackageFacts, root: string, path: string): TestConfigResult {
  const rel = pkg.dir === '.' ? 'package.json' : `${pkg.dir}/package.json`;
  const rep = reporterRel(pkg, root);
  const flagsFor = (s: string | undefined, own: Partial<Record<JestKey, string>> = {}) => {
    const has = (flag: string) => s !== undefined && new RegExp(`(^|\\s)${flag}(=|\\s|$)`).test(s);
    return [
      ...(own.reporters ? [] : [`--reporters=default --reporters=${rep}`]),
      ...(own.modulePathIgnorePatterns ? [] : [`"--modulePathIgnorePatterns=${JEST_IGNORE}"`]),
      `--outputFile=${path}`,
      ...(has('--coverage') ? [] : ['--coverage']),
    ].join(' ');
  };
  const manualFor = (own: Partial<Record<JestKey, string>> = {}): TestConfigResult => ({
    manual: [...Object.values(own), `${rel}: add \`${flagsFor(undefined, own)}\` to the jest call in the "test" script`],
  });
  const script = pkg.scripts.test;
  if (script === undefined) return manualFor();
  if (script.includes(JEST_REPORTER.split('/').pop()!)) return { none: true };
  // Before the reporter, init appended these flags; update swaps them for the reporter form.
  const old = [` --json --outputFile=${path} --coverage`, ` --json --outputFile=${path}`].find((o) => script.endsWith(o));
  const orig = old ? script.slice(0, -old.length) : script;
  const has = (flag: string) => new RegExp(`(^|\\s)${flag}(=|\\s|$)`).test(orig);
  // --config/-c/--projects/--rootDir move Jest's rootDir, which the reporter path is relative to.
  if (['--json', '--outputFile', '--rootDir', '--config', '-c', '--projects'].some(has)) return manualFor();
  if (!/^jest(\s+[\w=.:,/@-]+)*$/.test(orig) || !/^[\w./@-]+$/.test(path)) return manualFor();
  let before: string;
  let pkgJson: Record<string, any>;
  try {
    before = readFileSync(join(root, rel), 'utf8');
    pkgJson = JSON.parse(before);
  } catch {
    return manualFor();
  }
  if (pkgJson.jest?.rootDir !== undefined) return manualFor();
  const cfgText = (() => {
    try { return pkg.testConfig ? readFileSync(join(root, pkg.dir, pkg.testConfig), 'utf8') : ''; } catch { return ''; }
  })();
  if (/\brootDir\b/.test(cfgText)) return manualFor();
  const own = jestConfigLines(pkg, root, pkgJson, { reporters: rep, modulePathIgnorePatterns: JEST_IGNORE });
  if (Object.keys(own).length) return manualFor(own);
  const add = JSON.stringify(` ${flagsFor(orig)}`).slice(1, -1); // inserted inside the JSON string, so its quotes are escaped
  const lit = JSON.stringify(script);
  const re = new RegExp(`("test"\\s*:\\s*)${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  const hits = [...before.matchAll(re)];
  if (hits.length !== 1) return manualFor();
  const at = hits[0].index! + hits[0][0].length - 1; // just before the closing quote
  const cut = old ? JSON.stringify(old).length - 2 : 0; // the old flags, as written in the JSON text
  const base = before.slice(0, at - cut) + before.slice(at); // the file with the user's own script
  const after = base.slice(0, at - cut) + add + base.slice(at - cut);
  if (removeBlocks(after, [add]) !== base) return manualFor();
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
