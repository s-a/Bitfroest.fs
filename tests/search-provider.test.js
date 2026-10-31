const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createSearchProvider } = require('../search-provider');

test('search worker streams actual matches, completes and disposes without blocking the caller', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-worker-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'one.txt'), 'needle');
  const provider = createSearchProvider({ roots: [root] }); t.after(() => provider.dispose());
  const progress = []; let yielded = false; setImmediate(() => { yielded = true; });
  const result = await provider.run('one', { name: '*.txt', searchIn: root, depth: -1, textEnabled: true, text: 'needle' }, { onProgress: event => progress.push(event) });
  assert.equal(yielded, true); assert.equal(result.results.length, 1); assert.ok(progress.length);
  assert.equal(provider.results('one')[0].name, 'one.txt');
  provider.release('one'); assert.equal(provider.results('one'), undefined);
});

test('cancelling a worker acknowledges termination, and separate jobs do not share cancellation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-cancel-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'x');
  const provider = createSearchProvider({ roots: [root] }); t.after(() => provider.dispose());
  const first = provider.run('first', { searchIn: root }); const second = provider.run('second', { searchIn: root });
  provider.cancel('first'); assert.equal((await first).cancelled, true); assert.equal((await second).results.length, 1);
  provider.dispose(); await assert.rejects(provider.run('closed', { searchIn: root }), /geschlossen/);
});

test('metadata adapter reads real file attributes and reports missing paths without modifying the file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-attributes-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'probe.txt'); await fs.writeFile(file, 'unchanged');
  const metadata = require('../search-metadata').createSearchMetadata(); t.after(() => metadata.dispose());
  const flags = await metadata.attributes(file, await fs.stat(file)); assert.equal(flags.directory, false); assert.equal(flags.readonly, false);
  if (process.platform === 'win32') await assert.rejects(metadata.attributes(path.join(root, 'missing'), await fs.stat(file)));
  assert.equal(await fs.readFile(file, 'utf8'), 'unchanged');
});

test('search worker applies native readonly and directory filters to actual files', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'search-native-flags-')));
  const readonly = path.join(root, 'readonly.txt');
  t.after(async () => { await fs.chmod(readonly, 0o666); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(readonly, 'READONLY'); await fs.writeFile(path.join(root, 'ordinary.txt'), 'ORDINARY');
  await fs.mkdir(path.join(root, 'folder'));
  await fs.chmod(readonly, 0o444);
  const provider = createSearchProvider({ roots: [root] }); t.after(() => provider.dispose());
  const result = await provider.run('native-attributes', { searchIn: root, attributesEnabled: true, attributes: { readonly: 'yes', directory: 'no' } });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.results.map(row => row.name), ['readonly.txt']);
  assert.equal(result.results[0].flags.readonly, true);
  assert.equal(await fs.readFile(readonly, 'utf8'), 'READONLY');
});
