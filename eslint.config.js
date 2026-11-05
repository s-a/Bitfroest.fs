const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'design/**', '.tmp/**', 'native/build/**', 'native/out/**', 'media/xray-editor.js', 'media/xray-editor-worker.js'] },
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
    files: ['scripts/showcases/surface-recorder.cjs', 'scripts/xray-editor.mjs'],
    languageOptions: { globals: globals.browser }
  },
  {
    files: ['scripts/showcases/run.cjs', 'scripts/showcases/sequence.cjs', 'scripts/showcases/surface-recorder.cjs'],
    rules: { 'no-control-regex': 'off' }
  },
  {
    files: ['media/app.js', 'media/webview-bootstrap.js', 'media/startup-diagnostics.js', 'media/configuration-view.js'],
    languageOptions: { globals: { acquireVsCodeApi: 'readonly', CommanderContrast: 'readonly' } }
  }
];
