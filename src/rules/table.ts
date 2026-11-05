// Stack anti-patterns mapped to ESLint and TS settings (spec 5.2, owner numbers 5.3/O10).
// Every setting is 'error' (O4). Rule names were checked against official docs; see the task report.
export type Stack = 'ts' | 'react' | 'next' | 'rn';

export interface LintRule {
  id: string;
  /** npm package, null for core */
  plugin: string | null;
  /** identifier used in the generated import */
  importName?: string;
  stacks: Stack[];
  /** full ESLint rule entry, 'error' first */
  setting: unknown;
  files?: 'rn' | 'next';
  ignores?: string[];
  antiPattern: string;
  /** spread the plugin's flat recommended rules, each forced to error */
  recommendedSet?: true;
  /** rule may be missing from an older installed plugin: the config loads it only if the plugin has it */
  guard?: true;
  /** another package that provides the same rule under its own key */
  alt?: { plugin: string; importName: string; key: string };
}

const ALL: Stack[] = ['ts', 'react', 'next', 'rn'];
const WEB: Stack[] = ['react', 'next', 'rn'];
const TSE = { plugin: 'typescript-eslint', importName: 'tseslint', stacks: ['ts'] as Stack[] };
const size = { skipBlankLines: true, skipComments: true };
const core = (id: string, antiPattern: string, setting: unknown = 'error', more: Partial<LintRule> = {}): LintRule =>
  ({ id, plugin: null, stacks: ALL, setting, antiPattern, ...more });
const ts = (name: string, antiPattern: string, setting: unknown = 'error'): LintRule =>
  ({ ...TSE, id: `@typescript-eslint/${name}`, setting, antiPattern });
const hooks = (name: string, antiPattern: string): LintRule =>
  ({ id: `react-hooks/${name}`, plugin: 'eslint-plugin-react-hooks', importName: 'reactHooks', stacks: WEB, setting: 'error', guard: true, antiPattern });
const react = (name: string, antiPattern: string, guard?: true): LintRule =>
  ({ id: `react/${name}`, plugin: 'eslint-plugin-react', importName: 'react', stacks: WEB, setting: 'error', ...(guard && { guard }), antiPattern });
const next = (name: string, antiPattern: string): LintRule =>
  ({ id: `@next/next/${name}`, plugin: '@next/eslint-plugin-next', importName: 'nextPlugin', stacks: ['next'], setting: 'error', files: 'next', guard: true, antiPattern });
const rnPath = (importName: string, message: string) => ({ name: 'react-native', importNames: [importName], message });

export const LINT_RULES: LintRule[] = [
  ts('consistent-type-assertions', '`as` to silence errors', ['error', { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }]),
  ts('no-unnecessary-type-assertion', '`as` to silence errors'),
  ts('ban-ts-comment', '@ts-ignore', ['error', { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' }]),
  ts('no-non-null-assertion', 'unexplained `!`'),
  {
    id: '@eslint-community/eslint-comments/require-description',
    plugin: '@eslint-community/eslint-plugin-eslint-comments',
    importName: 'eslintComments',
    stacks: ['ts'],
    setting: 'error',
    antiPattern: 'unexplained `!` (disable comments need a reason)',
  },
  ts('no-explicit-any', 'untyped JSON.parse, any'),
  ts('no-unsafe-assignment', 'untyped JSON.parse, any'),
  ts('no-unsafe-member-access', 'untyped JSON.parse, any'),
  ts('no-unsafe-argument', 'untyped JSON.parse, any'),
  ts('no-unsafe-call', 'untyped JSON.parse, any'),
  ts('no-unsafe-return', 'untyped JSON.parse, any'),
  core('no-empty', 'empty catch'),
  ts('no-floating-promises', 'unhandled promise, missing await'),
  ts('no-misused-promises', 'unhandled promise, missing await'),
  ts('await-thenable', 'unhandled promise, missing await'),
  core('max-lines', 'huge modules', ['error', { max: 300, ...size }]),
  core('max-lines-per-function', 'long functions', ['error', { max: 50, ...size }]),
  core('max-params', 'boolean-flag parameters', ['error', 4]),
  core('max-depth', 'deep nesting instead of early returns', ['error', 4]),
  core('no-else-return', 'deep nesting instead of early returns'),
  core('complexity', 'deep nesting instead of early returns', ['error', 20]),
  core('no-param-reassign', 'mutating arguments', ['error', { props: true }]),
  ts('no-magic-numbers', 'magic numbers', ['error', { ignore: [0, 1, -1], ignoreArrayIndexes: true, ignoreEnums: true }]),
  core('no-restricted-syntax', 'enums where unions fit', [
    'error',
    { selector: 'TSEnumDeclaration', message: 'Use a union type instead of an enum.' },
  ]),
  core('no-restricted-properties', 'process.env read outside env.ts', ['error', { object: 'process', property: 'env', message: 'Read env in env.ts only.' }], { ignores: ['**/env.ts'] }),
  {
    id: 'import/no-default-export',
    plugin: 'eslint-plugin-import',
    importName: 'importPlugin',
    stacks: ALL,
    setting: 'error',
    ignores: ['**/page.tsx', '**/layout.tsx', '**/*.config.*', 'app/**/_layout.tsx'],
    alt: { plugin: 'eslint-plugin-import-x', importName: 'importX', key: 'import-x' },
    antiPattern: 'named exports only',
  },
  {
    id: 'unicorn/filename-case',
    plugin: 'eslint-plugin-unicorn',
    importName: 'unicorn',
    stacks: ALL,
    // Strings are regex sources (unicorn docs): Next [id] / (group), Expo _layout, +html route files.
    setting: ['error', { case: 'kebabCase', ignore: ['^\\[.*\\]', '^\\(.*\\)$', '^_', '^\\+'] }],
    antiPattern: 'kebab-case files',
  },
  hooks('rules-of-hooks', 'hooks rules'),
  hooks('exhaustive-deps', 'stale deps'),
  hooks('set-state-in-effect', 'derived state, syncing props to state in effects'),
  hooks('static-components', 'inline component definitions'),
  react('no-unstable-nested-components', 'inline component definitions'),
  react('no-array-index-key', 'index keys in dynamic lists'),
  react('jsx-no-constructed-context-values', 'needless re-renders'),
  react('no-object-type-as-default-prop', 'needless re-renders', true),
  {
    id: 'jsx-a11y',
    plugin: 'eslint-plugin-jsx-a11y',
    importName: 'jsxA11y',
    stacks: ['react', 'next'],
    setting: 'error',
    recommendedSet: true,
    antiPattern: 'accessibility baseline (web)',
  },
  next('no-img-element', 'raw <img>'),
  next('no-html-link-for-pages', 'raw <a> for internal pages'),
  next('no-head-element', 'missing metadata API'),
  next('no-async-client-component', 'async client components'),
  core('no-await-in-loop', 'sequential awaits', 'error', { stacks: ['next'], files: 'next' }),
  {
    id: 'tailwindcss/no-arbitrary-value',
    plugin: 'eslint-plugin-tailwindcss',
    importName: 'tailwindcss',
    stacks: ['react', 'next'],
    setting: 'error',
    guard: true,
    antiPattern: 'Tailwind arbitrary values like h-[98px]',
  },
  core('no-restricted-imports', 'FlatList, Image, SafeAreaView, Animated from react-native', [
    'error',
    {
      paths: [
        rnPath('FlatList', 'Use FlashList.'),
        rnPath('Image', 'Use expo-image.'),
        rnPath('SafeAreaView', 'Use react-native-safe-area-context.'),
        rnPath('Animated', 'Use Reanimated.'),
      ],
    },
  ], { stacks: ['rn'], files: 'rn' }),
  core('no-restricted-globals', 'web-only APIs in shared code', ['error', 'window', 'document', 'localStorage'], { stacks: ['rn'], files: 'rn' }),
];

export const NO_LINT: { antiPattern: string; note?: string }[] = [
  { antiPattern: 'log-only catch' },
  { antiPattern: 'mutating shared state' },
  { antiPattern: 'magic strings' },
  { antiPattern: 'fetching in effects; effect chains' },
  { antiPattern: 'prop drilling, oversized props, boolean prop soup' },
  { antiPattern: 'state for computable values' },
  { antiPattern: 'server data in Zustand' },
  { antiPattern: '"use client" high in the tree; client components only to fetch' },
  { antiPattern: 'server-only code or secrets in client bundles', note: 'the server-only package fails the build; it is a dependency, not lint' },
  { antiPattern: 'client-effect fetching the server could do; missing Suspense' },
  { antiPattern: 'cache and revalidate mistakes; route handlers where server actions fit' },
  { antiPattern: 'layout shift' },
  { antiPattern: 'inline renderItem', note: 'react/jsx-no-bind cannot target one prop and is noisy on all' },
  { antiPattern: 'ScrollView or map for long lists' },
  { antiPattern: 'heavy JS during gestures' },
  { antiPattern: 'hand-edited ios/ or android/, ejecting' },
  { antiPattern: 'Expo Go-only assumptions; font scaling' },
];

export const TS_OPTIONS: Record<string, true> = {
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  noImplicitReturns: true,
};
