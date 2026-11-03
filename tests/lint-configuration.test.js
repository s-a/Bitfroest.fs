const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

const cwd = path.resolve(__dirname, '..');

test('lint excludes generated native build trees and their dependencies', async () => {
  const lint = new ESLint({ cwd });
  for (const file of [
    'native/build/dependencies/libgit2/script/api-docs/api-generator.js',
    'native/out/dependencies/libgit2/script/api-docs/api-generator.js'
  ]) assert.equal(await lint.isPathIgnored(path.join(cwd, file)), true, file);
});

test('lint retains checks for product code, native adapters, build scripts and tests', async () => {
  const lint = new ESLint({ cwd });
  for (const file of ['extension.js', 'media/app.js', 'native/adapter.js', 'scripts/ci-native-build.cjs', 'tests/lint-configuration.test.js']) {
    assert.equal(await lint.isPathIgnored(path.join(cwd, file)), false, file);
    const [result] = await lint.lintText('const unused = 1;', { filePath: file });
    assert.ok(result.messages.some(message => message.ruleId === 'no-unused-vars'), file);
  }
});
