const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { productFiles, inspectRuntimeSource } = require('./support/runtime-architecture.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(name, text) {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
  }
  write('.vscodeignore', '.tmp/**\nTMP/**\nscripts/**\ntests/**\n');
  write('extension.js', "require('node:fs');");
  write('.tmp/demo/copy/worker.js', "require('node:child_process');");
  write('TMP/probe.js', "require('node:child_process');");
  return { root, write };
}

test('product inventory excludes package-excluded root demo and build directories', t => {
  const { root } = fixture(t);
  assert.deepEqual(productFiles(root), ['.vscodeignore', 'extension.js']);
});

test('untracked and nested product violations remain in the architecture gate', t => {
  const { root, write } = fixture(t);
  for (const name of ['worker.cjs', 'media/new-module.mjs', 'media/.tmp/worker.js']) write(name, "require('node:child_process');");
  const files = productFiles(root).filter(name => /\.[cm]?js$/.test(name));
  const violations = files.flatMap(name => inspectRuntimeSource(fs.readFileSync(path.join(root, name), 'utf8'), name));
  assert.deepEqual(violations.map(item => item.file).sort(), ['media/.tmp/worker.js', 'media/new-module.mjs', 'worker.cjs']);
});

test('removing an exclusion or re-including a temporary file restores inspection', t => {
  const { root, write } = fixture(t);
  for (const rules of ['.tmp/**\n!.tmp/demo/copy/worker.js\n', '.tmp/**\n!**/worker.js\n', '']) {
    write('.vscodeignore', rules);
    const files = productFiles(root);
    assert.ok(files.includes('.tmp/demo/copy/worker.js'));
    assert.ok(files.includes('TMP/probe.js'));
  }
});
