// Regole volutamente essenziali: errori veri e codice morto, lo stile lo decide Prettier.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test/fixtures/electron-app/node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // I blocchi catch vuoti hanno sempre un commento che dice perché
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Le sequenze di controllo del terminale (ANSI) sono il mestiere di questo programma
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/web/**', 'src/overlay/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // TypeScript controlla già i nomi non definiti
    files: ['**/*.ts', '**/*.cts'],
    rules: { 'no-undef': 'off' },
  },
  {
    // Gli script dei test passano funzioni al browser (page.evaluate)
    files: ['test/e2e/**', 'test/fixtures/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Processo principale di Electron: Node, non il browser (screen è il modulo di Electron)
    files: ['test/fixtures/electron-app/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, screen: 'off' } },
  },
  {
    files: ['**/*.cts', '**/*.cjs', 'test/fixtures/electron-app/**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
