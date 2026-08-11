import type { Linter } from 'eslint';

import pluginJs from '@eslint/js';
import parserTs from '@typescript-eslint/parser';
import pluginTs from '@typescript-eslint/eslint-plugin';
import pluginViTest from '@vitest/eslint-plugin';
import configPrettier from 'eslint-config-prettier/flat';
import pluginImport from 'eslint-plugin-import';
import globals from 'globals';

export default [
  pluginJs.configs.recommended,
  pluginImport.flatConfigs.recommended,
  { ignores: ['**/dist/', 'tests/tsp-output/', '**/*.mts'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      // the emitted skeletons run in browsers and embedded JS engines, not just node
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parser: parserTs,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['emitter-ts/assets/skeleton.ts'],
        },
      },
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': pluginTs,
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': 'allow-with-description' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'eqeqeq': ['error', 'smart'],
      'import/extensions': ['warn', { ts: 'never' }],
      'import/order': [
        'error',
        {
          'alphabetize': { caseInsensitive: true, order: 'asc' },
          'groups': ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
        },
      ],
      'no-console': 'error',
      'no-constant-condition': 'off',
      'no-duplicate-imports': 'error',
      'no-throw-literal': 'error',
      'no-unused-vars': 'off',
      'require-await': 'error',
      'sort-imports': [
        'error',
        {
          ignoreCase: true,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
        },
      ],
    },
    settings: {
      'import/resolver': { typescript: { project: '**/tsconfig.json' } },
    },
  },
  {
    files: ['tests/src/**/*.test.ts'],
    plugins: { vitest: pluginViTest },
    rules: {
      ...pluginViTest.configs.recommended.rules,
    },
  },
  configPrettier,
] satisfies Linter.Config[];
