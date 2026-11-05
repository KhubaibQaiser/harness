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
});
