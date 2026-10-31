const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('internal documentation is ignored and excluded from distribution without exceptions', () => {
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '--quiet', 'Docs/Internal/example.md'], { cwd: root });
  assert.equal(ignored.status, 0);
  assert.match(read('.vscodeignore'), /^Docs\/\*\*$/m);
  assert.doesNotMatch(read('.vscodeignore'), /^!Docs\//m);
});

test('public documentation has no dependencies on local internal documents', () => {
  assert.doesNotMatch(read('README.md'), /\]\(Docs\//);
  assert.doesNotMatch(read('media/workbench-vendor.js'), /Docs\//);
  assert.doesNotMatch(read('tests/file-type-defaults.test.js'), /\.\.\/Docs\//);
});
