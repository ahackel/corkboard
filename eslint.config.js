// The semantic half of the Google TypeScript style guide (ts.dev/style); layout is CLAUDE.md's "Code style".
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,js}'],
    plugins: { 'import-x': importX },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      // tsc already reports these.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-eval': 'error',
      'no-new-wrappers': 'error',
      'import-x/no-default-export': 'error',
      'import-x/no-mutable-exports': 'error',
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-explicit-any': 'error',
      // Most `!`s are DOM lookups the HTML shell guarantees.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // House idioms: `catch {}` for best-effort I/O; `cond ? a() : b()` / `x && x.f()` as statements.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
  { files: ['vite.config.js', 'playwright.config.ts', 'eslint.config.js'], rules: { 'import-x/no-default-export': 'off' } },
  { files: ['**/*.{ts,js}'], rules: { curly: ['error', 'all'] } },
);
