import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import playwright from 'eslint-plugin-playwright';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['node_modules/**', 'playwright-report/**', 'test-results/**', 'coverage/**', 'dist/**'],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    ...playwright.configs['flat/recommended'],

    rules: {
      'playwright/expect-expect': 'off',
    },
  },

  prettier,
];
