// The SEMANTIC half of the Google TypeScript style guide (ts.dev/style) — rules about what the code
// means, not how it's laid out. Layout is Prettier's job (.prettierrc.json), so eslint-config-prettier
// comes last and switches off every rule that would fight it.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,js}'],
    plugins: { 'import-x': importX },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      // tsc already reports these (strict, noUnusedLocals/Parameters) — don't say it twice.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // Google: `===` always, except `== null`, which is the idiom for null-or-undefined.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-eval': 'error',
      'no-new-wrappers': 'error',
      // Google: named exports only, and no `export let` (a changing value gets a getter).
      'import-x/no-default-export': 'error',
      'import-x/no-mutable-exports': 'error',
      // Google: `T[]` for simple element types, `Array<…>` for complex ones; interfaces for object types.
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-explicit-any': 'error',
      // Google discourages `!` too, but whether one is safe is a judgement call per site (220+ of
      // them, most on DOM lookups that the HTML shell guarantees) — not something to turn red wholesale.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // House idioms the recommended sets would flag: `try { … } catch {}` for best-effort I/O, and
      // `cond ? a() : b()` / `x && x.f()` as statements.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
  // Tool configs are consumed as default exports.
  { files: ['vite.config.js', 'playwright.config.ts', 'eslint.config.js'], rules: { 'import-x/no-default-export': 'off' } },
  prettier,
);
