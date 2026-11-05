import { LINT_RULES, NO_LINT, TS_OPTIONS, type LintRule, type Stack } from './table.js';

export interface Proposal {
  configText: string;
  rules: LintRule[];
  missing: { rule: string; plugin: string }[];
  ts: Record<string, true>;
  noLint: typeof NO_LINT;
}

const TS_GLOBS = ['**/*.{ts,tsx,mts,cts}'];
const globFor = (dir: string) => (dir === '.' ? TS_GLOBS[0]! : `${dir}/**/*.{ts,tsx}`);
const pluginKey = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : id);

export function propose(
  stacks: Set<Stack>,
  packages: { dir: string; frameworks: string[] }[],
  devDeps: Set<string>,
): Proposal {
  const missing: Proposal['missing'] = [];
  const rules: LintRule[] = [];
  const filesOf = (kind: 'rn' | 'next') => packages.filter((p) => p.frameworks.includes(kind)).map((p) => globFor(p.dir));
  for (const r of LINT_RULES) {
    if (!r.stacks.some((s) => stacks.has(s))) continue;
    if (r.files && filesOf(r.files).length === 0) continue;
    if (r.plugin && !devDeps.has(r.plugin)) {
      missing.push({ rule: r.id, plugin: r.plugin });
      continue;
    }
    rules.push(r);
  }

  const imports = new Map<string, string>(); // importName -> package
  const plugins: Record<string, string> = {}; // key -> expression
  for (const r of rules) {
    if (!r.plugin || !r.importName) continue;
    imports.set(r.importName, r.plugin);
    plugins[pluginKey(r.id)] = r.importName === 'tseslint' ? 'tseslint.plugin' : r.importName;
  }
  const hasTs = stacks.has('ts') && imports.has('tseslint');

  // One block per distinct (files, ignores); jsx-a11y is spread from the plugin's own recommended set.
  const blocks = new Map<string, { files: string[]; ignores?: string[]; rules: Record<string, unknown> }>();
  for (const r of rules) {
    const files = r.files ? filesOf(r.files) : TS_GLOBS;
    const key = JSON.stringify([files, r.ignores]);
    const b = blocks.get(key) ?? { files, ...(r.ignores && { ignores: r.ignores }), rules: {} };
    if (r.recommendedSet) b.rules['__spread__'] = r.importName;
    else b.rules[r.id] = r.setting;
    blocks.set(key, b);
  }

  const head = {
    files: TS_GLOBS,
    plugins: '__PLUGINS__',
    ...(hasTs && { languageOptions: { parser: '__PARSER__', parserOptions: { projectService: true } } }),
  };
  const body = JSON.stringify([head, ...blocks.values()], null, 2)
    .replace('"__PLUGINS__"', `{ ${Object.entries(plugins).map(([k, v]) => `'${k}': ${v}`).join(', ')} }`)
    .replace('"__PARSER__"', 'tseslint.parser')
    .replace(/"__spread__": "([^"]+)"/g, '...allError($1.flatConfigs.recommended.rules)');
  const importLines = [...imports].map(([n, p]) => `import ${n} from '${p}';`);
  const helper = body.includes('allError(')
    ? "const allError = (rules) => Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, Array.isArray(v) ? ['error', ...v.slice(1)] : 'error']));\n"
    : '';
  const configText = `// Written by harness.\n${importLines.join('\n')}\n${helper}export default ${body};\n`;
  return { configText, rules, missing, ts: TS_OPTIONS, noLint: NO_LINT };
}
