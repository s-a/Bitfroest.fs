const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { inspectRuntimeSource } = require('./support/runtime-architecture.cjs');

function factory(options) {
  const source = fs.readFileSync(require.resolve('../search-metadata'), 'utf8');
  assert.deepEqual(inspectRuntimeSource(source, 'search-metadata.js'), []);
  return require('../search-metadata').createSearchMetadata(options);
}

test('replaced metadata interpreter adapter is absent', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '../native/search-metadata.ps1')), false);
});

test('Windows search forwards every attribute through one native session and closes it once', async () => {
  const flags = { directory: true, readonly: true, archive: false, hidden: true, system: true, compressed: true, encrypted: true };
  const calls = []; let opened = 0, closed = 0;
  const metadata = factory({ platform: 'win32', apiFactory: () => ({ openSession() { opened++; return { invoke: async (operation, input) => { calls.push([operation, input]); return { attributes: flags }; }, close() { closed++; } }; } }) });
  assert.equal(opened, 0);
  assert.deepEqual(await metadata.attributes('C:\\one'), flags);
  assert.deepEqual(await metadata.attributes('C:\\two'), flags);
  assert.deepEqual(calls, [['metadata.query', { path: 'C:\\one' }], ['metadata.query', { path: 'C:\\two' }]]);
  assert.equal(opened, 1);
  metadata.dispose(); metadata.dispose(); assert.equal(closed, 1);
  await assert.rejects(metadata.attributes('C:\\three'), { code: 'SessionClosed' });
});

test('POSIX metadata conventions remain unchanged without loading a Windows binding', async () => {
  for (const platform of ['linux', 'darwin']) {
    const metadata = factory({ platform, apiFactory() { assert.fail('Unexpected binding load'); } });
    const stat = { mode: 0o444, isDirectory: () => false, isFile: () => true };
    assert.deepEqual(await metadata.attributes('/tmp/.hidden', stat), { directory: false, readonly: true, archive: true, hidden: true, system: false, compressed: false, encrypted: false });
    metadata.dispose();
  }
});

test('missing bindings and native failures remain explicit without external fallbacks', async () => {
  const unavailable = Object.assign(new Error('missing'), { code: 'BindingUnavailable' });
  const metadata = factory({ platform: 'win32', apiFactory() { throw unavailable; } });
  await assert.rejects(metadata.attributes('C:\\one'), error => error === unavailable);
  metadata.dispose();
  const failure = Object.assign(new Error('missing path'), { code: 'NotFound' });
  const failed = factory({ platform: 'win32', apiFactory: () => ({ openSession: () => ({ invoke: async () => { throw failure; }, close() {} }) }) });
  await assert.rejects(failed.attributes('C:\\missing'), error => error === failure);
  failed.dispose();
});

test('disposed metadata cannot accept a delayed native success', async () => {
  let complete;
  const metadata = factory({ platform: 'win32', apiFactory: () => ({ openSession: () => ({ invoke: () => new Promise(resolve => { complete = resolve; }), close() {} }) }) });
  const pending = metadata.attributes('C:\\one'); metadata.dispose();
  complete({ attributes: { directory: false } });
  await assert.rejects(pending, { code: 'SessionClosed' });
});

test('dispose rejects pending metadata immediately even when the native request stays pending', async () => {
  const metadata = factory({ platform: 'win32', apiFactory: () => ({ openSession: () => ({ invoke: () => new Promise(() => {}), close() {} }) }) });
  const pending = metadata.attributes('C:\\one');
  metadata.dispose();
  const result = await Promise.race([pending.then(() => 'success', error => error.code), new Promise(resolve => setImmediate(() => resolve('still pending')))]);
  assert.equal(result, 'SessionClosed');
});

test('default Windows metadata handles long Unicode paths through the staged binding', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'search-long-')));
  t.after(async () => { assert.ok(root.startsWith(await fs.promises.realpath(os.tmpdir()))); await fs.promises.rm(root, { recursive: true, force: true }); });
  const folder = path.join(root, ...Array.from({ length: 8 }, (_, i) => `${i}-${'x'.repeat(40)}`));
  await fs.promises.mkdir(folder, { recursive: true });
  const target = path.join(folder, 'Grüße-文件.txt');
  await fs.promises.writeFile(target, 'UNCHANGED');
  const metadata = factory(); t.after(() => metadata.dispose());
  assert.equal((await metadata.attributes(target, await fs.promises.stat(target))).directory, false);
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'UNCHANGED');
});
