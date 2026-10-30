const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'design/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['*.js', 'scripts/**/*.cjs', 'tests/**/*.{js,cjs}'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['media/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, module: 'readonly', require: 'readonly' } }
  },
  {
    files: ['media/app.js', 'media/webview-bootstrap.js', 'media/configuration-view.js'],
    languageOptions: { globals: { acquireVsCodeApi: 'readonly', CommanderContrast: 'readonly' } }
  },
  {
    files: ['native/file-icons-macos.js', 'native/file-clipboard-macos.js'],
    languageOptions: { sourceType: 'script', globals: { ObjC: 'readonly', $: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^run$', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] }
  }
];
