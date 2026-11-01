const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('actual command callers fail compilation without a supported operation and required context', () => {
  const { check } = require('../scripts/check-operations.cjs');
  const file = path.resolve(__dirname, '../media/app.js'), original = fs.readFileSync(file, 'utf8');
  const anchor = "command: options.mode === 'move' ? 'move' : 'copy', ";
  assert.ok(original.includes(anchor));
  for (const value of ['', "command: 'unknown', ", "command: 'rename', ", "command: 'delete', "]) {
    const modified = original.replace(anchor, value);
    const errors = check([file], new Map([[file, modified]]));
    assert.ok(errors.length, `must reject ${value || 'missing command'}`);
  }
  for (const [from, to] of [[', target, sources:', ', target: 42, sources:'], ['sources: options.ids.map', 'unexpected: options.ids.map']]) {
    assert.ok(original.includes(from));
    const errors = check([file], new Map([[file, original.replace(from, to)]]));
    assert.ok(errors.length, to);
  }
});

test('ZIP remove transport action resolves through the foreground delete capability', () => {
  const Jobs = require('../media/commander-jobs');
  const command = Jobs.commandForAction('remove');
  assert.equal(command?.id, 'delete');
  assert.equal(command?.supportsBackgroundOperation.enabled, false);
});

test('a registry entry missing capabilities fails the build gate', () => {
  const { check } = require('../scripts/check-operations.cjs');
  const file = path.resolve(__dirname, '../media/commander-jobs.js'), original = fs.readFileSync(file, 'utf8');
  const modified = original.replace("copy: { id: 'copy', supportsBackgroundOperation: background('pane-header', 'cooperative') }", "copy: { id: 'copy' }");
  assert.notEqual(modified, original);
  assert.ok(check([file], new Map([[file, modified]])).length);
});

test('build and packaging both enforce the operation contract', () => {
  const manifest = require('../package.json');
  assert.match(manifest.scripts.check, /npm run check:operations &&/);
  assert.match(manifest.scripts['vscode:prepublish'], /npm run check:operations &&/);
});
