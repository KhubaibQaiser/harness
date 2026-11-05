import { describe, expect, it } from 'vitest';
import { LINT_RULES, NO_LINT, TS_OPTIONS, type Stack } from '../../src/rules/table.js';
import { propose } from '../../src/rules/propose.js';

const ALL_PLUGINS = new Set(
  LINT_RULES.map((r) => r.plugin).filter((p): p is string => p !== null),
);
const web = new Set<Stack>(['ts', 'react', 'next']);
const pkgs = [{ dir: '.', frameworks: ['next'] }];

const entry = (id: string) => LINT_RULES.find((r) => r.id === id)!;

describe('propose', () => {
  it('covers the rule families for ts+react+next', () => {
    const ids = propose(web, pkgs, ALL_PLUGINS).rules.map((r) => r.id);
    for (const id of [
      'no-empty',
      '@typescript-eslint/no-floating-promises',
      'react/no-array-index-key',
      'react-hooks/rules-of-hooks',
      '@next/next/no-img-element',
      'tailwindcss/no-arbitrary-value',
      'import/no-default-export',
      'unicorn/filename-case',
      '@eslint-community/eslint-comments/require-description',
      'jsx-a11y',
    ]) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('no-restricted-globals');
  });

  it('uses the owner size numbers verbatim (O10)', () => {
    expect(entry('max-lines').setting).toEqual(['error', { max: 300, skipBlankLines: true, skipComments: true }]);
    expect(entry('max-lines-per-function').setting).toEqual(['error', { max: 50, skipBlankLines: true, skipComments: true }]);
    expect(entry('max-depth').setting).toEqual(['error', 4]);
    expect(entry('max-params').setting).toEqual(['error', 4]);
    expect(entry('complexity').setting).toEqual(['error', 20]);
    expect(entry('@typescript-eslint/no-magic-numbers').setting).toEqual([
      'error',
      { ignore: [0, 1, -1], ignoreArrayIndexes: true, ignoreEnums: true },
    ]);
  });

  it('every setting starts with error', () => {
    for (const r of LINT_RULES) {
      expect(Array.isArray(r.setting) ? r.setting[0] : r.setting).toBe('error');
    }
  });

  it('moves a rule with a missing plugin to missing and out of the config', () => {
    const deps = new Set(ALL_PLUGINS);
    deps.delete('eslint-plugin-unicorn');
    const p = propose(web, pkgs, deps);
    expect(p.missing).toContainEqual({ rule: 'unicorn/filename-case', plugin: 'eslint-plugin-unicorn' });
    expect(p.rules.map((r) => r.id)).not.toContain('unicorn/filename-case');
    expect(p.configText).not.toContain('filename-case');
    expect(p.configText).not.toContain('eslint-plugin-unicorn');
  });

  it('scopes rn rules to the rn package only', () => {
    const p = propose(
      new Set<Stack>(['ts', 'react', 'rn']),
      [{ dir: 'apps/mobile', frameworks: ['rn'] }, { dir: 'apps/web', frameworks: ['next'] }],
      ALL_PLUGINS,
    );
    expect(p.rules.map((r) => r.id)).toContain('no-restricted-imports');
    expect(p.configText).toContain('apps/mobile/**/*.{ts,tsx}');
    expect(p.configText).not.toContain('apps/web/**');
  });

  it('writes parser options, framework ignores, and no regex (O5)', () => {
    const { configText } = propose(web, pkgs, ALL_PLUGINS);
    expect(configText).toContain('projectService');
    for (const g of ['**/page.tsx', '**/layout.tsx', '**/*.config.*', 'app/**/_layout.tsx']) {
      expect(configText).toContain(g);
    }
    expect(configText).toContain('TSEnumDeclaration');
    expect(configText).not.toContain('RegExp');
    expect(configText.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '')).not.toMatch(/\/[^\s/*][^/\n]*\/[gimsuy]*/);
  });

  it('has the no-lint rows and ts options', () => {
    expect(NO_LINT.map((n) => n.antiPattern)).toEqual(
      expect.arrayContaining(['log-only catch', 'mutating shared state', 'magic strings']),
    );
    expect(propose(web, pkgs, ALL_PLUGINS).ts).toEqual(TS_OPTIONS);
  });

  const run = (text: string, plugins: Record<string, unknown>) => {
    // Evaluate the emitted config with fake plugin modules; returns the flat config array.
    const names = [...text.matchAll(/^import (\w+) from '([^']+)';$/gm)];
    const body = text.replace(/^import .*$/gm, '').replace('export default', 'return');
    return new Function(...names.map((m) => m[1]!), body)(
      ...names.map((m) => plugins[m[2]!] ?? { rules: {}, flatConfigs: { recommended: { rules: {} } }, plugin: {}, parser: {}, configs: { disableTypeChecked: { rules: {} } } }),
    ) as { files?: string[]; rules?: Record<string, unknown>; settings?: unknown; languageOptions?: any }[];
  };

  it('skips a version-sensitive rule at load time when the plugin lacks it', () => {
    const { configText } = propose(web, pkgs, ALL_PLUGINS);
    const old = run(configText, { 'eslint-plugin-react-hooks': { rules: { 'rules-of-hooks': {} } } });
    const ids = old.flatMap((b) => Object.keys(b.rules ?? {}));
    expect(ids).not.toContain('react-hooks/set-state-in-effect');
    const fresh = run(configText, { 'eslint-plugin-react-hooks': { rules: { 'set-state-in-effect': {} } } });
    expect(fresh.flatMap((b) => Object.keys(b.rules ?? {}))).toContain('react-hooks/set-state-in-effect');
  });

  it('reports rules the installed plugin lacks as skipped', () => {
    const p = propose(web, pkgs, ALL_PLUGINS, new Map([['eslint-plugin-react-hooks', new Set(['rules-of-hooks'])]]));
    expect(p.skipped).toContainEqual({ rule: 'react-hooks/set-state-in-effect', plugin: 'eslint-plugin-react-hooks' });
    expect(p.configText).not.toContain('set-state-in-effect');
    expect(p.rules.map((r) => r.id)).toContain('react-hooks/rules-of-hooks');
  });

  it('lets out-of-project files parse and turns type-aware rules off there', () => {
    const { configText } = propose(web, pkgs, ALL_PLUGINS);
    expect(configText).toContain('allowDefaultProject');
    expect(configText).toContain('*.config.{js,mjs,cjs,ts}');
    expect(configText).toContain('scripts/**');
    expect(configText).toContain('disableTypeChecked');
  });

  it('keeps off as off in the jsx-a11y spread and sets react version', () => {
    const { configText } = propose(web, pkgs, ALL_PLUGINS);
    const cfg = run(configText, {
      'eslint-plugin-jsx-a11y': { flatConfigs: { recommended: { rules: { a: 'off', b: ['off', {}], c: 0, d: ['warn', { x: 1 }], e: 'warn' } } } },
    });
    const rules = Object.assign({}, ...cfg.map((b) => b.rules));
    expect(rules).toMatchObject({ a: 'off', b: ['off', {}], c: 0, d: ['error', { x: 1 }], e: 'error' });
    expect(JSON.stringify(cfg[0]!.settings)).toContain('"version":"detect"');
  });

  it('emits every rule as error and puts ignores on the right block', () => {
    const cfg = run(propose(web, pkgs, ALL_PLUGINS).configText, {});
    for (const b of cfg) for (const v of Object.values(b.rules ?? {})) expect([v, (v as unknown[])[0]]).toContain('error');
    const dflt = cfg.find((b) => b.rules?.['import/no-default-export']) as any;
    expect(dflt.ignores).toContain('**/page.tsx');
    expect(propose(new Set<Stack>(['react']), pkgs, ALL_PLUGINS).configText).not.toContain('parser');
  });

  it('ignores route-file names in filename-case', () => {
    const [, opts] = entry('unicorn/filename-case').setting as [string, { ignore: string[] }];
    const hit = (n: string) => opts.ignore.some((s) => new RegExp(s).test(n));
    for (const n of ['[id].tsx', '(group)', '_layout.tsx', '+html.tsx']) expect(hit(n)).toBe(true);
    expect(hit('MyFile.tsx')).toBe(false);
  });

  it('accepts eslint-plugin-import-x when it is the installed package', () => {
    const deps = new Set(ALL_PLUGINS);
    deps.delete('eslint-plugin-import');
    deps.add('eslint-plugin-import-x');
    const p = propose(web, pkgs, deps);
    expect(p.missing.map((m) => m.rule)).not.toContain('import/no-default-export');
    expect(p.configText).toContain('"import-x/no-default-export"');
    expect(p.configText).toContain("from 'eslint-plugin-import-x'");
  });
});
