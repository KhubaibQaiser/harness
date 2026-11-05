import { LINT_RULES, NO_LINT, TS_OPTIONS, type LintRule, type Stack } from './table.js';

export interface Proposal {
  configText: string;
  rules: LintRule[];
  missing: { rule: string; plugin: string }[];
  /** version-sensitive rules the installed plugin lacks; left out of the config */
  skipped: { rule: string; plugin: string }[];
  ts: Record<string, true>;
  noLint: typeof NO_LINT;
}

const TS_GLOBS = ['**/*.{ts,tsx,mts,cts}'];
// Files usually outside tsconfig: parsed through the default project, type-aware rules off.
const LOOSE_GLOBS = ['*.config.{js,mjs,cjs,ts}', 'scripts/**'];
const globFor = (dir: string) => (dir === '.' ? TS_GLOBS[0]! : `${dir}/**/*.{ts,tsx}`);
const pluginKey = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : id);
const ruleName = (id: string) => id.slice(id.lastIndexOf('/') + 1);

interface Block {
  files: string[];
  ignores?: string[];
  fixed: [string, unknown][];
  spreads: string[]; // jsx-a11y style recommended sets
  guarded: Map<string, { key: string; rules: Record<string, unknown> }>;
}

export function propose(
  stacks: Set<Stack>,
  packages: { dir: string; frameworks: string[] }[],
  devDeps: Set<string>,
  /** optional: rule names each installed plugin really has, to report skips in the preview */
  pluginRules?: Map<string, Set<string>>,
): Proposal {
  const missing: Proposal['missing'] = [];
  const skipped: Proposal['skipped'] = [];
  const rules: LintRule[] = [];
  const filesOf = (kind: 'rn' | 'next') => packages.filter((p) => p.frameworks.includes(kind)).map((p) => globFor(p.dir));
  for (let r of LINT_RULES) {
    if (!r.stacks.some((s) => stacks.has(s))) continue;
    if (r.files && filesOf(r.files).length === 0) continue;
    if (r.plugin && !devDeps.has(r.plugin) && r.alt && devDeps.has(r.alt.plugin)) {
      r = { ...r, id: `${r.alt.key}/${ruleName(r.id)}`, plugin: r.alt.plugin, importName: r.alt.importName };
    }
    if (r.plugin && !devDeps.has(r.plugin)) {
      missing.push({ rule: r.id, plugin: r.plugin });
      continue;
    }
    const have = r.plugin ? pluginRules?.get(r.plugin) : undefined;
    if (r.guard && r.plugin && have && !have.has(ruleName(r.id))) {
      skipped.push({ rule: r.id, plugin: r.plugin });
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

  // One block per distinct (files, ignores).
  const blocks = new Map<string, Block>();
  for (const r of rules) {
    const files = r.files ? filesOf(r.files) : TS_GLOBS;
    const key = JSON.stringify([files, r.ignores]);
    const b: Block = blocks.get(key) ?? { files, ...(r.ignores && { ignores: r.ignores }), fixed: [], spreads: [], guarded: new Map() };
    if (r.recommendedSet) b.spreads.push(r.importName!);
    else if (r.guard && r.plugin) {
      const g = b.guarded.get(r.importName!) ?? { key: pluginKey(r.id), rules: {} };
      g.rules[r.id] = r.setting;
      b.guarded.set(r.importName!, g);
    } else b.fixed.push([r.id, r.setting]);
    blocks.set(key, b);
  }

  const list = [...blocks.values()];
  const head = {
    files: TS_GLOBS,
    plugins: '__PLUGINS__',
    ...(imports.has('react') && { settings: { react: { version: 'detect' } } }),
    ...(hasTs && {
      languageOptions: { parser: '__PARSER__', parserOptions: { projectService: { allowDefaultProject: LOOSE_GLOBS } } },
    }),
  };
  const out: unknown[] = [head, ...list.map(({ files, ignores }, i) => ({ files, ...(ignores && { ignores }), rules: `__RULES_${i}__` }))];
  if (hasTs) out.push({ files: LOOSE_GLOBS, '__spread__': 'tseslint.configs.disableTypeChecked' });

  const rulesText = (b: Block) => {
    const parts = [
      ...b.fixed.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`),
      ...b.spreads.map((n) => `...allError(${n}.flatConfigs.recommended.rules)`),
      ...[...b.guarded].map(([n, g]) => `...known(${n}, ${JSON.stringify(g.key)}, ${JSON.stringify(g.rules)})`),
    ];
    return `{\n${parts.map((x) => `      ${x}`).join(',\n')}\n    }`;
  };
  let body = JSON.stringify(out, null, 2)
    .replace('"__PLUGINS__"', `{ ${Object.entries(plugins).map(([k, v]) => `'${k}': ${v}`).join(', ')} }`)
    .replace('"__PARSER__"', 'tseslint.parser')
    .replace(/"__spread__": "([^"]+)"/, '...$1');
  list.forEach((b, i) => (body = body.replace(`"__RULES_${i}__"`, () => rulesText(b))));

  const helpers = [
    body.includes('allError(') &&
      // Force severity to error, but never switch on a rule the preset leaves off.
      "const allError = (rules) => Object.fromEntries(Object.entries(rules).map(([k, v]) => { const [s, ...o] = [].concat(v); return [k, s === 'off' || s === 0 ? v : o.length ? ['error', ...o] : 'error']; }));",
    body.includes('known(') &&
      // Load a rule only if the installed plugin has it, so an older plugin never fails ESLint.
      'const known = (plugin, ns, rules) => Object.fromEntries(Object.entries(rules).filter(([id]) => plugin.rules?.[id.slice(ns.length + 1)]));',
  ].filter(Boolean);
  const importLines = [...imports].map(([n, p]) => `import ${n} from '${p}';`);
  const configText = `// Written by harness.\n${importLines.join('\n')}\n${helpers.join('\n')}\nexport default ${body};\n`;
  return { configText, rules, missing, skipped, ts: TS_OPTIONS, noLint: NO_LINT };
}
