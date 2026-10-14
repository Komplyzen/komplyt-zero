import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Core must not depend on enterprise code (src/ee/), statically or via a
    // dynamic import(). Only relative specifiers are matched, so a package
    // subpath such as 'pkg/ee/x' is not affected.
    files: ['**/*.ts'],
    ignores: ['ee/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.{1,2}/(.*/)?ee(/|$)',
              message: 'Core code must not import src/ee/ (enterprise). index.ts loads it via ee-loader.ts.',
            },
          ],
        },
      ],
      // esquery regexes cannot contain '/', hence [\x2F].
      'no-restricted-syntax': [
        'error',
        {
          selector: String.raw`ImportExpression[source.value=/^\.{1,2}[\x2F](.*[\x2F])?ee([\x2F]|$)/]`,
          message: 'Core code must not import src/ee/ (enterprise). index.ts loads it via ee-loader.ts.',
        },
        {
          selector: String.raw`ImportExpression > TemplateLiteral.source > TemplateElement[value.raw=/^\.{1,2}[\x2F](.*[\x2F])?ee([\x2F]|$)/]`,
          message: 'Core code must not import src/ee/ (enterprise). index.ts loads it via ee-loader.ts.',
        },
        {
          selector: String.raw`TSImportType[argument.literal.value=/^\.{1,2}[\x2F](.*[\x2F])?ee([\x2F]|$)/]`,
          message: 'Core code must not reference src/ee/ (enterprise) types.',
        },
      ],
    },
  },
  {
    // The one sanctioned ee/ load: index.ts's dynamic import, passed to
    // loadEnterpriseModules (tolerates absence in open-core builds). Static
    // ee/ imports in index.ts are still caught by no-restricted-imports.
    files: ['index.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
