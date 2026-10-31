const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('isolated extension package loads its entry point and runtime dependencies', {
  skip: !process.env.EXTENSION_PACKAGE_TEST_PATH
}, () => {
  const directory = path.resolve(process.env.EXTENSION_PACKAGE_TEST_PATH);
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function (name, ...args) {
      return name === 'vscode' ? {} : original.call(this, name, ...args);
    };
    const extension = require(process.argv[1]);
    assert.equal(typeof extension.activate, 'function');
  `, directory], { cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
